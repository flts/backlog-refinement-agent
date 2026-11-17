import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type FullConfig } from '@playwright/test';
import { FAKE_GATEWAY_URL, KEYCLOAK_URL, WEB_URL, users, type UserKey } from './support/env';
import { authFile, loginWithForm } from './support/login';

const repoRoot = path.resolve(import.meta.dirname, '..');

async function waitFor(name: string, url: string, init?: RequestInit, timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (cause) {
      last = String(cause);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${name} did not become healthy at ${url} (${last}). Start the stack: docker compose -f docker-compose.yml -f e2e/docker-compose.e2e.yml --profile fake up -d --build --wait (or run with E2E_COMPOSE=1).`);
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (process.env.E2E_COMPOSE === '1') {
    execFileSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'e2e/docker-compose.e2e.yml', '--profile', 'fake', 'up', '-d', '--build', '--wait'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }

  await waitFor('web', `${WEB_URL}/config.json`);
  await waitFor('keycloak', `${KEYCLOAK_URL}/realms/backlog/.well-known/openid-configuration`);
  await waitFor('fake gateway', `${FAKE_GATEWAY_URL}/healthz`);
  // The scripted-LLM control endpoint is off unless FAKE_GATEWAY_CONTROL=true (e2e/docker-compose.e2e.yml).
  await waitFor('fake gateway control endpoint', `${FAKE_GATEWAY_URL}/fake/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ match: '__e2e-probe__', responses: ['ok'] }),
  }, 10_000);

  // One real Keycloak login form per user. The SPA keeps its tokens in sessionStorage (not part of storageState), but the
  // Keycloak SSO cookies are: later contexts start from this state and complete the OIDC redirect without a form.
  mkdirSync(path.dirname(authFile('alice')), { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const user of Object.keys(users) as UserKey[]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(WEB_URL);
      await loginWithForm(page, user);
      await page.getByRole('button', { name: /^Account: / }).waitFor();
      await context.storageState({ path: authFile(user) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
