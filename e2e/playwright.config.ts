import { defineConfig, devices } from '@playwright/test';
import { WEB_URL } from './support/env';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  // Every test creates its own uniquely named project and fake-gateway script, so spec files may run in parallel.
  fullyParallel: false,
  workers: Number(process.env.E2E_WORKERS ?? 2),
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: WEB_URL,
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', testIgnore: /restart\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } },
    // Restarts agent-service, so it must not overlap with the other specs.
    { name: 'restart', testMatch: /restart\.spec\.ts/, dependencies: ['chromium'], use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } },
  ],
});
