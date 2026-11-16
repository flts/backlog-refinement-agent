# backlog-api

FastAPI domain service for the backlog app: projects, members (by email), and — in later increments — items,
relationships, revisions, guidance, sources, events and the backlog MCP server. All routes are served under
`/api/backlog`; liveness and readiness probes are at `/healthz` and `/readyz` (also under the prefix).

## Run locally

Commands run from the repository root (uv workspace).

```bash
uv sync --all-packages
cp services/backlog-api/.env.example services/backlog-api/.env   # adjust database and Keycloak settings
uv run --package backlog-api uvicorn backlog_api.main:app --reload --port 8001
```

Under the Aspire AppHost the database (`ConnectionStrings__backlogdb`) and Keycloak (`services__keycloak__http__0`)
references are injected, so no `.env` is needed. OpenAPI docs: <http://localhost:8001/api/backlog/docs>.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BACKLOG_ENV` | `production` | `development`, `test` or `production` |
| `BACKLOG_DATABASE_URL` | — | PostgreSQL URI (`postgresql://…`); converted to `postgresql+asyncpg` |
| `ConnectionStrings__backlogdb` | — | Aspire connection string (ADO.NET `Host=…;Port=…;Username=…;Password=…;Database=…` or URI); used when `BACKLOG_DATABASE_URL` is unset. `BACKLOGDB_URI` is accepted too |
| `BACKLOG_AUTO_MIGRATE` | `true` in development | Run alembic migrations on startup (guarded by a Postgres advisory lock) |
| `BACKLOG_AUTH_MODE` | `jwt` | `jwt` validates bearer tokens; `dev` trusts `X-Dev-User-Email` and is refused unless `BACKLOG_ENV=development` |
| `BACKLOG_OIDC_ISSUER` | — | Token issuer, e.g. `http://localhost:8080/realms/backlog` |
| `BACKLOG_KEYCLOAK_URL` / `services__keycloak__http__0` / `KEYCLOAK_HTTP` | — | Keycloak base URL; issuer becomes `<url>/realms/<BACKLOG_OIDC_REALM>` when `BACKLOG_OIDC_ISSUER` is unset |
| `BACKLOG_OIDC_REALM` | `backlog` | Realm used with the Keycloak base URL |
| `BACKLOG_OIDC_AUDIENCE` | `backlog-api` | Required `aud` value |
| `BACKLOG_OIDC_JWKS_URL` | discovered | JWKS URL; default from `{issuer}/.well-known/openid-configuration` |
| `BACKLOG_OIDC_LEEWAY_SECONDS` | `60` | Clock skew for `exp`/`nbf`/`iat` |
| `BACKLOG_MAX_BODY_BYTES` | `1048576` | Request body limit (413 problem when exceeded) |
| `BACKLOG_REVISIONS_KEEP` | `50` | Item revisions kept per item |
| `BACKLOG_LOG_LEVEL` | `INFO` | JSON logs to stdout (no tokens or content) |
| `BACKLOG_EVENTS_HEARTBEAT_SECONDS` | `15` | SSE keepalive comment interval |
| `BACKLOG_EVENTS_RETENTION_SECONDS` / `BACKLOG_EVENTS_MAX_PER_PROJECT` | `86400` / `5000` | Resume window of the event log (age / events per project) |
| `BACKLOG_EVENTS_REPLAY_LIMIT` | `1000` | A larger gap makes the client `reset` instead of replaying |
| `BACKLOG_EVENTS_SUBSCRIBER_QUEUE_SIZE` | `256` | Per-stream buffer; slower clients are dropped and reconnect |
| `BACKLOG_EVENTS_RECHECK_SECONDS` / `BACKLOG_EVENTS_MAX_STREAM_SECONDS` | `60` / `900` | Membership re-check interval / maximum lifetime of one stream |
| `BACKLOG_EVENTS_TICKET_SECRET` | — | HMAC secret for stream tickets, shared by all replicas (production: tickets are disabled without it) |
| `BACKLOG_EVENTS_TICKET_TTL_SECONDS` | `60` | Stream ticket lifetime |
| `BACKLOG_PRESENCE_TTL_SECONDS` / `BACKLOG_PRESENCE_SWEEP_SECONDS` | `45` / `5` | Presence expiry / sweep interval |
| `BACKLOG_INTERNAL_CLIENT_IDS` | — | Comma-separated Keycloak client ids (`azp`/`client_id`) allowed on `/api/backlog/internal/*` |
| `BACKLOG_INTERNAL_TOKEN` | — | Static `X-Internal-Token` secret for `/internal/*` (refused in production) |

