import type { ProxyOptions } from 'vite';

type Env = Record<string, string | undefined>;

/** The /config.json served by the dev server; same shape as the Caddy one in production. Never bundled. */
export function devRuntimeConfig(env: Env) {
  const mode = env.AUTH_MODE === 'platform' ? 'platform' : 'oidc';
  return {
    auth: {
      mode,
      authority: env.OIDC_AUTHORITY || 'http://localhost:8080/realms/backlog',
      clientId: env.OIDC_CLIENT_ID || 'backlog-web',
      scope: env.OIDC_SCOPE || 'openid profile email',
    },
    api: { backlog: '/api/backlog', agent: '/api/agent' },
    agentId: env.AGENT_ID || 'backlog-refiner',
  };
}

const longTimeoutMs = 10 * 60 * 1000;

function streamingProxy(target: string): ProxyOptions {
  return {
    target,
    changeOrigin: false,
    ws: false,
    // SSE: no buffering happens in http-proxy; keep the connection open for long agent runs.
    timeout: longTimeoutMs,
    proxyTimeout: longTimeoutMs,
  };
}

/** `/api/backlog` and `/api/agent` proxies. Also understands the URLs Aspire injects via service discovery. */
export function devProxy(env: Env): Record<string, ProxyOptions> {
  const backlog = env.BACKLOG_API_URL || env['services__backlog-api__http__0'] || 'http://localhost:8001';
  const agent = env.AGENT_API_URL || env.AGENT_SERVICE_URL || env['services__agent-service__http__0'] || 'http://localhost:8002';
  return { '/api/backlog': streamingProxy(backlog), '/api/agent': streamingProxy(agent) };
}
