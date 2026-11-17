export const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:8088';
/** Must be the URL the token issuer is pinned to (KC_HOSTNAME). */
export const KEYCLOAK_URL = process.env.E2E_KEYCLOAK_URL ?? 'http://localhost:8080';
/** The fake gateway's control port (published by e2e/docker-compose.e2e.yml). */
export const FAKE_GATEWAY_URL = process.env.E2E_FAKE_GATEWAY_URL ?? 'http://localhost:8090';
export const PASSWORD = 'dev-password';

export const users = {
  alice: { email: 'alice@example.test', name: 'Alice Owner' },
  bob: { email: 'bob@example.test', name: 'Bob Contributor' },
  carol: { email: 'carol@example.test', name: 'Carol Outsider' },
} as const;

export type UserKey = keyof typeof users;
