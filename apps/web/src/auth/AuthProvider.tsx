import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ErrorScreen, LoadingScreen } from '../app/StatusScreen';
import { useRuntimeConfig } from '../config/RuntimeConfigProvider';
import type { RuntimeConfig } from '../config/runtimeConfig';
import { createAuthSession } from './index';
import { AuthError, type AuthMode, type AuthSession, type AuthSessionOptions, type TokenProvider } from './types';

export interface AuthContextValue {
  mode: AuthMode;
  /** Hand this to the REST, SSE and AG-UI clients. */
  provider: TokenProvider;
  user: NonNullable<TokenProvider['user']>;
  canSignOut: boolean;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider.');
  return value;
}

type State = { phase: 'loading' } | { phase: 'redirecting' } | { phase: 'ready' } | { phase: 'error'; message: string };

/** Gates the app: nothing below renders before a user is signed in. */
export function AuthProvider({ children, createSession = createAuthSession }: {
  children: ReactNode;
  createSession?: (config: RuntimeConfig, options: AuthSessionOptions) => AuthSession;
}) {
  const config = useRuntimeConfig();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ phase: 'loading' });

  const session = useMemo(
    () => {
      void attempt; // a retry creates a fresh session
      return createSession(config, { onFatal: (error) => setState({ phase: 'error', message: error.message }) });
    },
    [config, createSession, attempt],
  );

  useEffect(() => {
    let active = true;
    setState({ phase: 'loading' });
    session.init().then(
      (result) => { if (active) setState({ phase: result === 'ready' ? 'ready' : 'redirecting' }); },
      (cause: unknown) => {
        if (active) setState({ phase: 'error', message: cause instanceof AuthError ? cause.message : `Sign-in failed: ${cause instanceof Error ? cause.message : String(cause)}` });
      },
    );
    return () => { active = false; };
  }, [session]);

  const retry = useCallback(() => { session.resetGuard(); setAttempt((value) => value + 1); }, [session]);

  const value = useMemo<AuthContextValue | undefined>(() => state.phase === 'ready' && session.user ? {
    mode: session.mode,
    provider: session,
    user: session.user,
    canSignOut: session.canSignOut,
    signOut: () => session.signOut(),
  } : undefined, [state.phase, session]);

  if (state.phase === 'error') return <ErrorScreen title="Sign-in problem" message={state.message} actionLabel="Try again" onAction={retry} />;
  if (state.phase === 'redirecting') return <LoadingScreen message="Redirecting to sign in…" />;
  if (!value) return <LoadingScreen message="Signing you in…" />;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
