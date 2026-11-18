import { describe, expect, it, vi } from 'vitest';
import { createAuthFetch } from './authFetch';
import { PlatformAuthSession, reloadGuardKey, reloadGuardWindowMs } from './platformAuth';
import { AuthError } from './types';

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), removeItem: (key: string) => void map.delete(key) };
}

function setup(response: Response | Error, now = { value: 1_000_000 }) {
  const reload = vi.fn();
  const onFatal = vi.fn();
  const storage = memoryStorage();
  const fetcher = vi.fn(async () => { if (response instanceof Error) throw response; return response.clone(); });
  const session = new PlatformAuthSession({ backlogApi: '/api/backlog', fetcher: fetcher as unknown as typeof fetch, reload, storage, now: () => now.value, onFatal });
  return { session, reload, onFatal, storage, fetcher, now };
}

describe('PlatformAuthSession', () => {
  it('loads the user from /me and never provides a token', async () => {
    const { session, fetcher, reload } = setup(Response.json({ email: 'alice@example.test', name: 'Alice Owner', sub: 's' }));
    expect(await session.init()).toBe('ready');
    expect(fetcher).toHaveBeenCalledWith('/api/backlog/me', expect.objectContaining({ cache: 'no-store' }));
    expect(session.user).toEqual({ email: 'alice@example.test', name: 'Alice Owner' });
    expect(await session.getAccessToken()).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('falls back to the email when the name is missing', async () => {
    const { session } = setup(Response.json({ email: 'a@example.test', name: null }));
    await session.init();
    expect(session.user?.name).toBe('a@example.test');
  });

  it('reloads once on 401 and then fails instead of looping', async () => {
    const { session, reload, storage } = setup(new Response(null, { status: 401 }));
    expect(await session.init()).toBe('redirecting');
    expect(reload).toHaveBeenCalledOnce();
    expect(storage.getItem(reloadGuardKey)).not.toBeNull();
    const again = setup(new Response(null, { status: 401 }));
    again.storage.setItem(reloadGuardKey, String(again.now.value - 1000));
    await expect(again.session.init()).rejects.toBeInstanceOf(AuthError);
    expect(again.reload).not.toHaveBeenCalled();
  });

  it('allows a new reload after the guard window and clears the guard on success', async () => {
    const stale = setup(new Response(null, { status: 401 }));
    stale.storage.setItem(reloadGuardKey, String(stale.now.value - reloadGuardWindowMs - 1));
    expect(await stale.session.init()).toBe('redirecting');
    const ok = setup(Response.json({ email: 'a@example.test', name: 'A' }));
    ok.storage.setItem(reloadGuardKey, String(ok.now.value));
    await ok.session.init();
    expect(ok.storage.getItem(reloadGuardKey)).toBeNull();
  });

  it('onUnauthorized reloads once and reports a fatal error when it would loop', () => {
    const { session, reload, onFatal } = setup(Response.json({}));
    session.onUnauthorized();
    session.onUnauthorized();
    expect(reload).toHaveBeenCalledOnce();
    expect(onFatal).toHaveBeenCalledOnce();
  });

  it('maps 403, server errors and network failures to readable errors', async () => {
    await expect(setup(new Response(null, { status: 403 })).session.init()).rejects.toThrow(/verified email/);
    await expect(setup(new Response(null, { status: 500 })).session.init()).rejects.toThrow(/HTTP 500/);
    await expect(setup(new TypeError('offline')).session.init()).rejects.toThrow(/could not be reached/);
  });

  it('initialises only once', async () => {
    const { session, fetcher } = setup(Response.json({ email: 'a@example.test', name: 'A' }));
    await Promise.all([session.init(), session.init()]);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('createAuthFetch', () => {
  it('adds the bearer token, omits it when null and reports 401', async () => {
    const base = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(null, { status: init?.method === 'DELETE' ? 401 : 200 }));
    const provider = { getAccessToken: vi.fn().mockResolvedValue('abc'), onUnauthorized: vi.fn(), user: null, signOut: vi.fn() };
    const authFetch = createAuthFetch(provider, base as unknown as typeof fetch);
    await authFetch('/api/backlog/projects');
    expect(new Headers(base.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer abc');
    provider.getAccessToken.mockResolvedValue(null);
    await authFetch('/api/backlog/projects');
    expect(new Headers(base.mock.calls[1][1]?.headers).has('Authorization')).toBe(false);
    expect(provider.onUnauthorized).not.toHaveBeenCalled();
    await authFetch('/api/backlog/projects/1', { method: 'DELETE' });
    expect(provider.onUnauthorized).toHaveBeenCalledOnce();
  });
});
