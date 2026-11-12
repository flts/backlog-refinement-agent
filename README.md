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

## Configure the LLM proxy

Copy `.env.example` to `.env.local` for local development:

```sh
cp .env.example .env.local
```

Nothing from the environment is compiled into the bundle. The app reads its defaults at runtime from `/config.json` at the origin root, independent of any app subpath (`{ "endpoint": "...", "model": "...", "streaming": false }`). In development the Vite server generates `/config.json` from `.env.local` (`LLM_ENDPOINT`, `LLM_MODEL`, `LLM_STREAMING`, and the development-only `LOCAL_LLM_API_KEY`); restart the dev server after changing it. In production, the host must serve `/config.json` from its runtime configuration; the Caddy container below uses container environment variables. The endpoint can be an absolute HTTP(S) URL (for example `https://proxy.example`) or a root-relative same-origin path such as `/api`. The app appends `/v1/chat/completions` and `/v1/models` itself; relative paths resolve against the origin only, not the current app path.

**Docker/Caddy:** the `Dockerfile` builds the app and serves it with Caddy. The `Caddyfile` generates `/config.json` per request from the container's runtime environment variables `LLM_ENDPOINT`, `LLM_MODEL` and `LLM_STREAMING` (also `PORT`, default 8080), so one image works for every deployment:

```sh
docker build -t backlog-refinement-agent .
docker run -p 8080:8080 -e LLM_ENDPOINT=https://proxy.example -e LLM_MODEL=my-model backlog-refinement-agent
```

`LLM_ENDPOINT` and `LLM_MODEL` default to empty strings; `LLM_STREAMING` defaults to the JSON boolean `false` and, when set, must be `true` or `false`. Values must not contain double quotes or backslashes (they are inserted into JSON verbatim). `LOCAL_LLM_API_KEY` is intentionally not supported here.

For Kubernetes/Helm, configure these variables on the same container that runs Caddy. Caddy reads them when it loads the Caddyfile, so changing a value requires rolling out pods with the updated environment. If `/config.json` is unexpectedly empty, check that the request reaches the intended pod, verify `LLM_ENDPOINT` is non-empty in that pod, and confirm the pod runs an image containing the current `Caddyfile`. To check the variable without printing its value:

```sh
kubectl exec <pod> -- sh -c 'test -n "$LLM_ENDPOINT" && echo LLM_ENDPOINT is set || echo LLM_ENDPOINT is empty'
```

When there are multiple replicas, check each pod; an ingress or service may still route requests to an older pod.

You can also enter the base URL, model and API key in Settings > General (the key field is masked). Those values are stored in this browser's localStorage, override the config values per field, and can be removed with "Remove saved connection". They are never included in the configuration export. "Load models from /v1/models" fetches the model list from the endpoint's OpenAI-compatible `/models` route; if it fails or returns nothing, type the model name manually.

**Security:** The API key is only served in development, sent to the browser and visible in network requests, so use it only for a trusted local session. `config.json` in production never has its `apiKey` honoured; authenticate at the endpoint/proxy boundary instead. Production requests may include same-origin browser credentials; a user can also enter an API key in Settings. Configure the endpoint and CORS policy accordingly (including for `/models`).

Set `"streaming": true` in `config.json` (or `LLM_STREAMING=true` in development) to request OpenAI-compatible Server-Sent Events (SSE) streaming; the default is `false`. Streaming sends `"stream": true` and reads the response as SSE chunks, but the assistant response is structured JSON, so the UI only displays it after the complete response has been received and validated. While the request is in flight, the chat automatically scrolls to the bottom and shows the thinking indicator.

Backlog content is only sent when the user requests refinement, decomposition or quality assessment. The app transmits the selected item, its directly linked items and relationships, the relevant refinement conversation, and selected project sources; unrelated backlog items are excluded. The default request timeout is three minutes.

Agent instructions and Markdown templates can be exported and imported as JSON under Settings > Backup. Exports contain saved settings, not unsaved edits; imports replace saved settings and discard unsaved Settings edits. Default templates are Markdown files under `src/defaults/templates/`; the base refinement principles and per-type instructions are Markdown files under `src/defaults/instructions/`. User edits to templates, principles and type instructions are saved in IndexedDB (configuration export format version 4 only) and can be reset to the source files. The agent is given the user's saved template for an item type verbatim. Templates are plain Markdown (headings plus `<!-- hint -->` comments, no placeholders): each item stores one Markdown document and the agent decides what to fill in. The agent returns only per-section updates, which the app merges so untouched sections stay byte-identical; confirmed `- [x]` items are never dropped, and the last 10 versions are kept with an “Undo last AI change” button. Sections titled “Assumptions” / “Open questions” (`- [ ]` task lists) get confirm/reject/resolve buttons. “Break this down” gives the model the template of the requested child type and pre-fills each proposed child (including assumptions and open questions); the app then rebuilds every child description on that template's headings, keeping any extra content under “Additional notes”. Refinement sessions and accepted backlog changes remain local and survive reloads; generated child items are only persisted after explicit acceptance.
