import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { localDevelopmentKey } from './src/infrastructure/llm/localDevelopmentKey';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react()],
    define: {
      'import.meta.env.LOCAL_LLM_API_KEY': JSON.stringify(
        localDevelopmentKey(command, mode, env),
      ),
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
    },
  };
});
