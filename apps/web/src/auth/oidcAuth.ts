import { UserManager, WebStorageStateStore, type User, type UserManagerSettings } from 'oidc-client-ts';
import { defaultOidcScope } from '../config/runtimeConfig';
import { AuthError, type AuthSession, type AuthSessionOptions, type AuthUser } from './types';

export const redirectGuardKey = 'auth-oidc-redirect-at';
/** Another sign-in redirect within this window after a 401 means the API keeps rejecting fresh tokens. */
export const redirectGuardWindowMs = 15_000;
const callbackParams = ['code', 'state', 'session_state', 'iss', 'error', 'error_description', 'error_uri'];

/** The subset of oidc-client-ts `UserManager` this module uses (also what tests mock). */
export type OidcUserManager = Pick<UserManager, 'getUser' | 'signinRedirect' | 'signinRedirectCallback' | 'signinSilent' | 'signoutRedirect' | 'removeUser' | 'events'>;

export interface OidcAuthDeps extends AuthSessionOptions {
  authority: string;
  clientId: string;
  scope?: string;
  userManager?: OidcUserManager;
  location?: Pick<Location, 'origin' | 'pathname' | 'search' | 'hash' | 'href'>;
  history?: Pick<History, 'replaceState'>;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  now?: () => number;
}

interface SigninState { returnTo?: string }

export function createUserManager(deps: Pick<OidcAuthDeps, 'authority' | 'clientId' | 'scope'>, origin = window.location.origin): UserManager {
  // Tokens and the PKCE/state records live in sessionStorage only (never localStorage).
  const store = new WebStorageStateStore({ store: window.sessionStorage });
  const settings: UserManagerSettings = {
    authority: deps.authority,
    client_id: deps.clientId,
    redirect_uri: `${origin}/`,
    post_logout_redirect_uri: `${origin}/`,
    response_type: 'code',
    scope: deps.scope || defaultOidcScope,
    userStore: store,
    stateStore: store,
    // Refresh-token renewal; without a refresh token oidc-client-ts would need a silent_redirect_uri iframe, which is not used.
    automaticSilentRenew: true,
    monitorSession: false,
  };
  return new UserManager(settings);
}

function toAuthUser(user: User): AuthUser {
  const email = typeof user.profile.email === 'string' ? user.profile.email : '';
  const name = typeof user.profile.name === 'string' && user.profile.name.trim() ? user.profile.name.trim() : email;
  return { email, name };
}

/** Returns the URL without OIDC callback parameters (path, other params and hash are kept). */
export function cleanCallbackUrl(location: Pick<Location, 'pathname' | 'search' | 'hash'>): string {
  const params = new URLSearchParams(location.search);
  for (const key of callbackParams) params.delete(key);
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
}

/** `auth.mode = "oidc"`: Authorization Code + PKCE with oidc-client-ts, silent renew through refresh tokens. */
export class OidcAuthSession implements AuthSession {
  readonly mode = 'oidc' as const;
  readonly canSignOut = true;
  user: AuthUser | null = null;
  private readonly manager: OidcUserManager;
  private readonly location: NonNullable<OidcAuthDeps['location']>;
  private readonly history: NonNullable<OidcAuthDeps['history']>;
  private readonly storage: NonNullable<OidcAuthDeps['storage']>;
  private readonly now: () => number;
  private renewal?: Promise<User | null>;
  private redirecting = false;
  private started?: Promise<'ready' | 'redirecting'>;

  constructor(private readonly deps: OidcAuthDeps) {
    this.manager = deps.userManager ?? createUserManager(deps);
    this.location = deps.location ?? window.location;
    this.history = deps.history ?? window.history;
    this.storage = deps.storage ?? window.sessionStorage;
    this.now = deps.now ?? Date.now;
    this.manager.events.addSilentRenewError(() => this.onUnauthorized());
    this.manager.events.addUserLoaded((user) => { this.user = toAuthUser(user); });
  }

  private currentPath(): string {
    return `${this.location.pathname}${this.location.search}${this.location.hash}`;
  }

  private async redirectToSignin(): Promise<'redirecting'> {
    if (!this.redirecting) {
      this.redirecting = true;
      await this.manager.signinRedirect({ state: { returnTo: this.currentPath() } satisfies SigninState });
    }
    return 'redirecting';
  }

  private hasCallbackParams(): boolean {
    const params = new URLSearchParams(this.location.search);
    return params.has('state') && (params.has('code') || params.has('error'));
  }

  /** Idempotent: the callback code can only be exchanged once (React StrictMode runs effects twice). */
  init(): Promise<'ready' | 'redirecting'> {
    this.started ??= this.start();
    return this.started;
  }

  private async start(): Promise<'ready' | 'redirecting'> {
    if (this.hasCallbackParams()) {
      let user: User | undefined;
      try {
        user = await this.manager.signinRedirectCallback(this.location.href);
      } catch (cause) {
        this.history.replaceState(null, '', cleanCallbackUrl(this.location));
        throw new AuthError(`Sign-in failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
      const state = user?.state as SigninState | undefined;
      const target = state?.returnTo ? state.returnTo : '/';
      this.history.replaceState(null, '', cleanCallbackUrl(new URL(target, this.location.origin)));
      this.user = toAuthUser(user);
      return 'ready';
    }
    const user = await this.manager.getUser();
    if (user && !user.expired) {
      this.user = toAuthUser(user);
      return 'ready';
    }
    const renewed = user?.refresh_token ? await this.renew() : null;
    if (renewed) { this.user = toAuthUser(renewed); return 'ready'; }
    return this.redirectToSignin();
  }

  private renew(): Promise<User | null> {
    this.renewal ??= this.manager.signinSilent().catch(() => null).finally(() => { this.renewal = undefined; });
    return this.renewal;
  }

  async getAccessToken(): Promise<string | null> {
    let user = await this.manager.getUser();
    if (!user || user.expired) user = user?.refresh_token ? await this.renew() : null;
    if (!user) { this.onUnauthorized(); return null; }
    return user.access_token;
  }

  onUnauthorized(): void {
    const last = Number(this.storage.getItem(redirectGuardKey));
    if (last && this.now() - last < redirectGuardWindowMs) {
      this.deps.onFatal?.(new AuthError('The service keeps rejecting your sign-in. Check that your account is allowed to use Backlog Studio, then try again.'));
      return;
    }
    this.storage.setItem(redirectGuardKey, String(this.now()));
    void this.manager.removeUser().catch(() => undefined).then(() => this.redirectToSignin());
  }

  resetGuard(): void {
    this.storage.removeItem(redirectGuardKey);
  }

  async signOut(): Promise<void> {
    this.storage.removeItem(redirectGuardKey);
    await this.manager.signoutRedirect();
  }
}
