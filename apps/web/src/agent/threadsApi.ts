import { z } from 'zod';
import type { TokenProvider } from '../auth';
import { createAuthFetch } from '../auth';
import { AgentApiError, agentErrorFromHttp, agentErrorFromNetwork } from './errors';

export const ThreadStatusSchema = z.enum(['idle', 'running', 'awaiting_input', 'awaiting_review']);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const ThreadSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().nullable(),
  status: ThreadStatusSchema,
  projectId: z.string().min(1),
  itemId: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const ThreadListSchema = z.looseObject({ items: z.array(ThreadSchema) });

export const FeedbackRatingSchema = z.enum(['up', 'down']);
export type FeedbackRating = z.infer<typeof FeedbackRatingSchema>;

export const FeedbackSchema = z.looseObject({
  threadId: z.string(),
  messageId: z.string(),
  rating: FeedbackRatingSchema,
  comment: z.string().nullable(),
});
export type Feedback = z.infer<typeof FeedbackSchema>;

export interface ThreadsApi {
  list(query?: { projectId?: string; itemId?: string }, signal?: AbortSignal): Promise<Thread[]>;
  create(input: { projectId: string; itemId: string; title?: string }, signal?: AbortSignal): Promise<Thread>;
  rename(threadId: string, title: string, signal?: AbortSignal): Promise<Thread>;
  remove(threadId: string, signal?: AbortSignal): Promise<void>;
  feedback(input: { threadId: string; messageId: string; rating: FeedbackRating; comment?: string }, signal?: AbortSignal): Promise<Feedback>;
}

export interface ThreadsApiOptions {
  /** `api.agent` of the runtime config (for example `/api/agent`). */
  baseUrl: string;
  tokenProvider: TokenProvider;
  fetch?: typeof fetch;
}

/** REST client of the agent-service threads and feedback endpoints. Errors are thrown as `AgentApiError`. */
export function createThreadsApi({ baseUrl, tokenProvider, fetch: baseFetch }: ThreadsApiOptions): ThreadsApi {
  const base = baseUrl.replace(/\/+$/, '');
  const authFetch = createAuthFetch(tokenProvider, baseFetch);

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json, application/problem+json');
    if (init.body) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await authFetch(`${base}${path}`, { ...init, headers });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') throw cause;
      throw new AgentApiError(agentErrorFromNetwork(cause), { cause });
    }
    if (response.ok) return response;
    let payload: unknown;
    const text = await response.text().catch(() => '');
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = text || undefined;
    }
    throw new AgentApiError(agentErrorFromHttp({ status: response.status, payload, retryAfter: response.headers.get('Retry-After') }));
  }

  async function json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new AgentApiError({ ...agentErrorFromHttp({ status: 500 }), source: 'http', serverMessage: `Unexpected response: ${parsed.error.message}` });
    }
    return parsed.data;
  }

  const body = (value: unknown) => JSON.stringify(value);

  return {
    async list(query = {}, signal) {
      const params = new URLSearchParams();
      if (query.projectId) params.set('projectId', query.projectId);
      if (query.itemId) params.set('itemId', query.itemId);
      const suffix = params.size > 0 ? `?${params}` : '';
      return (await json(await request(`/threads${suffix}`, { signal }), ThreadListSchema)).items;
    },
    async create(input, signal) {
      return json(await request('/threads', { method: 'POST', body: body(input), signal }), ThreadSchema);
    },
    async rename(threadId, title, signal) {
      return json(await request(`/threads/${encodeURIComponent(threadId)}`, { method: 'PATCH', body: body({ title }), signal }), ThreadSchema);
    },
    async remove(threadId, signal) {
      await request(`/threads/${encodeURIComponent(threadId)}`, { method: 'DELETE', signal });
    },
    async feedback(input, signal) {
      return json(await request('/feedback', { method: 'POST', body: body(input), signal }), FeedbackSchema);
    },
  };
}
