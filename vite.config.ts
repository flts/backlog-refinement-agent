import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Serves /config.json from .env.local during development only. Nothing from the
// environment is compiled into the bundle; production provides runtime configuration.
function devRuntimeConfig(env: Record<string, string>): Plugin {
  return {
    name: 'dev-runtime-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config.json', (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({
          endpoint: env.LLM_ENDPOINT ?? '',
          model: env.LLM_MODEL ?? '',
          streaming: env.LLM_STREAMING === 'true',
          apiKey: env.LOCAL_LLM_API_KEY ?? '',
        }));
      });
    },
  };
}

// Development counterpart of the Caddy /source-proxy relay (same allow-list: SOURCE_PROXY_HOSTS in .env.local).
function devSourceProxy(env: Record<string, string>): Plugin {
  const allowed = env.SOURCE_PROXY_HOSTS ? new RegExp(`^(?:${env.SOURCE_PROXY_HOSTS})$`) : undefined;
  return {
    name: 'dev-source-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/source-proxy', async (request, response) => {
        const match = /^\/(https?)\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec((request as { url?: string }).url ?? '');
        if (!match || !allowed?.test(match[2])) {
          response.statusCode = 403;
          response.end('Source proxy is disabled or the host is not allowed (SOURCE_PROXY_HOSTS).');
          return;
        }
        try {
          const upstream = await fetch(`${match[1]}://${match[2]}${match[3] ?? '/'}${match[4] ?? ''}`, { redirect: 'follow' });
          response.statusCode = upstream.status;
          response.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
          response.end(new Uint8Array(await upstream.arrayBuffer()) as unknown as string);
        } catch (cause) {
          const inner = (cause as { cause?: { code?: string; message?: string } }).cause;
          const reason = inner?.code ?? inner?.message ?? (cause instanceof Error ? cause.message : 'unknown error');
          console.warn(`[source-proxy] ${match[1]}://${match[2]} failed: ${reason}`);
          response.statusCode = 502;
          response.end(`Source proxy upstream error: ${reason}`);
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), devRuntimeConfig(env), devSourceProxy(env)],
    base: './',
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      // Lets styles.contrast.test.ts read the real stylesheet via ?raw.
      css: { include: [/styles\.css/] },
    },
  };
});
