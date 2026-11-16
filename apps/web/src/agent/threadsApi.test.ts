import { describe, expect, it } from 'vitest';
import { AgentApiError } from './errors';
import { fakeFetch, fakeTokens, problemResponse } from './testing';
import { createThreadsApi } from './threadsApi';

const thread = { id: 't1', title: null, status: 'idle', projectId: 'p1', itemId: 'i1', createdAt: '2026-11-16T10:00:00Z', updatedAt: '2026-11-16T10:00:00Z' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setup(responses: Response[]) {
  const http = fakeFetch(responses);
  const tokens = fakeTokens();
  return { api: createThreadsApi({ baseUrl: '/api/agent/', tokenProvider: tokens, fetch: http.fetch }), http, tokens };
}

describe('ThreadsApi', () => {
  it('lists threads with the projectId/itemId query and a bearer token', async () => {
    const { api, http } = setup([json({ items: [thread] })]);
    expect(await api.list({ projectId: 'p1', itemId: 'i1' })).toEqual([thread]);
    expect(http.requests[0]).toMatchObject({ method: 'GET', url: '/api/agent/threads?projectId=p1&itemId=i1' });
    expect(http.requests[0].headers.get('authorization')).toBe('Bearer token-1');
  });

  it('lists without a query', async () => {
    const { api, http } = setup([json({ items: [] })]);
    await api.list();
    expect(http.requests[0].url).toBe('/api/agent/threads');
  });

  it('creates, renames and deletes threads and posts feedback', async () => {
    const { api, http } = setup([json(thread, 201), json({ ...thread, title: 'New' }), new Response(null, { status: 204 }), json({ threadId: 't1', messageId: 'm1', rating: 'up', comment: null })]);
    await api.create({ projectId: 'p1', itemId: 'i1', title: 'Hi' });
    await api.rename('t1', 'New');
    await api.remove('t1');
    const feedback = await api.feedback({ threadId: 't1', messageId: 'm1', rating: 'up' });
    expect(feedback.rating).toBe('up');
    expect(http.requests.map((r) => [r.method, r.url, r.body])).toEqual([
      ['POST', '/api/agent/threads', { projectId: 'p1', itemId: 'i1', title: 'Hi' }],
      ['PATCH', '/api/agent/threads/t1', { title: 'New' }],
      ['DELETE', '/api/agent/threads/t1', undefined],
      ['POST', '/api/agent/feedback', { threadId: 't1', messageId: 'm1', rating: 'up' }],
    ]);
    expect(http.requests[0].headers.get('content-type')).toBe('application/json');
  });

  it('maps problem responses (404, 409, 429, 401) to AgentApiError and notifies the provider on 401', async () => {
    const { api, tokens } = setup([
      problemResponse(404, { type: '/problems/thread-not-found', detail: 'The thread was not found.' }),
      problemResponse(409, { type: '/problems/thread-busy' }),
      problemResponse(429, {}, { 'Retry-After': '3' }),
      problemResponse(401, {}),
    ]);
    await expect(api.rename('x', 'y')).rejects.toMatchObject({ error: { code: 'NOT_FOUND', status: 404, serverMessage: 'The thread was not found.' } });
    await expect(api.remove('x')).rejects.toMatchObject({ error: { code: 'THREAD_BUSY' } });
    await expect(api.list()).rejects.toMatchObject({ error: { code: 'RATE_LIMITED', retryAfterSeconds: 3 } });
    await expect(api.list()).rejects.toBeInstanceOf(AgentApiError);
    expect(tokens.unauthorized).toBe(1);
  });

  it('maps network errors and rejects malformed responses', async () => {
    const down = createThreadsApi({ baseUrl: '/api/agent', tokenProvider: fakeTokens(), fetch: (async () => { throw new TypeError('offline'); }) as typeof fetch });
    await expect(down.list()).rejects.toMatchObject({ error: { key: 'network' } });
    const { api } = setup([json({ items: [{ id: 1 }] })]);
    await expect(api.list()).rejects.toBeInstanceOf(AgentApiError);
  });
});
