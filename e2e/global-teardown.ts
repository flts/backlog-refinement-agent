import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default function globalTeardown(): void {
  if (process.env.E2E_COMPOSE === '1' && process.env.E2E_COMPOSE_DOWN === '1') {
    execFileSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'e2e/docker-compose.e2e.yml', '--profile', 'fake', 'down', '-v'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      stdio: 'inherit',
    });
  }
}
