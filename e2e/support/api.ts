import { KEYCLOAK_URL, PASSWORD, WEB_URL, users, type UserKey } from './env';

const tokens = new Map<UserKey, { token: string; expiresAt: number }>();

/** Access token through the dev-only password-grant client (the SPA itself uses the real PKCE login). */
export async function tokenFor(user: UserKey): Promise<string> {
  const cached = tokens.get(user);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const response = await fetch(`${KEYCLOAK_URL}/realms/backlog/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'backlog-dev-cli', username: users[user].email, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`Token request for ${user} failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { access_token: string; expires_in: number };
  tokens.set(user, { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}

export async function api<T = unknown>(user: UserKey, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(`${WEB_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await tokenFor(user)}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} as ${user} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export interface ProjectDto { id: string; name: string }
export interface ItemDto { id: string; title: string; document: string; version: number; status: string; parentId: string | null }
export interface MemberDto { email: string; role: string }
export interface RevisionDto { version: number; origin: string; actor: string }

export const uniqueName = (prefix: string) => `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const createProject = (user: UserKey, name: string) => api<ProjectDto>(user, 'POST', '/api/backlog/projects', { name });
export const deleteProject = (user: UserKey, projectId: string) => api(user, 'DELETE', `/api/backlog/projects/${projectId}`).catch(() => undefined);
export const addMember = (owner: UserKey, projectId: string, email: string, role: 'owner' | 'contributor' = 'contributor') =>
  api<MemberDto>(owner, 'POST', `/api/backlog/projects/${projectId}/members`, { email, role });
export const createItem = (user: UserKey, projectId: string, input: { type: string; title: string; document?: string; parentId?: string }) =>
  api<ItemDto>(user, 'POST', `/api/backlog/projects/${projectId}/items`, input);
export const getItem = (user: UserKey, projectId: string, itemId: string) => api<ItemDto>(user, 'GET', `/api/backlog/projects/${projectId}/items/${itemId}`);
export const listItems = (user: UserKey, projectId: string) =>
  api<{ items: ItemDto[] }>(user, 'GET', `/api/backlog/projects/${projectId}/items`).then((body) => body.items);
export const listRevisions = (user: UserKey, projectId: string, itemId: string) =>
  api<{ items: RevisionDto[] }>(user, 'GET', `/api/backlog/projects/${projectId}/items/${itemId}/revisions`).then((body) => body.items);

/** Replaces the body of the `## <heading>` section of a Markdown document (the section must exist). */
export function withSection(document: string, heading: string, body: string): string {
  const lines = document.split('\n');
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) throw new Error(`Section "${heading}" not found in:\n${document}`);
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  return [...lines.slice(0, start + 1), body, '', ...lines.slice(end)].join('\n');
}

export async function waitForVersion(user: UserKey, projectId: string, itemId: string, version: number, timeoutMs = 15_000): Promise<ItemDto> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const item = await getItem(user, projectId, itemId);
    if (item.version >= version) return item;
    if (Date.now() > deadline) throw new Error(`Item ${itemId} did not reach version ${version} (is ${item.version}).`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
