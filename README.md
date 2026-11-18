# Backlog Refinement Agent

A shared workspace for creating, refining and decomposing Capabilities, Features, User Stories and Enablers together with an LLM agent. Each backlog item is one Markdown document. The agent asks focused follow-up questions, proposes changes section by section, and you review every proposal before anything is applied.

## Features

- **Agent refinement with follow-up questions.** The agent (`backlog-refiner`, AG-UI over SSE) reads the item, its relationships and your sources, then uses `ask_user` to ask 1–3 questions with suggested answers (a recommended option, free text, multi-select, skip). Answer with the mouse or the keys `1`–`5`, `Enter` and `Esc`.
- **Review with track changes.** Proposed document changes and child items stream in as live track changes. Accept, edit or reject each section or child; the server applies only what you approved and merges section by section (confirmed `- [x]` items are never dropped). Conflicts with edits by others are resolved per section.
- **Break-down, continue and quality assessment.** `/break-down`, `/continue` and `/assess` (or the ⌘K / Ctrl+K palette) run the agent with a specific intent; quality is stored with the item and shown stale after edits.
- **Sharing.** Owners add people by email, as owner or contributor, with immediate access (no invitations). Everyone sees live updates and who is viewing what; refinement sessions stay private to their creator.
- **Sources.** Upload PDF/text files, fetch a URL or paste text. Sources can be pinned (sent in full, within a budget), searchable (hybrid vector + full-text retrieval with citations) or excluded.
- **History and backups.** Every change is a revision (manual, agent or restore) that you can compare and restore. Owners can export and import a whole project and the project's guidance.
- **Project guidance.** Default principles, per-type instructions and templates are Agent Skills in `skills/`; owners can override them per project.

## Quick start

Requires Node.js 22.12+, pnpm, [uv](https://docs.astral.sh/uv/), Docker and the Aspire CLI (see `apphost/README.md`).

```sh
pnpm install
uv sync --all-packages
pnpm dev        # Aspire AppHost: Postgres, Keycloak, fake LLM gateway, both services, Vite (http://localhost:5173)
```

Sign in as `alice@example.test` (also `bob`, `carol`; password `dev-password`). By default the AppHost starts a scripted fake LLM gateway; set the `llm-base-url` parameter (and `llm-api-key`, `llm-chat-model`, `embedding-model`, `embedding-dim`) to use a real OpenAI-compatible gateway, see `apphost/README.md`. `pnpm dev:web` runs only the Vite dev server against services that are already running (copy `apps/web/.env.example` to `apps/web/.env.local`).

### Docker Compose

```sh
docker compose --profile fake up -d --build --wait   # with the scripted fake gateway
docker compose up -d --build --wait                  # real gateway: set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL in .env
deploy/compose-smoke.sh                              # end-to-end curl/jq check
docker compose --profile fake down -v                # stop and delete the data
```

Open <http://localhost:8088>. Keycloak is at <http://localhost:8080> (admin `admin` / `dev-admin-password`). `.env.example` documents all settings; every secret there is a **dev-only default**.

### Kubernetes

Kustomize manifests with Istio (mTLS, JWT validation) are in `deploy/k8s`; see `deploy/k8s/README.md` for prerequisites, secrets and the Keycloak client setup. Postgres (with `vector` and `citext`), Keycloak and the LLM gateway are external.

## Configuration

- **Web (runtime, never bundled):** `/config.json` = `{ auth: { mode, authority, clientId, scope }, api: { backlog, agent }, agentId }`. In containers Caddy builds it from `AUTH_MODE` (`oidc` or `platform`), `OIDC_AUTHORITY`, `OIDC_CLIENT_ID`, `OIDC_SCOPE`, `AGENT_ID` and proxies `/api/backlog` and `/api/agent` to `BACKLOG_API_URL` and `AGENT_API_URL`. In `oidc` mode the SPA signs in with Authorization Code + PKCE; in `platform` mode the gateway authenticates and injects the bearer token.
- **backlog-api:** `BACKLOG_*` variables (database, Keycloak/OIDC, limits, embeddings, events); see `services/backlog-api/README.md` and `.env.example`.
- **agent-service:** `AGENT_*` variables (database, OIDC, backlog-api URL, LLM gateway `AGENT_LLM_BASE_URL` / `AGENT_LLM_MODEL` / `AGENT_LLM_API_KEY`); see `services/agent-service/README.md`.
- **Compose:** `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `EMBEDDING_MODEL`, `EMBEDDING_DIM`, `APP_ENV` and the dev secrets in `.env.example`.
- Both services export OpenTelemetry through the standard `OTEL_*` environment variables, rate-limit agent runs per user, time runs out after 180 s and allow one active run per thread.

## Tests and checks

```sh
pnpm test            # web unit and component tests (Vitest, axe)
pnpm typecheck && pnpm build
pnpm test:py         # Python services and libs (needs Docker for the Postgres testcontainers)
pnpm lint:py         # ruff
pnpm e2e             # Playwright against the Compose stack with e2e/docker-compose.e2e.yml (see e2e/README.md)
```

## Documentation

- [`docs/architecture.md`](docs/architecture.md): architecture, data model, AG-UI contract, security and operations
- [`docs/accessibility.md`](docs/accessibility.md): WCAG 2.2 AA measures and test protocol
- [`contracts/README.md`](contracts/README.md), [`skills/README.md`](skills/README.md), [`apphost/README.md`](apphost/README.md), [`deploy/k8s/README.md`](deploy/k8s/README.md), [`deploy/keycloak/README.md`](deploy/keycloak/README.md)
- Service READMEs: [`services/backlog-api`](services/backlog-api/README.md), [`services/agent-service`](services/agent-service/README.md)
- [`AGENTS.md`](AGENTS.md): rules for contributors and coding agents
