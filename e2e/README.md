# End-to-end tests (`@backlog/e2e`)

Playwright (Chromium) tests against the full Docker Compose stack: Keycloak (real login form, Authorization Code + PKCE),
backlog-api, agent-service, the Caddy-served SPA at `http://localhost:8088` and the scripted fake LLM gateway.

## Run

```bash
pnpm install
pnpm --filter @backlog/e2e exec playwright install chromium      # once

# 1. Start the stack. The override publishes the fake gateway (:8090) and enables its control endpoint.
docker compose -f docker-compose.yml -f e2e/docker-compose.e2e.yml --profile fake up -d --build --wait

# 2. Run the tests (root script: `pnpm e2e`)
pnpm --filter @backlog/e2e test
pnpm --filter @backlog/e2e test agent        # one spec file
pnpm --filter @backlog/e2e test:headed

# 3. Tear down
docker compose -f docker-compose.yml -f e2e/docker-compose.e2e.yml --profile fake down -v
```

`E2E_COMPOSE=1 pnpm e2e` lets the global setup run step 1 itself (add `E2E_COMPOSE_DOWN=1` to run step 3 afterwards).
Other variables: `E2E_WEB_URL` (default `http://localhost:8088`), `E2E_KEYCLOAK_URL` (`http://localhost:8080`, must equal the
pinned token issuer), `E2E_FAKE_GATEWAY_URL` (`http://localhost:8090`), `E2E_WORKERS` (default 2).
`deploy/compose-smoke.sh` still works against the same stack (the fake gateway echoes when no script matches).

## How it works

- **Users:** `alice` (owner), `bob` (contributor), `carol` (outsider), password `dev-password` (see `deploy/keycloak/README.md`).
- **Login:** global setup performs the real Keycloak login form once per user and saves `storageState` to `e2e/.auth/` (git-ignored).
  The SPA keeps its tokens in `sessionStorage`, which `storageState` does not capture, but the Keycloak SSO *cookies* are. Each test
  context starts from them, so the SPA's OIDC redirect completes silently. `openAs()` in `support/fixtures.ts` falls back to the form.
- **Isolation:** every test creates a uniquely named project through the API (as the owner, with the dev-only `backlog-dev-cli`
  password grant) and deletes it afterwards. Specs run with 2 workers and do not depend on each other.
- **Scripted LLM:** `POST /fake/script {"match": "<marker>", "responses": [...]}` (enabled by `FAKE_GATEWAY_CONTROL=true`) registers a
  script for requests whose messages contain the marker. Each test puts a unique marker into its user message, so tests never consume
  each other's responses. Tool calls must satisfy the agent-service schemas: `propose_document_changes` needs `baseVersion` = the item
  version (a fresh item is version 1; a stale version only yields `conflicted` sections), `ask_user` needs 1–3 questions with options.

## Scenarios

| Spec | Covers |
|---|---|
| `smoke.spec.ts` | Keycloak login → project and item visible |
| `share.spec.ts` | alice shares via the Share dialog; bob sees it, project settings (templates) are read-only for him; carol sees nothing |
| `collaboration.spec.ts` | presence avatars + live update ("Updated by Alice Owner"); concurrent edit → conflict dialog → "Both" |
| `agent.spec.ts` | `ask_user` (keyboard + click) → review → partial accept → History "Via agent"; breakdown accept 1 of 2; pending `ask_user` survives reload; bob cannot see alice's session |
| `restart.spec.ts` | agent-service restart during review (`docker compose restart agent-service`, Compose stack only): the recovery card keeps the edited section and re-proposes it. With `E2E_DURABLE_APPROVALS=1` (stack with durable server-side approvals) the same approval must instead succeed after the restart. Runs in its own Playwright project after the other specs (a restart would break their runs) |

Failures keep a screenshot and trace in `e2e/test-results/` (`pnpm exec playwright show-trace <trace.zip>`).
