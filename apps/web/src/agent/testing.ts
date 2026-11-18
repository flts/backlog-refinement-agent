import type { TokenProvider } from '../auth';

/** SSE body of raw AG-UI events, as the agent-service streams them (`data: <json>` frames plus a keepalive comment). */
export function sseBody(events: readonly unknown[]): string {
  return `: keepalive\n\n${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}`;
}

export function sseResponse(events: readonly unknown[], init: ResponseInit = {}): Response {
  return new Response(sseBody(events), { status: 200, headers: { 'Content-Type': 'text/event-stream' }, ...init });
}

export function problemResponse(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ title: 'problem', status, ...body }), { status, headers: { 'Content-Type': 'application/problem+json', ...headers } });
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** A fake `fetch` that records requests and answers from a queue (or a function). */
export function fakeFetch(answer: Response[] | ((request: RecordedRequest, index: number) => Response | Promise<Response>)) {
  const requests: RecordedRequest[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const text = typeof init?.body === 'string' ? init.body : undefined;
    const recorded: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: text ? JSON.parse(text) : undefined,
    };
    requests.push(recorded);
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const response = typeof answer === 'function' ? await answer(recorded, requests.length - 1) : answer.shift()!;
    return response;
  }) as typeof fetch;
  return { fetch: fn, requests };
}

export function fakeTokens(tokens: (string | null)[] | string | null = 'token-1'): TokenProvider & { unauthorized: number } {
  const queue = Array.isArray(tokens) ? [...tokens] : null;
  const provider = {
    unauthorized: 0,
    user: null,
    getAccessToken: async () => (queue ? (queue.length > 1 ? queue.shift()! : queue[0]) : tokens as string | null),
    onUnauthorized() {
      provider.unauthorized += 1;
    },
    signOut: async () => undefined,
  };
  return provider;
}
