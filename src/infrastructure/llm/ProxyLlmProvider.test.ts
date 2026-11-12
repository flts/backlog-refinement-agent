import { describe, expect, it, vi } from 'vitest';
import { LlmProviderError, ProxyLlmProvider } from './ProxyLlmProvider';

describe('ProxyLlmProvider', () => {
  it('sends an authenticated OpenAI-compatible completion when a local development key is set', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"status":"ready"}' } }] })),
    );
    const provider = new ProxyLlmProvider(
      { endpoint: 'https://proxy.example', model: 'team-model', apiKey: 'test-proxy-key' },
      fetcher,
    );

    const result = await provider.generate({
      system: 'Return JSON.',
      prompt: 'Assess this item.',
      structured: true,
    });

    expect(result).toBe('{"status":"ready"}');
    expect(fetcher).toHaveBeenCalledWith(
      new URL('https://proxy.example/v1/chat/completions'),
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${'test-proxy-key'}`,
        },
        body: JSON.stringify({
          model: 'team-model',
          messages: [
            { role: 'system', content: 'Return JSON.' },
            { role: 'user', content: 'Assess this item.' },
          ],
          response_format: { type: 'json_object' },
        }),
      }),
    );
  });

  it('requires only endpoint and model, allowing production endpoints without browser credentials', async () => {
    const provider = new ProxyLlmProvider({ endpoint: '', model: '', apiKey: '' }, vi.fn<typeof fetch>());

    await expect(provider.generate({ system: '', prompt: '' })).rejects.toThrow('config.json');
  });

  it('does not send an authorization header when no local development key is configured', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })),
    );
    const provider = new ProxyLlmProvider(
      { endpoint: 'https://proxy.example', model: 'team-model', apiKey: '' },
      fetcher,
    );

    await provider.generate({ system: '', prompt: '' });

    const [, options] = fetcher.mock.calls[0];
    expect(options?.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('requests SSE streaming and assembles streamed content chunks', async () => {
    const content = '{"kind":"assessment","summary":"Ready"}';
    const events = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, 20) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(20) } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const provider = new ProxyLlmProvider(
      { endpoint: 'https://proxy.example', model: 'team-model', apiKey: '', streaming: true },
      fetcher,
    );

    await expect(provider.generate({ system: 'Return JSON.', prompt: 'Assess this item.', structured: true }))
      .resolves.toBe(content);

    const [, options] = fetcher.mock.calls[0];
    expect(options?.headers).toEqual({
      'content-type': 'application/json',
      accept: 'text/event-stream',
    });
    expect(JSON.parse(String(options?.body))).toMatchObject({ model: 'team-model', stream: true });
  });

  it('reports proxy HTTP errors without exposing response content', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive proxy detail', { status: 502 }));
    const provider = new ProxyLlmProvider(
      { endpoint: 'https://proxy.example', model: 'team-model', apiKey: 'test-proxy-key' },
      fetcher,
    );

    await expect(provider.generate({ system: '', prompt: '' })).rejects.toThrow('HTTP 502');
  });
  it('logs failures to the browser console with endpoint details', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    const provider = new ProxyLlmProvider(
      { endpoint: 'https://proxy.example', model: 'team-model', apiKey: '' },
      fetcher,
    );

    await expect(provider.generate({ system: '', prompt: '' })).rejects.toThrow('Could not reach');
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('Could not reach the LLM proxy'),
      expect.any(TypeError),
      expect.objectContaining({ endpoint: 'https://proxy.example' }),
    );
    spy.mockRestore();
  });

  it.each([
    ['default', undefined, 180_000],
    ['override', 2_000, 2_000],
  ])('times out at the %s deadline', async (_label, timeoutMs, deadline) => {
    vi.useFakeTimers();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
      const provider = new ProxyLlmProvider({ endpoint: 'https://proxy.example', model: 'model', apiKey: '', timeoutMs }, fetcher);
      const result = provider.generate({ system: '', prompt: '' });
      const assertion = expect(result).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('preserves caller cancellation', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const provider = new ProxyLlmProvider({ endpoint: 'https://proxy.example', model: 'model', apiKey: '' }, fetcher);
    const result = provider.generate({ system: '', prompt: '', signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow('cancelled');
  });
});
