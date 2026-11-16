import { createBacklogClient, type Revision, type RevisionDetail } from '../api';
import type { FakeBacklogApi } from '../test/fakeBacklogApi';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': status === 200 ? 'application/json' : 'application/problem+json' } });

export function makeRevision(version: number, overrides: Partial<RevisionDetail> = {}): RevisionDetail {
  return {
    id: `r${version}`, itemId: 'i1', version, title: 'Export', origin: 'manual', label: null, actor: 'alice@example.test', runId: null,
    createdAt: new Date(Date.UTC(2026, 0, version, 10)).toISOString(), document: `## Summary\nVersion ${version}`, ...overrides,
  };
}

export const summaryOf = ({ document: _document, ...revision }: RevisionDetail): Revision => revision;

/**
 * Adds the revision routes (list, single, restore with If-Match) on top of the fake backlog-api.
 * `revisions` are newest first; the first one is the item's current version.
 */
export function withRevisions(api: FakeBacklogApi, revisions: RevisionDetail[]) {
  const state = { revisions, conflictOnRestore: false };
  const calls: { path: string; ifMatch: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), 'http://localhost'), init);
    const path = new URL(request.url).pathname.replace(/^\/api\/backlog/, '');
    let m: RegExpExecArray | null;
    if ((m = /^\/projects\/[^/]+\/items\/[^/]+\/revisions$/.exec(path)) && request.method === 'GET') return json({ items: state.revisions.map(summaryOf) });
    if ((m = /^\/projects\/[^/]+\/items\/[^/]+\/revisions\/([^/]+)$/.exec(path)) && request.method === 'GET') {
      const found = state.revisions.find((entry) => entry.id === m![1]);
      return found ? json(found) : json({ type: '/problems/not-found', title: 'not-found', status: 404 }, 404);
    }
    if ((m = /^\/projects\/[^/]+\/items\/([^/]+)\/revisions\/([^/]+)\/restore$/.exec(path)) && request.method === 'POST') {
      calls.push({ path, ifMatch: request.headers.get('If-Match') });
      const item = api.state.items.find((entry) => entry.id === m![1])!;
      if (state.conflictOnRestore) return json({ type: '/problems/version-conflict', title: 'Conflict', status: 409, currentVersion: item.version + 1, changedSections: [], item: { ...item, version: item.version + 1 } }, 409);
      const source = state.revisions.find((entry) => entry.id === m![2])!;
      Object.assign(item, { title: source.title, document: source.document, version: item.version + 1 });
      state.revisions = [makeRevision(item.version, { id: `r${item.version}`, origin: 'restore', title: source.title, document: source.document }), ...state.revisions];
      return json(item);
    }
    return api.fetch(request);
  }) as typeof fetch;
  const client = createBacklogClient({ baseUrl: 'http://localhost/api/backlog', fetch: fetchImpl });
  return { api: { ...api, client } as FakeBacklogApi, state, calls };
}
