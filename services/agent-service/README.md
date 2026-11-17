# agent-service

FastAPI service that hosts the AG-UI agent endpoint (Microsoft Agent Framework), private agent threads and message
feedback. All routes are under `/api/agent`; probes are at `/healthz` and `/readyz` (also under the prefix).

| Route | Purpose |
|---|---|
| `GET /api/agent/agents`, `GET /api/agent/agents/{agentId}` | Agent catalogue `[{id, name, description, version}]` (version = `AGENT_BUILD_SHA` / git short sha / `dev`) and metadata (model, skills, tools, MCP servers, client tools) |
| `POST /api/agent/agents/{agentId}` | AG-UI run (SSE). `threadId` must be a thread of the caller; `state.projectId` / `state.itemId` must match it |
| `GET/POST /api/agent/threads`, `PATCH/DELETE /api/agent/threads/{id}` | Own threads (`GET ?projectId=&itemId=`); other users' threads are 404 |
| `POST /api/agent/feedback` | Thumbs up/down on a message (upsert per thread, message, user) |
| `GET /readyz` | Database, plus `llm: ok\|unavailable` (optionally required) |

## Run locally

```bash
uv sync --all-packages
cp services/agent-service/.env.example services/agent-service/.env
uv run --package agent-service uvicorn agent_service.main:app --reload --port 8002
```

