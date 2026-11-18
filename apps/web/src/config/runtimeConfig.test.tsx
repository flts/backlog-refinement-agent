import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { RuntimeConfigProvider, useRuntimeConfig } from './RuntimeConfigProvider';
import { loadRuntimeConfig, parseRuntimeConfig, RuntimeConfigError } from './runtimeConfig';

const oidc = { auth: { mode: 'oidc', authority: 'http://localhost:8080/realms/backlog', clientId: 'backlog-web', scope: 'openid profile email' }, api: { backlog: '/api/backlog', agent: '/api/agent' }, agentId: 'backlog-refiner' };
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

describe('parseRuntimeConfig', () => {
  it('accepts oidc and platform configurations', () => {
    expect(parseRuntimeConfig(oidc).auth).toMatchObject({ mode: 'oidc', clientId: 'backlog-web' });
    const platform = parseRuntimeConfig({ ...oidc, auth: { mode: 'platform', authority: '', clientId: '', scope: '' } });
    expect(platform.auth).toEqual({ mode: 'platform', authority: undefined, clientId: undefined, scope: undefined });
  });

  it.each([
    ['unknown mode', { ...oidc, auth: { mode: 'basic' } }, /auth\.mode/],
    ['oidc without authority', { ...oidc, auth: { mode: 'oidc', clientId: 'x' } }, /auth\.authority is required/],
    ['oidc without client id', { ...oidc, auth: { mode: 'oidc', authority: 'http://a' } }, /auth\.clientId is required/],
    ['missing api', { auth: oidc.auth, agentId: 'a' }, /api/],
    ['relative api without slash', { ...oidc, api: { backlog: 'api/backlog', agent: '/api/agent' } }, /api\.backlog/],
    ['empty agent id', { ...oidc, agentId: '' }, /agentId/],
    ['legacy LLM shape', { endpoint: 'https://x', model: 'm', streaming: false }, /auth/],
  ])('rejects %s', (_name, value, message) => {
    expect(() => parseRuntimeConfig(value)).toThrow(RuntimeConfigError);
    expect(() => parseRuntimeConfig(value)).toThrow(message);
  });
});

describe('loadRuntimeConfig', () => {
  it('loads and validates /config.json without caching', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(oidc));
    expect((await loadRuntimeConfig(fetcher)).agentId).toBe('backlog-refiner');
    expect(fetcher).toHaveBeenCalledWith('/config.json', { cache: 'no-store' });
  });

  it('reports unreachable, HTTP and JSON problems', async () => {
    await expect(loadRuntimeConfig(vi.fn().mockRejectedValue(new TypeError('offline')))).rejects.toThrow(/could not be reached/);
    await expect(loadRuntimeConfig(vi.fn().mockResolvedValue(new Response('', { status: 404 })))).rejects.toThrow(/HTTP 404/);
    await expect(loadRuntimeConfig(vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })))).rejects.toThrow(/not valid JSON/);
  });
});

describe('RuntimeConfigProvider', () => {
  function Show() { return <p>mode: {useRuntimeConfig().auth.mode}</p>; }

  it('renders children after loading', async () => {
    render(<RuntimeConfigProvider load={async () => parseRuntimeConfig(oidc)}><Show /></RuntimeConfigProvider>);
    expect(screen.getByRole('status')).toHaveTextContent('Loading configuration');
    expect(await screen.findByText('mode: oidc')).toBeInTheDocument();
  });

  it('blocks with an accessible error screen and retries', async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockRejectedValueOnce(new RuntimeConfigError('/config.json is invalid: auth.mode')).mockResolvedValue(parseRuntimeConfig(oidc));
    const { container } = render(<RuntimeConfigProvider load={load}><Show /></RuntimeConfigProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('/config.json is invalid');
    expect(screen.queryByText('mode: oidc')).toBeNull();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('mode: oidc')).toBeInTheDocument());
  });
});
