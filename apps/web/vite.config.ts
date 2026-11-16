import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { devProxy, devRuntimeConfig } from './vite.dev-runtime.ts';

// Serves /config.json from .env.local during development only. Nothing from the
// environment is compiled into the bundle; production provides runtime configuration.
function devRuntimeConfigPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'dev-runtime-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config.json', (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify(devRuntimeConfig(env)));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Empty prefix: also reads process.env, which is where Aspire injects service URLs.
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), devRuntimeConfigPlugin(env)],
    base: './',
    server: { ...(env.PORT ? { port: Number(env.PORT) } : {}), proxy: devProxy(env) },
    preview: { proxy: devProxy(env) },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      // Lets styles.contrast.test.ts read the real stylesheet via ?raw.
      css: { include: [/styles\.css/] },
    },
  };
});