Under the Aspire AppHost the database (`ConnectionStrings__agentdb`), Keycloak (`services__keycloak__http__0`) and
backlog-api (`services__backlog-api__http__0`) references are injected. OpenAPI docs: <http://localhost:8002/api/agent/docs>.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_ENV` | `production` | `development`, `test` or `production` |
| `AGENT_DATABASE_URL` / `ConnectionStrings__agentdb` / `AGENTDB_URI` | — | PostgreSQL URI or Aspire connection string for `agentdb` |
| `AGENT_AUTO_MIGRATE` | `true` in development | Run alembic on startup (guarded by a Postgres advisory lock) |
| `AGENT_AUTH_MODE` | `jwt` | `dev` trusts `X-Dev-User-Email`; refused unless `AGENT_ENV=development` |
| `AGENT_OIDC_ISSUER` / `AGENT_KEYCLOAK_URL` / `services__keycloak__http__0` | — | Token issuer (or Keycloak base URL + `AGENT_OIDC_REALM`, default `backlog`) |
| `AGENT_OIDC_AUDIENCE` | `agent-service` | Required `aud` |
| `AGENT_OIDC_JWKS_URL`, `AGENT_OIDC_LEEWAY_SECONDS` | discovered, `60` | JWKS override, clock skew |
| `AGENT_BACKLOG_API_URL` / `services__backlog-api__http__0` | — | backlog-api base URL (without `/api/backlog`) |
| `AGENT_LLM_BASE_URL` | — | OpenAI-compatible gateway; `/v1` is appended when missing |
| `AGENT_LLM_API` | `chat` | `chat` (`/v1/chat/completions`) or `responses` (`/v1/responses`) |
| `AGENT_LLM_MODEL` | `refiner-default` | Default model alias |
| `AGENT_LLM_API_KEY` | — | Gateway credential (secret) |
| `AGENT_LLM_REQUIRED_FOR_READINESS` | `false` | `/readyz` returns 503 while the gateway is unreachable |
| `AGENT_AGENTS_DIR` | `agents/` of the package | Directory with the `*.agent.md` definitions |
| `AGENT_TOOLS_FILE` | `tools/tools.yaml` of the package | MCP server bindings; `${VAR}` / `${VAR:-default}` are interpolated (`AGENT_BACKLOG_API_URL` resolves from settings) |
| `AGENT_SKILLS_DIR` / `BACKLOG_SKILLS_DIR` | repository `skills/` | Default skills directory |
| `AGENT_BUILD_SHA` | git short sha, else `dev` | Agent catalogue version |
| `AGENT_MAX_BODY_BYTES` / `AGENT_AGUI_MAX_BODY_BYTES` | 1 MiB / 2 MiB | Body limits (AG-UI runs have their own) |
| `AGENT_CORS_ALLOW_ORIGINS` | empty | Comma-separated origins; empty = same-origin through the proxy (MAF's `allow_origins` is a no-op) |
| `AGENT_EVENT_HOOKS_ENABLED` | `true` | Subscribe to backlog-api's `/api/backlog/internal/events` and purge private threads on `project.deleted`, `member.removed`, `item.deleted` |
| `AGENT_SERVICE_CLIENT_ID` / `AGENT_SERVICE_CLIENT_SECRET` | `agent-service` / — | Keycloak client-credentials for the hooks (token endpoint `<issuer>/protocol/openid-connect/token`, override `AGENT_SERVICE_TOKEN_URL`); secret |
| `AGENT_INTERNAL_TOKEN` | — | Dev only (refused when `AGENT_ENV=production`): static `X-Internal-Token` instead of Keycloak |
| `AGENT_LOG_LEVEL` | `INFO` | JSON logs (no content, no tokens) |

## Design notes

- **Identity:** the principal is the normalized verified email (403 without it); the AG-UI scope is `user:<email>`.
  The scope resolver binds the raw token and principal to context variables (`agent_service.auth.current_token()` /
  `current_principal()`) for the run; they are never logged or persisted.
- **AG-UI wiring:** `agents/endpoint.py` registers MAF's endpoint once on `/api/agent/agents/{agent_id}` with an
  `AgentDispatcher` runner. The `guard_agent_request` dependency checks agent id, thread ownership and state ids before
  MAF runs; the dispatcher delegates to `AgentRegistry.get(agent_id)`, maintains `threads.status` and refreshes it
  after each run and on hydrate. `require_confirmation=False`; snapshots live in `PgThreadSnapshotStore`.
- **Agent loader:** `agents/loader.py` builds one MAF `Agent` per `agents/*.agent.md` (YAML frontmatter + Markdown body
  = base instructions; see `agents/definition.py` for the fields) at startup; the default `registry_factory`.
  Context providers run in this order: `McpProvider` (per-run MCP connection with the caller's bearer token as a
  *static* header, only `allowed_tools` offered to the model; `hidden_tools` stay callable through
  `agent_service.mcp_client.current_mcp().call(...)` for agent tools), the skills provider (defaults from `skills/` +
  project overrides from MCP `get_project_guidance`, see `agents/skills.py`), then `context_providers:` from the
  definition (`item_context`, `intent`, see `agents/providers.py`). `StepEmittingRunner` closes the run's MCP
  connections and injects `STEP_STARTED/FINISHED` timeline rows. `ask_user` is declared by the SPA, never server-side.
  Agent tools are resolved by name in `agent_service.tools` (`ToolRegistry`, `default_tool_registry()`); the registry
  also supplies the function middleware (`tools/guard.py`) every agent is built with. With `AGENT_ENV=development`
  definitions, tools.yaml and skills reload on change.
- **Agent tools** (`agent_service/tools/`; model-facing descriptions and schemas come from `contracts/schemas`):
  - `propose_document_changes` / `propose_child_items` (`proposals.py`, `always_require`): predictive state fills
    `state.preview` / `state.childPreview` with the full arguments (`predict_state`, `argument: "*"`), the run ends with
    an interrupt, and the user approves (optionally with `editedArgs`, a FULL replacement of the arguments) or rejects.
    After approval the tool re-validates the returned arguments, loads the model's ORIGINAL arguments from the thread
    snapshot (`toolCalls` of the stored assistant message, read with the caller's scope; MAF gives the tool only the
    edited arguments) and requires the edits to be a subset: section ids / child proposal ids and relationships must
    exist in the proposal; `baseVersion` and `childType` are fixed; a section's `heading` and `mode` are fixed (only its
    Markdown may be edited); a child's title and Markdown may be edited; a dropped `suggestedTitle`/`suggestedStatus`
    is simply not applied but a new or changed one is an error. Accepted sections are classified `applied` (unchanged),
    `edited` (Markdown changed) and `rejected` (left out); `conflicted` comes from the backlog. The hidden MCP write
    tool (`apply_document_changes` / `create_child_items`) is called with the user's own token and the run id;
    relationships that touch a rejected child, or that the user removed, are skipped and reported. The result is the
    `document-changes.result` / `child-items.result` JSON (the model's tool result) and the state is updated:
    `preview` / `childPreview` -> `null`, `lastApply` (document changes; exactly `document-changes.result`).
    A rejection never runs the tool (MAF returns `Error: Tool call invocation was rejected by user.`); the runner
    (`StepEmittingRunner`) clears `preview` / `childPreview` in the request state of a resume that rejects.
  - `record_quality_assessment` (`assessment.py`): stores the assessment with the document hash of the run's cached
    `get_item_context` (a hash passed by the model is only a fallback), `set_item_quality`, and mirrors it into
    `state.quality` (`assessedAt` and `documentHash` added). A `stale-assessment` answer becomes an error that tells the
    model to re-read the item and assess again.
  - `suggest_next_actions` (`state.nextActions`, at most 3) and `set_session_title` (updates `threads.title` of the
    current thread, at most 60 characters; the tool reaches the database through `tools/services.py`, bound by the
    dispatcher).
  - **Validation retry cap** (`tools/guard.py`, `ToolInputGuard` function middleware): arguments are validated with the
    strict contract model and every failure (also `ToolInputError` raised by a tool body, e.g. a non-subset edit) is a
    concise `Error: invalid arguments for <tool>: <path: message>` tool result. After 2 failed attempts of the same tool
    in one run the result is final (`Do not call <tool> again in this turn; explain the problem to the user`) and later
    calls of that tool in the run are not executed. Counters live in the run's `RunMcpScope.cache`.
- **Approval state** is process-local in MAF (single replica or sticky routing by thread).
- **Event hooks:** `agent_service/hooks/` runs one background SSE subscriber (single replica). The last processed event
  id lives in `hook_cursor` (migration `0002_hook_cursor`) and is sent as `Last-Event-ID` after a restart; `reset` continues
  from the reset id (purges are idempotent). Reconnects use backoff with jitter; a 401/403 refreshes the token once.
  Disabled (warning once) without a credential; `/readyz` reports `hooks`: `connected` / `disconnected` / `disabled`
  and never fails because of it.
- **Purge:** `agent_service.threads.purge_threads(session, project_id=, item_id=, owner_email=)` for the event hooks.

## Migrations, tests, image

```bash
uv run --package agent-service alembic -c services/agent-service/alembic.ini upgrade head
uv run --package agent-service pytest services/agent-service -q     # Docker (pgvector/pgvector:pg17) or AGENT_TEST_DATABASE_URL
uv run ruff check services/agent-service && uv run pyright services/agent-service
docker build -f services/agent-service/Dockerfile -t agent-service .   # build context = repository root
```

`tests/fakes/fake_gateway.py` is a scripted OpenAI-compatible gateway and `tests/fakes/fake_mcp.py` a fake backlog MCP
server (contract-shaped, records tokens and calls) used by the tests (test-local).
