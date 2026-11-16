import { AuthError, type AuthSession, type AuthSessionOptions, type AuthUser } from './types';

export const reloadGuardKey = 'auth-platform-reload-at';
/** A second reload within this window is treated as a loop instead of being repeated. */
export const reloadGuardWindowMs = 30_000;

export interface PlatformAuthDeps extends AuthSessionOptions {
  /** Base URL of backlog-api, for example `/api/backlog`. */
  backlogApi: string;
  fetcher?: typeof fetch;
  reload?: () => void;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  now?: () => number;
}

/**
 * `auth.mode = "platform"`: the platform (Istio gateway / ext-authz) authenticates the browser and injects the
 * bearer token, so the SPA sends no Authorization header. A 401 means the gateway session is gone; one full page
 * reload lets the gateway re-authenticate. A sessionStorage guard prevents reload loops.
 */
export class PlatformAuthSession implements AuthSession {
  readonly mode = 'platform' as const;
  readonly canSignOut = false;
  user: AuthUser | null = null;
  private readonly fetcher: typeof fetch;
  private readonly reload: () => void;
  private readonly storage: NonNullable<PlatformAuthDeps['storage']>;
  private readonly now: () => number;
  private started?: Promise<'ready' | 'redirecting'>;

  constructor(private readonly deps: PlatformAuthDeps) {
    this.fetcher = deps.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.reload = deps.reload ?? (() => window.location.reload());
    this.storage = deps.storage ?? window.sessionStorage;
    this.now = deps.now ?? Date.now;
  }

  getAccessToken(): Promise<string | null> {
    return Promise.resolve(null);
  }

  /** Returns false when a reload was already tried recently (loop guard). */
  private tryReload(): boolean {
    const last = Number(this.storage.getItem(reloadGuardKey));
    if (last && this.now() - last < reloadGuardWindowMs) return false;
    this.storage.setItem(reloadGuardKey, String(this.now()));
    this.reload();
    return true;
  }

  onUnauthorized(): void {
    if (!this.tryReload()) {
      this.deps.onFatal?.(new AuthError('Your session could not be re-established. Sign in again through your organisation, then try again.'));
    }
  }

  init(): Promise<'ready' | 'redirecting'> {
    this.started ??= this.start();
    return this.started;
  }

  private async start(): Promise<'ready' | 'redirecting'> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.deps.backlogApi}/me`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    } catch (cause) {
      throw new AuthError('The backlog service could not be reached.', { cause });
    }
    if (response.status === 401) {
      if (this.tryReload()) return 'redirecting';
      throw new AuthError('You are not signed in and the platform sign-in did not complete. Try again.');
    }
    if (response.status === 403) throw new AuthError('Your account is not allowed to use Backlog Studio (a verified email address is required).');
    if (!response.ok) throw new AuthError(`The backlog service answered with HTTP ${response.status}.`);
    const me = await response.json() as { email?: string; name?: string | null };
    if (!me.email) throw new AuthError('The backlog service did not return an email address for your account.');
    this.storage.removeItem(reloadGuardKey);
    this.user = { email: me.email, name: me.name?.trim() || me.email };
    return 'ready';
  }

  resetGuard(): void {
    this.storage.removeItem(reloadGuardKey);
  }

  async signOut(): Promise<void> {
    // The gateway owns the session; reloading lets it decide what happens next.
    this.reload();
  }
}
