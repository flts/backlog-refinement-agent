export interface AuthUser {
  name: string;
  email: string;
}

/**
 * The single seam between authentication and the network clients (REST, SSE events, AG-UI).
 *
 * - REST: call `getAccessToken()` per request and add `Authorization: Bearer <token>` when it is non-null
 *   (see `createAuthFetch`). On a 401 response call `onUnauthorized()`.
 * - AG-UI (`@ag-ui/client` HttpAgent): resolve the token right before each run and pass it in `headers`;
 *   it is fetch-based, so headers work.
 * - SSE (project event stream): the browser `EventSource` cannot send headers. Use a fetch-based EventSource
 *   (for example `fetch` + stream parsing with the header from `getAccessToken()`), which is the preferred
 *   option, or a short-lived `?access_token=` query parameter if backlog-api explicitly supports it.
 *   Re-read the token on every (re)connect; never cache it.
 * - `platform` mode returns `null` tokens: the gateway authenticates the browser (cookie) and injects the
 *   bearer token, so clients must simply omit the Authorization header.
 */
export interface TokenProvider {
  /** The current access token, renewed when necessary, or `null` when the gateway handles authentication. */
  getAccessToken(): Promise<string | null>;
  /** Call on any 401 from an API. Platform: reloads the page once. OIDC: starts a new sign-in. */
  onUnauthorized(): void;
  /** Known after sign-in succeeded. */
  user: AuthUser | null;
  signOut(): Promise<void>;
}

export type AuthMode = 'platform' | 'oidc';

export interface AuthSession extends TokenProvider {
  readonly mode: AuthMode;
  /** True when the SPA can end the session itself (OIDC). In platform mode the gateway owns the session. */
  readonly canSignOut: boolean;
  /**
   * Establishes the session. Resolves `ready` when a user is signed in, or `redirecting` when the browser
   * is being sent away (login redirect or page reload) and the app must not render. Rejects with `AuthError`.
   */
  init(): Promise<'ready' | 'redirecting'>;
  /** Clears the redirect/reload loop guard so an explicit user retry may start a new sign-in. */
  resetGuard(): void;
}

export interface AuthSessionOptions {
  /** Called when authentication cannot recover on its own (for example a redirect loop was detected). */
  onFatal?: (error: AuthError) => void;
}

export class AuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthError';
  }
}
