import { llmApiUrl } from './apiUrl';
import { logError } from '../logging';

export interface LlmConfiguration {
  endpoint: string;
  model: string;
  apiKey: string;
  streaming?: boolean;
  timeoutMs?: number;
}

export interface LlmCompletionRequest {
  system: string;
  prompt: string;
  signal?: AbortSignal;
  temperature?: number;
  structured?: boolean;
}

export interface LlmProvider {
  generate(request: LlmCompletionRequest): Promise<string>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }> | null;
    };
  }>;
  error?: { message?: string };
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | Array<{ text?: string }> | null;
    };
  }>;
  error?: { message?: string };
}

async function readStream(response: Response): Promise<string> {
  if (!response.body) {
    throw new LlmProviderError('The LLM proxy returned no response stream.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';

  const processEvents = (final = false) => {
    const parts = buffer.split(/\r?\n\r?\n/);
    const events = final ? parts : parts.slice(0, -1);
    buffer = final ? '' : parts.at(-1) ?? '';
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;

      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(data) as ChatCompletionChunk;
      } catch (cause) {
        throw new LlmProviderError('The LLM proxy returned an invalid streaming event.', { cause });
      }
      if (chunk.error?.message) {
        throw new LlmProviderError(`The LLM proxy reported an error: ${chunk.error.message}`);
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') content += delta;
      else if (Array.isArray(delta)) content += delta.map((part) => part.text ?? '').join('');
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      processEvents(done);
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  if (!content.trim()) {
    throw new LlmProviderError('The LLM proxy returned no message content in its stream.');
  }
  return content;
}

export class LlmProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LlmProviderError';
  }
}

export class ProxyLlmProvider implements LlmProvider {
  constructor(
    private readonly configuration: LlmConfiguration,
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async generate(request: LlmCompletionRequest): Promise<string> {
    const { endpoint, model, apiKey, streaming = false, timeoutMs = 60_000 } = this.configuration;
    if (!endpoint.trim() || !model.trim()) {
      throw new LlmProviderError('Set the LLM endpoint and model in Settings (or config.json) before using AI refinement.');
    }

    let parsedEndpoint: URL;
    try {
      parsedEndpoint = llmApiUrl(endpoint, 'chat/completions');
    } catch (cause) {
      throw new LlmProviderError('The LLM endpoint must be an HTTP(S) URL or a same-origin path such as /api.', { cause });
    }
    if (parsedEndpoint.protocol !== 'https:' && parsedEndpoint.protocol !== 'http:') {
      throw new LlmProviderError('The proxy endpoint must use HTTP or HTTPS.');
    }

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await this.fetcher(parsedEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(streaming ? { accept: 'text/event-stream' } : {}),
          ...(apiKey.trim() ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        credentials: 'omit',
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          ...(streaming ? { stream: true } : {}),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.structured ? { response_format: { type: 'json_object' } } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logError('LLM proxy returned an error response', undefined, {
          endpoint, model, status: response.status, statusText: response.statusText, body: body.slice(0, 2000),
        });
        throw new LlmProviderError(`The LLM proxy returned HTTP ${response.status}.`);
      }

      if (streaming) return await readStream(response);

      let result: ChatCompletionResponse;
      try {
        result = (await response.json()) as ChatCompletionResponse;
      } catch (cause) {
        throw new LlmProviderError('The LLM proxy returned invalid JSON.', { cause });
      }

      const content = result.choices?.[0]?.message?.content;
      const text = Array.isArray(content)
        ? content.map((part) => part.text ?? '').join('')
        : content;
      if (typeof text !== 'string' || !text.trim()) {
        throw new LlmProviderError(result.error?.message ?? 'The LLM proxy returned no message content.');
      }
      return text;
    } catch (cause) {
      if (cause instanceof LlmProviderError) {
        logError(cause.message, cause.cause ?? cause, { endpoint, model });
        throw cause;
      }
      if (timedOut) {
        logError('LLM proxy request timed out', cause, { endpoint, model, timeoutMs });
        throw new LlmProviderError('The LLM proxy request timed out.', { cause });
      }
      if (request.signal?.aborted) throw new LlmProviderError('The LLM proxy request was cancelled.', { cause });
      logError('Could not reach the LLM proxy (network, CORS, or TLS problem)', cause, { endpoint, requestUrl: parsedEndpoint.href, model });
      throw new LlmProviderError(`Could not reach the LLM proxy at ${parsedEndpoint.href} (network, CORS, or TLS problem; see the browser console).`, { cause });
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }
}
