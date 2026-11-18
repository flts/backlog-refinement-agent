import type { Item, ItemSummary, Member, Project, Relationship, Source } from '../api';
import { createBacklogClient, type BacklogClient } from '../api';

export interface RecordedCall { method: string; path: string; headers: Headers; body?: unknown }

const stamp = '2026-01-01T00:00:00Z';
const problem = (status: number, slug: string, extra: Record<string, unknown> = {}, title = slug) =>
  new Response(JSON.stringify({ type: `/problems/${slug}`, title, status, ...extra }), { status, headers: { 'Content-Type': 'application/problem+json' } });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export function makeProject(overrides: Partial<Project> = {}): Project {
  return { id: 'p1', name: 'Alpha', version: 1, role: 'owner', createdBy: 'alice@example.test', createdAt: stamp, updatedAt: stamp, ...overrides };
}

export function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'i1', projectId: 'p1', parentId: null, type: 'feature', title: 'Export', document: '## Summary\nOld', status: 'draft', version: 1, documentHash: 'h1', quality: null,
    createdBy: 'alice@example.test', updatedBy: 'alice@example.test', createdAt: stamp, updatedAt: stamp, ...overrides,
  };
}

export function makeMember(overrides: Partial<Member> = {}): Member {
  return { email: 'alice@example.test', role: 'owner', name: 'Alice Owner', signedIn: true, addedBy: 'alice@example.test', addedAt: stamp, ...overrides };
}

export function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 's1', projectId: 'p1', name: 'Spec', kind: 'url', mode: 'searchable', url: 'https://example.com/spec', charCount: 12, pageCount: null, mediaType: null, hasFile: false,
    indexStatus: 'indexed', indexError: null, version: 1, addedBy: 'alice@example.test', createdAt: stamp, updatedAt: stamp, ...overrides,
  };
}

const summary = (item: Item): ItemSummary => ({
  id: item.id, parentId: item.parentId, type: item.type, title: item.title, status: item.status, version: item.version, quality: null, updatedAt: item.updatedAt, updatedBy: item.updatedBy,
});

