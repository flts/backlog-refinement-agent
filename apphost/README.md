# Aspire AppHost (local dev loop)

`apphost/apphost.mts` is an [Aspire](https://aspire.dev) TypeScript AppHost. It starts the whole
stack locally: PostgreSQL with pgvector, Keycloak, an optional fake LLM gateway, both Python
services and the Vite dev server. It also gives you the Aspire dashboard for logs, traces and
metrics.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Aspire CLI | `17.1.0-preview` (`daily` channel, pinned in `aspire.config.json`) | `curl -sSL https://aspire.dev/install.sh \| bash -s -- --quality dev` (see [aspire.dev](https://aspire.dev/get-started/install-cli/)) |
| Node.js | 22.12+ | runs the AppHost (`tsx`) and Vite |
| pnpm | 12 (see root `packageManager`) | `corepack enable` |
| uv | 0.9+ | installs and runs the Python services |
| Docker | Docker Desktop, OrbStack or Podman | runs PostgreSQL and Keycloak |

The generated TypeScript SDK (`.aspire/modules/`) and `node_modules/` are not committed. `aspire run`
restores both automatically; `pnpm --dir apphost restore` (`aspire restore`) does it explicitly, for
example before running `tsc`.

## Run

```bash
pnpm dev                 # from the repo root, same as: cd apphost && aspire run
```

The dashboard URL (with a login token) is printed on startup. Stop with `Ctrl+C`.

Background mode, useful for scripts and agents:

```bash
cd apphost
aspire start --non-interactive          # returns once the AppHost is up; prints the dashboard URL
aspire wait backlog-api --status healthy --timeout 300
aspire describe                          # resources, state, URLs, environment
aspire logs backlog-api
aspire stop
```

Other scripts in `apphost/package.json`: `pnpm build` (type-check and emit to `dist/`),
`pnpm typecheck`, `pnpm lint`, `pnpm restore`.

## Resources and ports

```text
postgres (pgvector/pgvector:pg17, data volume) ── backlogdb, agentdb
keycloak :8080 (data volume, realm import ../deploy/keycloak/realms)
fake-gateway :8090 (optional, ../deploy/fake-gateway)
backlog-api :8001   → backlogdb, keycloak, [fake-gateway]
agent-service :8002 → agentdb, keycloak, backlog-api, [fake-gateway]
web :5173           → backlog-api, agent-service (Vite proxies /api/backlog and /api/agent)
```

| Resource | URL | Health |
|---|---|---|
| `web` | <http://localhost:5173> | — |
| `backlog-api` | <http://localhost:8001> | `/healthz` |
| `agent-service` | <http://localhost:8002> | `/healthz` |
| `keycloak` | <http://localhost:8080> (realm `backlog`) | management `/health/ready` |
| `fake-gateway` | <http://localhost:8090> | `/healthz` |
| `postgres` | random host port (see dashboard) | TCP |
| dashboard | <https://localhost:17235> | — |

Ports are fixed so the OIDC issuer, Keycloak redirect URIs and the Vite proxy targets are stable.
Everything runs over plain HTTP (`withoutHttpsCertificate()`); only the dashboard uses HTTPS.

Each Python service gets an `*-installer` resource that runs `uv sync --all-packages --inexact` in
the shared uv workspace venv (`<repo>/.venv`). The fake gateway is a standalone uv project with its
own `deploy/fake-gateway/.venv`. `web` gets a `web-installer` that runs `pnpm install`.

## Environment contract

Aspire also injects the standard reference variables for every `withReference`, for example
`ConnectionStrings__backlogdb`, `BACKLOGDB_URI` / `BACKLOGDB_HOST` / `BACKLOGDB_PORT` /
`BACKLOGDB_USERNAME` / `BACKLOGDB_PASSWORD` / `BACKLOGDB_DATABASENAME`, `services__keycloak__http__0`,
`KEYCLOAK_HTTP`, `services__backlog-api__http__0` and `BACKLOG_API_HTTP`. `PORT` is the port the
process listens on (uvicorn and Vite receive it as `--port`), plus the OpenTelemetry `OTEL_*` variables.

**Telemetry**: `addUvicornApp` already calls `withOtlpExporter()` itself, so `backlog-api` and `agent-service` receive
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` (no
AppHost code needed). The services honour these standard variables (`services/*/src/*/telemetry.py`) and send traces,
metrics and logs to the Aspire dashboard; without an endpoint telemetry is off. Aspire's development-only
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` is deliberately not honoured: message content in telemetry is only
enabled with `AGENT_LOG_CONTENT=true` on agent-service.

**backlog-api**

| Variable | Value |
|---|---|
| `BACKLOG_ENV` | `development` |
| `BACKLOG_OIDC_ISSUER` | `http://localhost:8080/realms/backlog` |
| `BACKLOG_OIDC_AUDIENCE` | `backlog-api` |
| `BACKLOG_INTERNAL_CLIENT_IDS` | `agent-service` (client allowed on `/api/backlog/internal/*`) |
| `BACKLOG_LLM_BASE_URL` | parameter `llm-base-url` |
| `BACKLOG_LLM_API_KEY` | parameter `llm-api-key` |
| `BACKLOG_EMBEDDING_MODEL` | parameter `embedding-model` |
| `BACKLOG_EMBEDDING_DIM` | parameter `embedding-dim` |
| `BACKLOG_SKILLS_DIR` | absolute path of `<repo>/skills` |
| `BACKLOG_AUTO_MIGRATE` | `true` |
| `ConnectionStrings__backlogdb`, `BACKLOGDB_*` | database reference |

**agent-service**

| Variable | Value |
|---|---|
| `AGENT_ENV` | `development` |
| `AGENT_OIDC_ISSUER` | `http://localhost:8080/realms/backlog` |
| `AGENT_OIDC_AUDIENCE` | `agent-service` |
| `AGENT_SERVICE_CLIENT_ID` | `agent-service` (Keycloak service account for the internal event stream) |
| `AGENT_SERVICE_CLIENT_SECRET` | parameter `agent-service-client-secret` |
| `AGENT_BACKLOG_API_URL` | `http://localhost:8001` |
| `AGENT_LLM_BASE_URL` | parameter `llm-base-url` |
| `AGENT_LLM_API_KEY` | parameter `llm-api-key` |
| `AGENT_LLM_MODEL` | parameter `llm-chat-model` |
| `AGENT_SKILLS_DIR` | absolute path of `<repo>/skills` |
| `AGENT_AUTO_MIGRATE` | `true` |
| `ConnectionStrings__agentdb`, `AGENTDB_*` | database reference |

**web** (read by `apps/web/vite.config.ts`)

| Variable | Value |
|---|---|
| `BACKLOG_API_URL` | `http://localhost:8001` (proxy target for `/api/backlog`) |
| `AGENT_API_URL` | `http://localhost:8002` (proxy target for `/api/agent`) |
| `AUTH_MODE` | `oidc` |
| `OIDC_AUTHORITY` | `http://localhost:8080/realms/backlog` |
| `OIDC_CLIENT_ID` | `backlog-web` |

**fake-gateway**: `FAKE_EMBEDDING_DIM` (= `embedding-dim`), `FAKE_GATEWAY_MODELS`
(= `llm-chat-model,embedding-model`) and, when configured, `FAKE_GATEWAY_SCRIPT`.

## Parameters and pointing at a real LLM gateway

| Parameter | Default | Purpose |
|---|---|---|
| `llm-base-url` | `http://localhost:8090` (fake-gateway) | Base URL of an OpenAI-compatible gateway |
| `llm-api-key` (secret) | `dev-fake-key` | Gateway API key |
| `llm-chat-model` | `reasoning-large` | Chat/reasoning model for the agent |
| `embedding-model` | `text-embedding` | Embedding model |
| `embedding-dim` | `1536` | Embedding dimension; must match the model and the pgvector column |
| `agent-service-client-secret` (secret) | `dev-agent-service-secret` | Secret of the Keycloak `agent-service` client (matches the dev realm import) |

The base URL is passed through unchanged. The fake gateway answers both with and without a `/v1`
prefix, so use the form your gateway documents (for example `https://llm.example.com/v1`).

Values come from the AppHost configuration key `Parameters:<name>`. Set them with user secrets,
which are kept outside the repository and survive restarts:

```bash
cd apphost
aspire secret set Parameters:llm-base-url https://llm.example.com/v1
aspire secret set Parameters:llm-api-key  <key>
aspire secret set Parameters:llm-chat-model <model>
aspire secret list
aspire secret delete Parameters:llm-base-url    # back to the fake gateway
```

For a single run, use environment variables: `Parameters__llm_base_url=... pnpm dev` (`-` may be
written as `_`; `env 'Parameters__llm-base-url=...' pnpm dev` also works).

The `fake-gateway` resource is added only when `llm-base-url` is **not** configured. Set
`USE_FAKE_GATEWAY=true` or `false` (environment or `aspire secret set USE_FAKE_GATEWAY true`) to force
it on or off.

### Fake gateway scripts

The fake gateway (`deploy/fake-gateway`) is deterministic. It lists the configured models, returns
hash-based embeddings and echoes the last user message as the chat answer. To replay a fixed
conversation (text and/or tool calls, served in order and cycling), point `FAKE_GATEWAY_SCRIPT` at a
JSON file. Relative paths are resolved from the repo root:

```bash
FAKE_GATEWAY_SCRIPT=deploy/fake-gateway/script.example.json pnpm dev
```

`POST http://localhost:8090/fake/reset` rewinds the script. Run its tests with
`uv run --project deploy/fake-gateway pytest deploy/fake-gateway`.

## Keycloak

- Realm `backlog`, issuer `http://localhost:8080/realms/backlog`, SPA client `backlog-web`
  (PKCE) and the dev-only password-grant client `backlog-dev-cli`. See
  [`deploy/keycloak/README.md`](../deploy/keycloak/README.md).
- Test users (password `dev-password`): `alice@example.test` (owner), `bob@example.test`
  (contributor), `carol@example.test` (not a member), `dave@example.test` (unverified email, rejected).
- Admin console: <http://localhost:8080/admin>, user `admin`. Aspire generates the password and
  stores it in user secrets: `cd apphost && aspire secret get Parameters:keycloak-password`.
- The PostgreSQL password is generated the same way (`Parameters:postgres-password`). Keep it:
  the data volume is initialised with it.
- Keycloak keeps its data (realm, users, sessions and changes made in the admin console) in a
  named volume, so sign-ins and admin changes survive an AppHost restart. The `backlog` realm is
  imported only on the first start, while the volume is empty.

## Troubleshooting

- **Realm changes are not picked up.** Keycloak imports the realm with `IGNORE_EXISTING`, and the
  realm already exists in Keycloak's data volume after the first run. To apply changes from
  `deploy/keycloak/realms/backlog-realm.json`, stop the AppHost and delete the volume
  (`docker volume ls | grep keycloak-data`, then `docker volume rm <name>`), or change the realm in
  the admin console. Deleting the volume also resets users, sessions and admin changes. If you
  delete the secret `Parameters:keycloak-password`, delete the volume too; the admin user is
  created with that password when the volume is initialised.
- **Login fails with "Invalid redirect URI".** `backlog-web` allows ports 5173, 4173, 8080 and
  8088 only. Keep `web` on 5173, or add the URL to `deploy/keycloak/realms/backlog-realm.json`
  and restart.
- **Port already in use** (8080, 8001, 8002, 5173, 8090). Stop the other process
  (`lsof -nP -iTCP:<port> -sTCP:LISTEN`) or a previous AppHost (`aspire stop --all`).
- **Reset the database.** Stop the AppHost and remove the volume:
  `docker volume ls | grep postgres-data`, then `docker volume rm <name>`. If you also delete the
  secret `Parameters:postgres-password`, delete the volume too; otherwise authentication fails.
- **`ERR_PNPM_IGNORED_BUILDS` for esbuild.** The AppHost is a standalone pnpm project; Aspire
  installs it with `pnpm install --ignore-workspace`. pnpm 11+ blocks esbuild's postinstall unless
  allowed. `aspire.config.json` sets `PNPM_CONFIG_ALLOW_BUILDS` for `aspire run`, and
  `apphost/pnpm-workspace.yaml` allows it for a plain `pnpm install` in this folder. If `aspire
  restore` prints the error, prefix it with `PNPM_CONFIG_ALLOW_BUILDS='{"esbuild":true}'`.
- **A Python service fails in its `*-installer`.** Run `uv sync --all-packages` at the repo root to
  see the error. The AppHost expects packages `backlog_api` and `agent_service` with a FastAPI `app`
  in `<package>/main.py`.
- **HTTPS.** Aspire may switch resources to HTTPS when a trusted dev certificate exists. The AppHost
  opts out (`withoutHttpsCertificate()`) for Keycloak, the Python services and the fake gateway, so
  issuer and URLs stay `http://localhost:*`.
