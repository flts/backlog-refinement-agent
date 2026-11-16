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
| `BACKLOG_BACKUP_MAX_BYTES` | `52428800` | Maximum size of a project backup: export answers 413 `backup-too-large`, the import body limit is 413 `payload-too-large` |
| `BACKLOG_LOG_LEVEL` | `INFO` | JSON logs to stdout (no tokens or content) |

## Authentication and authorization

- Bearer JWTs are validated against the issuer's JWKS (cached; RS256/ES256 only; `iss`, `aud`, `exp`, `nbf` with
  60 s leeway). Missing or invalid tokens get `401` with `WWW-Authenticate: Bearer`.
- The principal is the **normalized, verified email** (`email.strip().lower()`); tokens without `email` or with
  `email_verified != true` get `403`. The `users` table is only a display-name directory.
- Project access is resolved per request in `backlog_api.authz` (`require_member`, `require_owner`). Non-members get
  `404`; contributors calling owner-only operations get `403` (`owner-required`).
- Members are added directly by email; access is immediate (no invitations). The last owner cannot be demoted,
  removed or leave (`409 last-owner`).

## Project backup

Owners export a project with `GET /api/backlog/projects/{id}/backup` (JSON attachment, format
`backlog-project-backup` v2: project name, guidance overrides, items with revisions, relationships, sources with
base64 original files; no members, conversations, audit log or search indexes). Any verified user imports a backup with
`POST /api/backlog/projects/import` (`application/json`); the whole document is validated (422 `invalid-backup` with
`issues`, 422 `unsupported-format`) and a **new** project owned by the importer is created in one transaction
(" (imported)" is appended when the importer already has a project of that name). Source and item indexing jobs are
queued. The SPA's v1 export (`backlog-refinement-project`) is accepted and mapped (see `backlog_api/backup.py`).

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
