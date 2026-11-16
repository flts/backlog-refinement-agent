# Backlog Refinement Agent

A local-first React and TypeScript workspace for creating, refining, and decomposing Capabilities, Features, User Stories, and Enablers. Backlog items, relationships, refinement conversations, settings, and templates are stored in browser IndexedDB; the app has no application backend or account system.

## Projects and backups

Create a project before adding backlog items. Each project has its own backlog, relationships, refinement sessions and sources. The selected project is remembered locally across reloads and browser sessions; if it no longer exists, another available project is selected. Project deletion removes all of these after confirmation. The refinement workspace lets you select or delete a session without deleting its item or previously accepted changes; after deletion the most recent remaining session opens, or a fresh one is created. Use the status controls to move an item back to Refining or forward to Ready. Resolving a question or assumption does not itself change status; an accepted AI assessment can suggest a status change.

Add PDF or UTF-8 text files, or save an HTTP(S) URL reference with optional pasted text. PDFs must contain selectable text; scanned PDFs require OCR and are not supported. File input is limited to 10 MiB, 200 PDF pages and 1,000,000 characters of extracted text. Fetching a URL is explicit and requires the destination's CORS permission; if it fails, paste the text instead. Browser fetch defaults apply: same-origin credentials may be sent. Fetched HTML is read as static text, not executed.

Sources start unselected. Select project sources to include them in refinement, decomposition and quality-assessment requests; the workspace displays the configured AI endpoint. Selected source content is sent to that endpoint along with the item and related context. No other project's sources are sent. The combined selected text is limited to 100,000 characters; deselect sources if it exceeds the limit.

Export a complete project to a JSON backup, including original files, source text, backlog items, relationships and session history. Import creates a project; if its ID already exists, choose a separate copy or confirm replacement. Project backups are limited to 50 MiB and do not contain application-wide settings or LLM connection overrides. Configuration import/export remains separate. Backups may contain sensitive project content, so handle them accordingly.

Data is local to this browser and origin, not synchronized across devices. Browser storage has quotas and can be cleared or evicted, so export backups regularly. AI requests still require a separately configured endpoint.

**Upgrade:** This version does not migrate old backlog data. When existing data is detected, the app asks for confirmation before permanently discarding old items, relationships and sessions; valid current-format settings and local connection overrides are retained. Older configuration formats and placeholder templates are not supported.

## Run locally

Requires Node.js 22.12+ and pnpm. Use pnpm for installing and running package scripts.

```sh
pnpm install
pnpm dev
```

Run checks with `pnpm test` and `pnpm build`.

## Runtime configuration, sign-in and API routing

The web app is online-only and calls two backend services on the same origin: `/api/backlog` (backlog-api) and `/api/agent` (agent-service, AG-UI). The browser never talks to an LLM directly.

Nothing from the environment is compiled into the bundle. The app reads `/config.json` at startup and blocks with an error screen when it is unreachable or invalid:

```json
{ "auth": { "mode": "oidc", "authority": "http://localhost:8080/realms/backlog", "clientId": "backlog-web", "scope": "openid profile email" },
  "api": { "backlog": "/api/backlog", "agent": "/api/agent" }, "agentId": "backlog-refiner" }
```

- `auth.mode = "oidc"`: the app signs in with Authorization Code + PKCE (oidc-client-ts) against `authority`; tokens live in `sessionStorage` only and are renewed with refresh tokens. `authority` and `clientId` are required.
- `auth.mode = "platform"`: the platform gateway authenticates the browser and injects the bearer token. The app sends no token, reads the user from `GET /api/backlog/me` and performs one full page reload on a 401 so the gateway can re-authenticate (guarded against reload loops).

**Development:** copy `apps/web/.env.example` to `apps/web/.env.local`. The Vite dev server serves `/config.json` from `AUTH_MODE`, `OIDC_AUTHORITY` (default `http://localhost:8080/realms/backlog`), `OIDC_CLIENT_ID`, `OIDC_SCOPE` and `AGENT_ID`, and proxies `/api/backlog` to `BACKLOG_API_URL` (default `http://localhost:8001`) and `/api/agent` to `AGENT_API_URL` (default `http://localhost:8002`); Aspire's `services__backlog-api__http__0` and `services__agent-service__http__0` are used when those are unset. Restart the dev server after changing it. Dev users: `alice`, `bob`, `carol` (`@example.test`, password `dev-password`, see `deploy/keycloak/README.md`).

**Docker/Caddy:** the `Dockerfile` builds the app and serves it with Caddy. The `Caddyfile` generates `/config.json` per request from the container's environment (`AUTH_MODE` default `oidc`, `OIDC_AUTHORITY`, `OIDC_CLIENT_ID` default `backlog-web`, `OIDC_SCOPE` default `openid profile email`, `AGENT_ID` default `backlog-refiner`; also `PORT`, default 8080), reverse-proxies `/api/backlog/*` to `BACKLOG_API_URL` and `/api/agent/*` to `AGENT_API_URL` with response buffering disabled (SSE) and 300 s timeouts, and sets a Content-Security-Policy that allows `connect-src`/`frame-src` for the `OIDC_AUTHORITY` origin. One image works for every deployment:

```sh
docker build -f apps/web/Dockerfile -t backlog-web .
docker run -p 8080:8080 -e OIDC_AUTHORITY=http://localhost:8080/realms/backlog -e BACKLOG_API_URL=http://host.docker.internal:8001 -e AGENT_API_URL=http://host.docker.internal:8002 backlog-web
```

Values must not contain double quotes or backslashes (they are inserted into JSON verbatim). Caddy reads the variables when it loads the Caddyfile, so changing a value requires restarting the container or rolling the pods.

Until the API client lands, projects and items are still stored in the browser (IndexedDB) and sending a message to the agent only shows "The agent is being connected".

Agent instructions and Markdown templates can be exported and imported as JSON under Settings > Backup. Exports contain saved settings, not unsaved edits; imports replace saved settings and discard unsaved Settings edits. Default templates are Markdown files under `src/defaults/templates/`; the base refinement principles and per-type instructions are Markdown files under `src/defaults/instructions/`. User edits to templates, principles and type instructions are saved in IndexedDB (configuration export format version 4 only) and can be reset to the source files. The agent is given the user's saved template for an item type verbatim. Templates are plain Markdown (headings plus `<!-- hint -->` comments, no placeholders): each item stores one Markdown document and the agent decides what to fill in. The agent returns only per-section updates, which the app merges so untouched sections stay byte-identical; confirmed `- [x]` items are never dropped, and the last 10 versions are kept with an “Undo last AI change” button. Sections titled “Assumptions” / “Open questions” (`- [ ]` task lists) get confirm/reject/resolve buttons. “Break this down” gives the model the template of the requested child type and pre-fills each proposed child (including assumptions and open questions); the app then rebuilds every child description on that template's headings, keeping any extra content under “Additional notes”. Refinement sessions and accepted backlog changes remain local and survive reloads; generated child items are only persisted after explicit acceptance.
