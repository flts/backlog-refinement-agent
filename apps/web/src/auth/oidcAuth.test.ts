import type { User } from 'oidc-client-ts';
import { describe, expect, it, vi } from 'vitest';
import { cleanCallbackUrl, OidcAuthSession, redirectGuardKey, type OidcUserManager } from './oidcAuth';

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), removeItem: (key: string) => void map.delete(key) };
}

const user = (overrides: Partial<User> = {}) => ({
  access_token: 'access-1', refresh_token: 'refresh-1', expired: false, state: undefined,
  profile: { email: 'alice@example.test', name: 'Alice Owner' }, ...overrides,
}) as unknown as User;

function setup({ stored = null as User | null, url = 'http://localhost:5173/', callback = undefined as User | undefined, silent = undefined as User | null | Error | undefined } = {}) {
  const loaded: ((user: User) => void)[] = [];
  const renewErrors: (() => void)[] = [];
  const manager = {
    getUser: vi.fn().mockResolvedValue(stored),
    signinRedirect: vi.fn().mockResolvedValue(undefined),
    signinRedirectCallback: vi.fn(async () => { if (!callback) throw new Error('No matching state found in storage'); return callback; }),
    signinSilent: vi.fn(async () => { if (silent instanceof Error) throw silent; return silent ?? null; }),
    signoutRedirect: vi.fn().mockResolvedValue(undefined),
    removeUser: vi.fn().mockResolvedValue(undefined),
    events: { addUserLoaded: (cb: (u: User) => void) => { loaded.push(cb); return () => undefined; }, addSilentRenewError: (cb: () => void) => { renewErrors.push(cb); return () => undefined; } },
  };
  const parsed = new URL(url);
  const location = { origin: parsed.origin, pathname: parsed.pathname, search: parsed.search, hash: parsed.hash, href: parsed.href };
  const history = { replaceState: vi.fn() };
  const storage = memoryStorage();
  const onFatal = vi.fn();
  const now = { value: 5_000_000 };
  const session = new OidcAuthSession({ authority: 'http://localhost:8080/realms/backlog', clientId: 'backlog-web', userManager: manager as unknown as OidcUserManager, location, history, storage, onFatal, now: () => now.value });
  return { session, manager, history, storage, onFatal, now, renewErrors, loaded };
}

describe('OidcAuthSession', () => {
  it('uses a valid stored session and returns its access token', async () => {
    const { session, manager } = setup({ stored: user() });
    expect(await session.init()).toBe('ready');
    expect(session.user).toEqual({ email: 'alice@example.test', name: 'Alice Owner' });
    expect(await session.getAccessToken()).toBe('access-1');
    expect(manager.signinRedirect).not.toHaveBeenCalled();
  });

  it('starts a sign-in redirect (once) when there is no session', async () => {
    const { session, manager } = setup({ url: 'http://localhost:5173/?project=1' });
    expect(await session.init()).toBe('redirecting');
    expect(manager.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: '/?project=1' } });
  });

  it('handles the redirect callback and cleans the URL', async () => {
    const { session, manager, history } = setup({ url: 'http://localhost:5173/?code=abc&state=xyz&session_state=s&iss=i', callback: user({ state: { returnTo: '/?project=1' } } as Partial<User>) });
    expect(await session.init()).toBe('ready');
    expect(manager.signinRedirectCallback).toHaveBeenCalledOnce();
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/?project=1');
  });

  it('cleans the URL and reports a failed callback', async () => {
    const { session, history } = setup({ url: 'http://localhost:5173/?code=abc&state=xyz' });
    await expect(session.init()).rejects.toThrow(/Sign-in failed/);
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('exchanges the callback code only once even when init runs twice', async () => {
    const { session, manager } = setup({ url: 'http://localhost:5173/?code=abc&state=xyz', callback: user() });
    await Promise.all([session.init(), session.init()]);
    expect(manager.signinRedirectCallback).toHaveBeenCalledOnce();
  });

  it('renews an expired token with the refresh token', async () => {
    const fresh = user({ access_token: 'access-2' });
    const { session, manager } = setup({ stored: user({ expired: true }), silent: fresh });
    expect(await session.init()).toBe('ready');
    expect(manager.signinSilent).toHaveBeenCalledOnce();
    manager.getUser.mockResolvedValue(user({ expired: true }));
    expect(await session.getAccessToken()).toBe('access-2');
  });

  it('redirects to sign in when renewal fails', async () => {
    const { session, manager } = setup({ stored: user({ expired: true }), silent: new Error('invalid_grant') });
    expect(await session.init()).toBe('redirecting');
    expect(manager.signinRedirect).toHaveBeenCalledOnce();
  });

  it('a 401 clears the session and starts signinRedirect, but not in a loop', async () => {
    const { session, manager, onFatal, now, storage } = setup({ stored: user() });
    await session.init();
    session.onUnauthorized();
    await vi.waitFor(() => expect(manager.signinRedirect).toHaveBeenCalledOnce());
    expect(manager.removeUser).toHaveBeenCalledOnce();
    expect(storage.getItem(redirectGuardKey)).toBe(String(now.value));
    session.onUnauthorized();
    expect(onFatal).toHaveBeenCalledOnce();
  });

  it('treats a failed silent renew as unauthorized', async () => {
    const { session, manager, renewErrors } = setup({ stored: user() });
    await session.init();
    renewErrors[0]();
    await vi.waitFor(() => expect(manager.signinRedirect).toHaveBeenCalled());
  });

  it('signs out through signoutRedirect and updates the user when loaded', async () => {
    const { session, manager, loaded } = setup({ stored: user() });
    await session.init();
    loaded[0](user({ profile: { email: 'a@example.test' } } as Partial<User>));
    expect(session.user).toEqual({ email: 'a@example.test', name: 'a@example.test' });
    await session.signOut();
    expect(manager.signoutRedirect).toHaveBeenCalledOnce();
  });
});

describe('cleanCallbackUrl', () => {
  it('removes only OIDC parameters', () => {
    expect(cleanCallbackUrl({ pathname: '/p', search: '?code=1&state=2&keep=yes', hash: '#h' })).toBe('/p?keep=yes#h');
    expect(cleanCallbackUrl({ pathname: '/', search: '?error=access_denied&state=2', hash: '' })).toBe('/');
  });
});
