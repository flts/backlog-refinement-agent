import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { RuntimeConfigProvider } from '../config/RuntimeConfigProvider';
import { parseRuntimeConfig } from '../config/runtimeConfig';
import { AuthProvider, useAuth } from './AuthProvider';
import { AuthError, type AuthSession, type AuthSessionOptions } from './types';

const config = parseRuntimeConfig({ auth: { mode: 'oidc', authority: 'http://a', clientId: 'c' }, api: { backlog: '/api/backlog', agent: '/api/agent' }, agentId: 'backlog-refiner' });

function fakeSession(init: () => Promise<'ready' | 'redirecting'>): AuthSession {
  return {
    mode: 'oidc', canSignOut: true, user: { name: 'Alice Owner', email: 'alice@example.test' },
    init, resetGuard: vi.fn(), getAccessToken: async () => 'token', onUnauthorized: vi.fn(), signOut: vi.fn(async () => undefined),
  };
}

function renderGate(createSession: (config: unknown, options: AuthSessionOptions) => AuthSession) {
  return render(<RuntimeConfigProvider load={async () => config}><AuthProvider createSession={createSession as never}><Me /></AuthProvider></RuntimeConfigProvider>);
}
function Me() { const auth = useAuth(); return <p>Hello {auth.user.name}</p>; }

describe('AuthProvider', () => {
  it('shows an accessible loading state, then the app', async () => {
    let finish: (value: 'ready') => void = () => undefined;
    const session = fakeSession(() => new Promise((resolve) => { finish = resolve; }));
    const { container } = renderGate(() => session);
    expect(await screen.findByText('Signing you in…')).toHaveAttribute('role', 'status');
    await expectNoAxeViolations(container);
    finish('ready');
    expect(await screen.findByText('Hello Alice Owner')).toBeInTheDocument();
  });

  it('keeps the app hidden while the browser is redirecting', async () => {
    renderGate(() => fakeSession(async () => 'redirecting'));
    expect(await screen.findByText('Redirecting to sign in…')).toBeInTheDocument();
    expect(screen.queryByText(/Hello/)).toBeNull();
  });

  it('shows an accessible error screen and retries with a fresh session', async () => {
    const user = userEvent.setup();
    const failing = fakeSession(async () => { throw new AuthError('Sign-in failed: boom'); });
    const working = fakeSession(async () => 'ready');
    const create = vi.fn().mockReturnValueOnce(failing).mockReturnValue(working);
    const { container } = renderGate(create);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in failed: boom');
    expect(screen.getByRole('heading', { name: 'Sign-in problem' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('Hello Alice Owner')).toBeInTheDocument());
    expect(failing.resetGuard).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('shows fatal errors reported by the session (loop guard)', async () => {
    let fatal: (error: AuthError) => void = () => undefined;
    const session = fakeSession(async () => 'ready');
    renderGate(vi.fn((_config: unknown, options: AuthSessionOptions) => { fatal = options.onFatal!; return session; }));
    await screen.findByText('Hello Alice Owner');
    fatal(new AuthError('The service keeps rejecting your sign-in.'));
    expect(await screen.findByRole('alert')).toHaveTextContent('keeps rejecting');
  });
});
