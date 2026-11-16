import { describe, expect, it } from 'vitest';
import { parseRuntimeConfig } from './src/config/runtimeConfig';
import { devProxy, devRuntimeConfig } from './vite.dev-runtime';

describe('dev runtime config and proxy', () => {
  it('serves a valid default oidc config', () => {
    const config = parseRuntimeConfig(devRuntimeConfig({}));
    expect(config.auth).toEqual({ mode: 'oidc', authority: 'http://localhost:8080/realms/backlog', clientId: 'backlog-web', scope: 'openid profile email' });
    expect(config.api).toEqual({ backlog: '/api/backlog', agent: '/api/agent' });
    expect(config.agentId).toBe('backlog-refiner');
  });

  it('honours environment overrides and platform mode', () => {
    const config = parseRuntimeConfig(devRuntimeConfig({ AUTH_MODE: 'platform', AGENT_ID: 'other' }));
    expect(config.auth.mode).toBe('platform');
    expect(config.agentId).toBe('other');
    expect(devRuntimeConfig({ OIDC_AUTHORITY: 'https://kc/realms/x', OIDC_CLIENT_ID: 'web' }).auth).toMatchObject({ authority: 'https://kc/realms/x', clientId: 'web' });
  });

  it('proxies the API prefixes with long timeouts and Aspire fallbacks', () => {
    const defaults = devProxy({});
    expect(defaults['/api/backlog'].target).toBe('http://localhost:8001');
    expect(defaults['/api/agent'].target).toBe('http://localhost:8002');
    expect(defaults['/api/agent']).toMatchObject({ timeout: 600_000, proxyTimeout: 600_000 });
    const aspire = devProxy({ 'services__backlog-api__http__0': 'http://localhost:5001', 'services__agent-service__http__0': 'http://localhost:5002' });
    expect(aspire['/api/backlog'].target).toBe('http://localhost:5001');
    expect(aspire['/api/agent'].target).toBe('http://localhost:5002');
    expect(devProxy({ AGENT_API_URL: 'http://a:3' })['/api/agent'].target).toBe('http://a:3');
    expect(devProxy({ AGENT_SERVICE_URL: 'http://b:4' })['/api/agent'].target).toBe('http://b:4');
    expect(devProxy({ AGENT_API_URL: 'http://a:3', AGENT_SERVICE_URL: 'http://b:4' })['/api/agent'].target).toBe('http://a:3');
    const explicit = devProxy({ BACKLOG_API_URL: 'http://x:1', 'services__backlog-api__http__0': 'http://y:2' });
    expect(explicit['/api/backlog'].target).toBe('http://x:1');
  });
});
