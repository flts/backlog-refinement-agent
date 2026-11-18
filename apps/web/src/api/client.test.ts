import { describe, expect, it, vi } from 'vitest';
import { createAuthFetch } from '../auth';
import { createBacklogClient, ifMatch, readEtag, requestOk, unwrap } from './client';
import { ApiError, ConflictError, PreconditionRequiredError, isVersionConflict, toApiError } from './errors';

const problem = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify({ status, ...body }), { status, headers: { 'Content-Type': 'application/problem+json' } });

describe('problem+json error mapping', () => {
  it('maps type, title, detail and extension members', () => {
    const error = toApiError(403, { type: '/problems/owner-required', title: 'Forbidden', status: 403, detail: 'Only owners can do this.', instance: '/x', extra: 1 });
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ status: 403, type: '/problems/owner-required', slug: 'owner-required', title: 'Forbidden', detail: 'Only owners can do this.', message: 'Only owners can do this.', extensions: { extra: 1 } });
  });

  it('maps 409 to ConflictError with currentVersion, changedSections and the current item', () => {
    const item = { id: 'i1', version: 8 };
    const error = toApiError(409, { type: '/problems/version-conflict', title: 'Conflict', currentVersion: 8, changedSections: ['Summary', 'Scope'], item });
    expect(error).toBeInstanceOf(ConflictError);
    const conflict = error as ConflictError;
    expect(conflict.currentVersion).toBe(8);
    expect(conflict.changedSections).toEqual(['Summary', 'Scope']);
    expect(conflict.item).toEqual(item);
    expect(isVersionConflict(conflict)).toBe(true);
  });

  it('does not treat other 409s (for example duplicate members) as version conflicts', () => {
    const error = toApiError(409, { type: '/problems/last-owner', title: 'Conflict' });
    expect(error).toBeInstanceOf(ConflictError);
    expect(isVersionConflict(error)).toBe(false);
  });

  it('maps 428 to PreconditionRequiredError', () => {
    expect(toApiError(428, { type: '/problems/precondition-required', title: 'Precondition Required' })).toBeInstanceOf(PreconditionRequiredError);
  });

  it('copes with bodies that are not problem documents', () => {
    expect(toApiError(502, 'Bad gateway')).toMatchObject({ status: 502, type: 'about:blank', detail: 'Bad gateway' });
    expect(toApiError(500, undefined).message).toBe('Request failed (HTTP 500)');
  });
});

describe('createBacklogClient', () => {
  it('sends If-Match for a known version and exposes the ETag of the response', async () => {
    const seen: Request[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(input instanceof Request ? input : new Request(String(input), init));
      return new Response(JSON.stringify({ id: 'i1', version: 8 }), { status: 200, headers: { 'Content-Type': 'application/json', ETag: '"8"' } });
    }) as unknown as typeof fetch;
    const client = createBacklogClient({ baseUrl: 'http://api.test/api/backlog/', fetch: fetchImpl });
    const result = await client.http.PATCH('/projects/{project_id}/items/{item_id}', {
      params: { path: { project_id: 'p1', item_id: 'i1' }, header: { 'If-Match': ifMatch(7) } }, body: { title: 'New' },
    });
    expect(seen[0].url).toBe('http://api.test/api/backlog/projects/p1/items/i1');
    expect(seen[0].method).toBe('PATCH');
    expect(seen[0].headers.get('If-Match')).toBe('"7"');
    expect(readEtag(result.response)).toBe(8);
  });

  it('adds the bearer token through the auth fetch and reports 401 to the provider', async () => {
    const onUnauthorized = vi.fn();
    const provider = { getAccessToken: async () => 'tok', onUnauthorized, user: null, signOut: async () => undefined };
    const seen: Headers[] = [];
    const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { seen.push(new Headers(init?.headers ?? (input as Request).headers)); return problem(401, { type: '/problems/unauthorized', title: 'Unauthorized' }); }) as unknown as typeof fetch;
    const client = createBacklogClient({ baseUrl: '/api/backlog', fetch: createAuthFetch(provider, base) });
    await expect(unwrap(client.http.GET('/me'))).rejects.toMatchObject({ status: 401 });
    expect(seen[0].get('Authorization')).toBe('Bearer tok');
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('unwrap throws a ConflictError for 409 and PreconditionRequiredError for 428', async () => {
    const answer = (response: Response) => createBacklogClient({ baseUrl: '/api/backlog', fetch: (async () => response.clone()) as unknown as typeof fetch });
    const conflict = answer(problem(409, { type: '/problems/version-conflict', title: 'Conflict', currentVersion: 3, changedSections: ['A'], item: { id: 'i1' } }));
    await expect(unwrap(conflict.http.GET('/me'))).rejects.toMatchObject({ name: 'ConflictError', currentVersion: 3, changedSections: ['A'] });
    const missing = answer(problem(428, { type: '/problems/precondition-required', title: 'Precondition Required' }));
    await expect(unwrap(missing.http.GET('/me'))).rejects.toBeInstanceOf(PreconditionRequiredError);
  });

  it('maps network failures to an ApiError with status 0', async () => {
    const client = createBacklogClient({ baseUrl: '/api/backlog', fetch: (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch });
    await expect(unwrap(client.http.GET('/me'))).rejects.toMatchObject({ name: 'ApiError', status: 0 });
    await expect(requestOk(client, '/anything')).rejects.toMatchObject({ status: 0 });
  });

  it('requestOk sends plain requests relative to the base URL and maps failures', async () => {
    const fetchImpl = vi.fn(async () => problem(404, { type: '/problems/not-found', title: 'Not Found' })) as unknown as typeof fetch;
    const client = createBacklogClient({ baseUrl: '/api/backlog', fetch: fetchImpl });
    await expect(requestOk(client, '/projects/p1/backup')).rejects.toMatchObject({ status: 404, slug: 'not-found' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/backlog/projects/p1/backup', undefined);
  });
});

describe('ETag helpers', () => {
  it.each([['"7"', 7], ['W/"7"', 7], ['7', 7], ['"sha256-abc"', undefined], ['', undefined]])('reads %s', (header, expected) => {
    expect(readEtag({ headers: new Headers(header ? { ETag: header } : {}) })).toBe(expected);
  });

  it('quotes versions for If-Match', () => expect(ifMatch(12)).toBe('"12"'));
});
