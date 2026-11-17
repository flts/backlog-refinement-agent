import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { WEB_URL } from './env';

const repoRoot = path.resolve(import.meta.dirname, '..');

/** Restarts one service of the Compose stack the tests run against (same files as the README: base + e2e override, `fake` profile). */
export function restartService(service: string): void {
  execFileSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'e2e/docker-compose.e2e.yml', '--profile', 'fake', 'restart', service], { cwd: repoRoot, stdio: 'inherit' });
}

/** Polls `url` until it answers 2xx. */
export async function waitForHealthy(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (cause) {
      last = String(cause);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${url} did not become healthy within ${timeoutMs} ms (${last}).`);
}

/** Restarts agent-service (its in-memory approvals are lost, its Postgres state stays) and waits until the proxy reaches it again. */
export async function restartAgentService(): Promise<void> {
  restartService('agent-service');
  await waitForHealthy(`${WEB_URL}/api/agent/readyz`);
}
