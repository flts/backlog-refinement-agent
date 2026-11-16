import { createBacklogClient, type DefaultGuidance, type EffectiveGuidance, type GuidanceEntry, type Member } from '../api';
import { createFakeBacklogApi, type FakeBacklogApi } from '../test/fakeBacklogApi';

const types = ['capability', 'feature', 'user-story', 'enabler'] as const;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const problem = (status: number, slug: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ type: `/problems/${slug}`, title: slug, status, ...extra }), { status, headers: { 'Content-Type': 'application/problem+json' } });

type Override = { content: string; version: number; baseSkillVersion: string };

/** Test double for the guidance endpoints on top of the shared fake: overrides keyed `principles` | `template:feature` | `type-instructions:feature`. */
export function createFakeGuidanceApi(seed: Parameters<typeof createFakeBacklogApi>[0] = {}, options: { skillVersion?: string; members?: Member[] } = {}) {
  const base = createFakeBacklogApi(seed);
  const skillVersion = options.skillVersion ?? '1.0.0';
  const defaults: Record<string, string> = { principles: 'Default principles' };
  for (const type of types) { defaults[`template:${type}`] = `## Summary\n\nDefault ${type} template`; defaults[`type-instructions:${type}`] = `Default ${type} instructions`; }
  const overrides: Record<string, Override> = {};
  const guidanceCalls: { method: string; path: string; ifMatch: string | null; body?: unknown }[] = [];
  const control = { conflictNext: false, rejectNext: undefined as string[] | undefined };

  const parts = (key: string): { kind: GuidanceEntry['kind']; itemType: GuidanceEntry['itemType'] } => {
    const [kind, itemType] = key.split(':');
    return { kind: kind as GuidanceEntry['kind'], itemType: (itemType ?? null) as GuidanceEntry['itemType'] };
  };
  function entry(key: string): GuidanceEntry {
    const override = overrides[key];
    return {
      ...parts(key), content: override?.content ?? defaults[key], source: override ? 'project' : 'default', defaultSkill: 'backlog', defaultVersion: skillVersion,
      baseSkillVersion: override?.baseSkillVersion ?? null, differsFromDefault: override ? override.content !== defaults[key] : false, outdated: override ? override.baseSkillVersion !== skillVersion : false,
      version: override?.version ?? 0, updatedBy: override ? 'alice@example.test' : null, updatedAt: override ? '2026-01-01T00:00:00Z' : null,
    };
  }
  const effective = (): EffectiveGuidance => ({
    principles: entry('principles'),
    typeInstructions: Object.fromEntries(types.map((type) => [type, entry(`type-instructions:${type}`)])),
    templates: Object.fromEntries(types.map((type) => [type, entry(`template:${type}`)])),
    documentFormat: 'Document format rules', skills: { 'backlog-refinement': skillVersion },
  });
  const defaultsOut = (): DefaultGuidance => {
    const item = (key: string) => ({ content: defaults[key], skill: 'backlog', version: skillVersion });
    return {
      principles: item('principles'), typeInstructions: Object.fromEntries(types.map((type) => [type, item(`type-instructions:${type}`)])),
      templates: Object.fromEntries(types.map((type) => [type, item(`template:${type}`)])), documentFormat: 'Document format rules', skills: { 'backlog-refinement': skillVersion },
    };
  };

  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname.replace(/^\/api\/backlog/, '');
    const method = request.method;
    let m: RegExpExecArray | null;
    if ((m = /^\/projects\/([^/]+)\/members$/.exec(path)) && method === 'GET') {
      return json({ items: options.members ?? [{ email: 'alice@example.test', role: 'owner', name: 'Alice Owner', signedIn: true, addedBy: 'alice@example.test', addedAt: '2026-01-01T00:00:00Z' }] });
    }
    if (!(m = /^\/projects\/([^/]+)\/guidance(?:\/(.*))?$/.exec(path))) return undefined;
    const rest = m[2] ?? '';
    const role = base.state.projects.find((project) => project.id === m![1])?.role;
    const ifMatch = request.headers.get('If-Match');
    const body = ['PUT', 'POST'].includes(method) ? await request.clone().json() : undefined;
    guidanceCalls.push({ method, path, ifMatch, body });
    if (method === 'GET' && rest === '') return json(effective());
    if (method === 'GET' && rest === 'defaults') return json(defaultsOut());
    if (method === 'GET' && rest === 'export') {
      const includeDefaults = url.searchParams.get('includeDefaults') === 'true';
      const pick = (key: string) => (overrides[key] || includeDefaults) ? { content: entry(key).content, baseSkillVersion: overrides[key]?.baseSkillVersion ?? skillVersion } : undefined;
      const group = (prefix: string) => Object.fromEntries(types.map((type) => [type, pick(`${prefix}:${type}`)]).filter(([, value]) => value));
      return json({ format: 'backlog-guidance', formatVersion: 5, exportedAt: '2026-01-01T00:00:00Z', project: { id: m[1], name: 'Alpha' }, skills: { 'backlog-refinement': skillVersion },
        guidance: { principles: pick('principles') ?? null, typeInstructions: group('type-instructions'), templates: group('template') } });
    }
    if (role !== 'owner') return problem(403, 'owner-required');
    if (method === 'POST' && rest === 'import') {
      const doc = body as { formatVersion?: number; guidance?: Record<string, unknown> };
      if (doc.formatVersion !== 5) return problem(422, 'unsupported-format', { detail: 'Expected format backlog-guidance version 5.' });
      const issues: string[] = [];
      const templates = (doc.guidance?.templates ?? {}) as Record<string, { content: string }>;
      for (const [type, value] of Object.entries(templates)) if (value.content.includes('{{')) issues.push(`templates.${type}: Line 1 contains a '{{…}}' placeholder; templates must be placeholder-free Markdown.`);
      if (issues.length) return problem(422, 'invalid-guidance', { detail: issues.join(' '), issues });
      for (const key of Object.keys(overrides)) delete overrides[key];
      for (const [type, value] of Object.entries(templates)) overrides[`template:${type}`] = { content: value.content, version: 1, baseSkillVersion: skillVersion };
      return json(effective());
    }
    const key = rest === 'principles' ? 'principles' : /^(type-instructions|template)\/([a-z-]+)$/.exec(rest)?.slice(1).join(':');
    if (!key || !(key in defaults)) return problem(404, 'not-found');
    if (method === 'PUT') {
      if (ifMatch === null) return problem(428, 'precondition-required');
      if (control.conflictNext || Number(ifMatch.replace(/"/g, '')) !== entry(key).version) {
        control.conflictNext = false;
        return problem(409, 'version-conflict', { currentVersion: entry(key).version + 1 });
      }
      const content = (body as { content: string }).content;
      if (control.rejectNext) { const issues = control.rejectNext; control.rejectNext = undefined; return problem(422, 'invalid-guidance', { detail: issues.join(' '), issues }); }
      overrides[key] = { content, version: (overrides[key]?.version ?? 0) + 1, baseSkillVersion: (body as { baseSkillVersion?: string }).baseSkillVersion ?? skillVersion };
      return json(entry(key));
    }
    if (method === 'DELETE') { delete overrides[key]; return json(entry(key)); }
    return undefined;
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), 'http://localhost'), init);
    return (await handle(request.clone())) ?? base.fetch(request);
  }) as typeof fetch;
  const client = createBacklogClient({ baseUrl: 'http://localhost/api/backlog', fetch: fetchImpl });
  const api: FakeBacklogApi & { overrides: typeof overrides; guidanceCalls: typeof guidanceCalls; control: typeof control; setOverride: (key: string, content: string, baseSkillVersion?: string, version?: number) => void } = {
    ...base, client, fetch: fetchImpl, overrides, guidanceCalls, control,
    setOverride: (key, content, baseSkillVersion = skillVersion, version = 1) => { overrides[key] = { content, version, baseSkillVersion }; },
  };
  return api;
}