## Authentication and authorization

- Bearer JWTs are validated against the issuer's JWKS (cached; RS256/ES256 only; `iss`, `aud`, `exp`, `nbf` with
  60 s leeway). Missing or invalid tokens get `401` with `WWW-Authenticate: Bearer`.
- The principal is the **normalized, verified email** (`email.strip().lower()`); tokens without `email` or with
  `email_verified != true` get `403`. The `users` table is only a display-name directory.
- Project access is resolved per request in `backlog_api.authz` (`require_member`, `require_owner`). Non-members get
  `404`; contributors calling owner-only operations get `403` (`owner-required`).
- Members are added directly by email; access is immediate (no invitations). The last owner cannot be demoted,
  removed or leave (`409 last-owner`).

## Events, presence and the internal stream

- Routes publish domain events after commit. `PostgresEventPublisher` stores each event in `project_events` (its id is
  the SSE event id; pruned by age and per-project count) and sends `NOTIFY backlog_events`; each replica holds one
  `LISTEN` connection and fans out to bounded per-stream queues (a slow client is dropped and resumes with
  `Last-Event-ID`). Canonical types: `events.PROJECT_EVENT_TYPES` plus the transient `presence`, `reset`, `closed`.
- `GET /api/backlog/projects/{id}/events` (members): `text/event-stream`, blocks of
  `id: <n>` / `event: <type>` / `data: {id,type,projectId,actor,actorName?,data,at}`; `: keepalive` comments every 15 s;
  `Cache-Control: no-cache`, `X-Accel-Buffering: no`. Resume with `Last-Event-ID` or `?lastEventId=`; when the id is
  outside the retained window the server sends `event: reset` (refetch everything). A first `presence` event carries the
  current list. The stream ends with `event: closed` (`reason`: `member-removed`, `project-deleted`, `not-a-member`
  are final; `max-lifetime` means reconnect).
- Auth: `Authorization: Bearer` (fetch-based SSE client), or for `EventSource` a 60 s HMAC ticket from
  `POST /projects/{id}/events/ticket` → `{ticket, expiresAt}` used as `?ticket=` (bound to user and project; only
  accepted by the stream; the ticket is verified only when the stream opens).
- Presence: `POST /projects/{id}/presence {itemId?, state?: viewing|editing}` every ~20 s (TTL 45 s) returns the list;
  `GET` reads it; `DELETE` leaves. Changes (join, item/state change, leave, expiry) emit
  `presence {users:[{email,name,itemId,state}]}` on every replica (unlogged `presence` table + `NOTIFY`).
- `GET /api/backlog/internal/events` (not in OpenAPI) streams `project.deleted`, `member.removed`, `item.deleted` of all
  projects for agent-service, with the same `Last-Event-ID`/`reset` semantics. Auth: a client-credentials token whose
  `azp`/`client_id` is in `BACKLOG_INTERNAL_CLIENT_IDS`, or in development the `X-Internal-Token` header.
- Behind proxies disable buffering for these routes (Caddy `flush_interval -1`) and keep idle timeouts above the
  heartbeat.

## Database migrations

```bash
uv run --package backlog-api alembic -c services/backlog-api/alembic.ini upgrade head
uv run --package backlog-api alembic -c services/backlog-api/alembic.ini revision --autogenerate -m "add items"
```

Models live in `src/backlog_api/db/models.py`; migrations in `migrations/versions/`. `tests/test_migrations.py`
fails when models and migrations drift apart.

## Tests and checks

Integration tests start `pgvector/pgvector:pg17` with testcontainers (Docker required) or use
`BACKLOG_TEST_DATABASE_URL` (a disposable database).

```bash
uv run --package backlog-api pytest services/backlog-api -q
uv run ruff check services/backlog-api
uv run pyright services/backlog-api
```

## OpenAPI snapshot

```bash
uv run --package backlog-api python services/backlog-api/scripts/export_openapi.py          # writes contracts/openapi/backlog-api.json
uv run --package backlog-api python services/backlog-api/scripts/export_openapi.py --check  # CI: fails when outdated
```

## Container image

```bash
docker build -f services/backlog-api/Dockerfile -t backlog-api .   # build context = repository root
```

The image runs as a non-root user on port 8001 and includes the `skills/` directory (`BACKLOG_SKILLS_DIR`).