/** In-memory stand-in for backlog-api: just enough routes and concurrency rules for the SPA tests (no MSW needed). */
export function createFakeBacklogApi(seed: { projects?: Project[]; items?: Item[]; sources?: Source[]; relationships?: Relationship[]; members?: Member[] } = {}) {
  const state = {
    projects: [...(seed.projects ?? [])], items: [...(seed.items ?? [])], sources: [...(seed.sources ?? [])], relationships: [...(seed.relationships ?? [])],
    /** The next item PATCH answers 409 as if somebody else saved first (`item` is the current server item). */
    conflictOnNextItemPatch: undefined as undefined | { item: Item; changedSections?: string[] },
    members: [...(seed.members ?? [])],
    failNext: undefined as undefined | Response,
    presence: [] as { email: string; name?: string | null; itemId?: string | null; state: string }[],
    nextId: 1,
  };
  const calls: RecordedCall[] = [];
  const ids = (prefix: string) => `${prefix}${++state.nextId}`;

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname.replace(/^\/api\/backlog/, '');
    const method = request.method;
    const contentType = request.headers.get('Content-Type') ?? '';
    let body: unknown;
    if (contentType.includes('application/json')) body = await request.clone().json();
    else if (contentType.includes('multipart/form-data')) body = Object.fromEntries((await request.clone().formData()).entries());
    calls.push({ method, path, headers: request.headers, body });
    if (state.failNext) { const response = state.failNext; state.failNext = undefined; return response; }

    const ifMatch = request.headers.get('If-Match');
    const versionOf = (value: string | null) => value === null ? null : Number(value.replace(/^W\/|"/g, ''));
    let m: RegExpExecArray | null;

    if (path === '/me' && method === 'GET') return json({ email: 'alice@example.test', name: 'Alice Owner', sub: 'alice' });
    if (path === '/projects' && method === 'GET') return json({ items: state.projects });
    if (path === '/projects' && method === 'POST') {
      const project = makeProject({ id: ids('p'), name: (body as { name: string }).name });
      state.projects.push(project);
      return json(project, 201, { ETag: '"1"' });
    }
    if (path === '/projects/import' && method === 'POST') {
      const project = makeProject({ id: ids('p'), name: 'Imported' });
      state.projects.push(project);
      return json({ project, counts: { items: 0, revisions: 0, relationships: 0, sources: 0, files: 0, guidanceOverrides: 0 } }, 201);
    }
    if ((m = /^\/projects\/([^/]+)$/.exec(path))) {
      const project = state.projects.find((entry) => entry.id === m![1]);
      if (!project) return problem(404, 'not-found');
      if (method === 'GET') return json(project, 200, { ETag: `"${project.version}"` });
      if (project.role !== 'owner') return problem(403, 'owner-required');
      if (method === 'PATCH' || method === 'DELETE') {
        if (method === 'PATCH' && ifMatch === null) return problem(428, 'precondition-required');
        if (ifMatch !== null && versionOf(ifMatch) !== project.version) return problem(409, 'version-conflict', { currentVersion: project.version });
        if (method === 'DELETE') {
          state.projects = state.projects.filter((entry) => entry !== project);
          return new Response(null, { status: 204 });
        }
        Object.assign(project, { name: (body as { name: string }).name, version: project.version + 1 });
        return json(project, 200, { ETag: `"${project.version}"` });
      }
    }
    if (/^\/projects\/[^/]+\/presence$/.test(path)) return method === 'DELETE' ? new Response(null, { status: 204 }) : json({ users: state.presence });
    if (/^\/projects\/[^/]+\/events$/.test(path) && method === 'GET') {
      // An idle stream that ends when the client aborts.
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('retry: 3000\n: connected\n\n'));
          request.signal.addEventListener('abort', () => { try { controller.close(); } catch { /* already closed */ } });
        },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if ((m = /^\/projects\/([^/]+)\/members(?:\/([^/]+))?$/.exec(path))) {
      const target = m[2] ? decodeURIComponent(m[2]) : undefined;
      const owners = () => state.members.filter((member) => member.role === 'owner');
      if (!target && method === 'GET') return json({ items: state.members });
      if (!target && method === 'POST') {
        const input = body as { email: string; role: Member['role'] };
        if (state.members.some((member) => member.email === input.email)) return problem(409, 'already-member');
        const member: Member = { email: input.email, role: input.role, name: null, signedIn: false, addedBy: 'alice@example.test', addedAt: stamp };
        state.members.push(member);
        return json(member, 201);
      }
      const member = state.members.find((entry) => entry.email === target);
      if (!member) return problem(404, 'member-not-found');
      if (method === 'PATCH') {
        const role = (body as { role: Member['role'] }).role;
        if (member.role === 'owner' && role !== 'owner' && owners().length <= 1) return problem(409, 'last-owner');
        member.role = role;
        return json(member);
      }
      if (method === 'DELETE') {
        if (member.role === 'owner' && owners().length <= 1) return problem(409, 'last-owner');
        state.members = state.members.filter((entry) => entry !== member);
        return new Response(null, { status: 204 });
      }
    }
    if ((m = /^\/projects\/([^/]+)\/backup$/.exec(path)) && method === 'GET') return json({ format: 'backlog-project-backup', formatVersion: 2, project: { id: m[1] } });
    if ((m = /^\/projects\/([^/]+)\/items$/.exec(path))) {
      if (method === 'GET') return json({ items: state.items.filter((item) => item.projectId === m![1]).map(summary) });
      if (method === 'POST') {
        const input = body as { type: Item['type']; title?: string | null; parentId?: string | null };
        const item = makeItem({ id: ids('i'), projectId: m[1], type: input.type, title: input.title || `Untitled ${input.type}`, document: `# ${input.type} template`, parentId: input.parentId ?? null });
        state.items.push(item);
        return json(item, 201, { ETag: '"1"' });
      }
    }
    if ((m = /^\/projects\/([^/]+)\/items\/([^/]+)$/.exec(path))) {
      const item = state.items.find((entry) => entry.id === m![2]);
      if (!item) return problem(404, 'not-found');
      if (method === 'GET') return json(item, 200, { ETag: `"${item.version}"` });
      if (method === 'DELETE') { state.items = state.items.filter((entry) => entry !== item); return new Response(null, { status: 204 }); }
      if (method === 'PATCH') {
        if (ifMatch === null) return problem(428, 'precondition-required');
        const conflict = state.conflictOnNextItemPatch;
        if (conflict) {
          state.conflictOnNextItemPatch = undefined;
          Object.assign(item, conflict.item);
          return problem(409, 'version-conflict', { currentVersion: item.version, changedSections: conflict.changedSections ?? ['Summary'], item }, 'Conflict');
        }
        if (versionOf(ifMatch) !== item.version) return problem(409, 'version-conflict', { currentVersion: item.version, changedSections: [], item });
        const changes = body as { title?: string | null; document?: string | null; status?: Item['status'] | null };
        Object.assign(item, { ...(changes.title ? { title: changes.title } : {}), ...(changes.document != null ? { document: changes.document } : {}), ...(changes.status ? { status: changes.status } : {}), version: item.version + 1 });
        return json(item, 200, { ETag: `"${item.version}"` });
      }
    }
    if ((m = /^\/projects\/([^/]+)\/items\/([^/]+)\/revisions$/.exec(path)) && method === 'GET') return json({ items: [] });
    if ((m = /^\/projects\/([^/]+)\/relationships$/.exec(path)) && method === 'GET') return json({ items: state.relationships });
    if ((m = /^\/projects\/([^/]+)\/sources$/.exec(path))) {
      if (method === 'GET') return json({ items: state.sources.filter((source) => source.projectId === m![1]), pinnedBudget: { used: 0, limit: 100000 } });
      if (method === 'POST') {
        const input = body as { name?: string; url?: string; file?: File; mode?: Source['mode'] };
        const source = makeSource({ id: ids('s'), projectId: m[1], name: input.name || (input.file as File | undefined)?.name || 'Source', kind: input.file ? 'file' : 'url', url: input.url ?? null, mode: input.mode ?? 'searchable' });
        state.sources.push(source);
        return json(source, 201);
      }
    }
    if ((m = /^\/projects\/([^/]+)\/sources\/([^/]+)\/file$/.exec(path)) && method === 'GET') {
      const source = state.sources.find((entry) => entry.id === m![2]);
      return source?.hasFile ? new Response(`original of ${source.name}`, { headers: { 'Content-Type': 'application/octet-stream' } }) : problem(404, 'not-found');
    }
    if ((m = /^\/projects\/([^/]+)\/sources\/([^/]+)\/reindex$/.exec(path)) && method === 'POST') {
      const source = state.sources.find((entry) => entry.id === m![2]);
      if (!source) return problem(404, 'not-found');
      source.indexStatus = 'pending'; source.indexError = null;
      return json({}, 202);
    }
    if ((m = /^\/projects\/([^/]+)\/sources\/([^/]+)$/.exec(path))) {
      const source = state.sources.find((entry) => entry.id === m![2]);
      if (!source) return problem(404, 'not-found');
      if (method === 'PATCH') {
        if (ifMatch === null) return problem(428, 'precondition-required');
        if (versionOf(ifMatch) !== source.version) return problem(409, 'version-conflict', { currentVersion: source.version });
        Object.assign(source, body as object, { version: source.version + 1 });
        return json(source);
      }
      if (method === 'DELETE') { state.sources = state.sources.filter((entry) => entry !== source); return new Response(null, { status: 204 }); }
    }
    return problem(404, 'not-found', {}, `${method} ${path} is not implemented by the fake`);
  }

  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => handle(input instanceof Request ? input : new Request(new URL(String(input), 'http://localhost'), init))) as typeof fetch;
  const client: BacklogClient = createBacklogClient({ baseUrl: 'http://localhost/api/backlog', fetch: fetchImpl });
  return { client, state, calls, fetch: fetchImpl, callsTo: (method: string, pattern: RegExp) => calls.filter((call) => call.method === method && pattern.test(call.path)) };
}

export type FakeBacklogApi = ReturnType<typeof createFakeBacklogApi>;
