import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider';

export function testAuth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    mode: 'oidc',
    provider: { getAccessToken: async () => 'token', onUnauthorized: vi.fn(), user: { name: 'Alice Owner', email: 'alice@example.test' }, signOut: vi.fn(async () => undefined) },
    user: { name: 'Alice Owner', email: 'alice@example.test' },
    canSignOut: true,
    signOut: vi.fn(async () => undefined),
    ...overrides,
  };
}

export function TestAuth({ value = testAuth(), children }: { value?: AuthContextValue; children: ReactNode }) {
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
