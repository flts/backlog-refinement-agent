import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Serves /config.json from .env.local during development only. Nothing from the
// environment is compiled into the bundle; deployments provide their own config.json.
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), devRuntimeConfig(env)],
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
    },
  };
});
