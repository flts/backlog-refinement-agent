import type { RuntimeConfig } from '../config/runtimeConfig';
import { OidcAuthSession } from './oidcAuth';
import { PlatformAuthSession } from './platformAuth';
import type { AuthSession, AuthSessionOptions } from './types';

export * from './types';
export { createAuthFetch } from './authFetch';
export { AuthProvider, useAuth } from './AuthProvider';

export function createAuthSession(config: RuntimeConfig, options: AuthSessionOptions = {}): AuthSession {
  if (config.auth.mode === 'platform') return new PlatformAuthSession({ backlogApi: config.api.backlog.replace(/\/$/, ''), ...options });
  return new OidcAuthSession({ authority: config.auth.authority!, clientId: config.auth.clientId!, scope: config.auth.scope, ...options });
}
