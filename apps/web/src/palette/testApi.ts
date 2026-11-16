import { createBacklogClient } from '../api';
import type { FakeBacklogApi } from '../test/fakeBacklogApi';

type Entry = { content: string; source: 'default' | 'project'; defaultVersion: string; version: number };
const entry = (overrides: Partial<Entry> = {}) => ({
  kind: 'template', itemType: null, content: '# T', source: 'default', defaultSkill: 's', defaultVersion: '1.2', baseSkillVersion: null, differsFromDefault: false, outdated: false, version: 0, updatedBy: null, updatedAt: null, ...overrides,
});

export interface TestExtras {
  /** Item types with a project template override. */
  projectTemplates?: string[];
  semanticItems?: { itemId: string; title: string; type: string; status: string; score: number; snippet: string | null }[];
  pinnedBudget?: { used: number; limit: number };
  searchCalls?: string[];
}

/** Adds the `guidance`, `search` and budget routes (missing from the shared fake) on top of a fake backlog-api. */
export function withExtras(api: FakeBacklogApi, extras: TestExtras = {}): FakeBacklogApi {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const types = ['capability', 'feature', 'user-story', 'enabler'];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), 'http://localhost'), init);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/backlog/, '');
    if (/\/guidance$/.test(path)) {
      const templates = Object.fromEntries(types.map((type) => [type, entry(extras.projectTemplates?.includes(type) ? { source: 'project', version: 2 } : {})]));
      return json({ principles: entry(), typeInstructions: {}, templates, documentFormat: '', skills: {} });
    }
    if (/\/search$/.test(path)) {
      extras.searchCalls?.push(url.search);
      return json({ kind: 'items', query: url.searchParams.get('q'), semantic: true, items: extras.semanticItems ?? [] });
    }
    if (/\/sources$/.test(path) && request.method === 'GET' && extras.pinnedBudget) {
      const base = await api.fetch(request);
      const body = await base.json();
      return json({ ...body, pinnedBudget: extras.pinnedBudget });
    }
    return api.fetch(request);
  }) as typeof fetch;
  return { ...api, client: createBacklogClient({ baseUrl: 'http://localhost/api/backlog', fetch: fetchImpl }) };
}
