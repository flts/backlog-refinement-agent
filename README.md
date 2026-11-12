# Backlog Refinement Agent

A local-first React and TypeScript workspace for creating, refining, and decomposing Capabilities, Features, User Stories, and Enablers. Backlog items, relationships, refinement conversations, settings, and templates are stored in browser IndexedDB; the app has no application backend or account system.

## Projects and backups

Create a project before adding backlog items. Each project has its own backlog, relationships, refinement sessions and sources. Project deletion removes all of these after confirmation. The refinement workspace can delete a session without deleting its item or previously accepted changes; the most recent remaining session opens, or a fresh one is created. Use the status controls to move an item back to Refining or forward to Ready. Resolving a question or assumption does not itself change status; an accepted AI assessment can suggest a status change.

Add PDF or UTF-8 text files, or save an HTTP(S) URL reference with optional pasted text. PDFs must contain selectable text; scanned PDFs require OCR and are not supported. File input is limited to 10 MiB, 200 PDF pages and 1,000,000 characters of extracted text. Fetching a URL is explicit, omits credentials and requires the destination's CORS permission; if it fails, paste the text instead. Fetched HTML is read as static text, not executed.

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

Set `VITE_LLM_ENDPOINT` and `VITE_LLM_MODEL` for both development and deployment. For local development only, you may also set `LOCAL_LLM_API_KEY` in `.env.local`; the Vite development server adds it as a Bearer token. The production build deliberately replaces this value with an empty string, even if it is present in the build environment. Restart the dev server after changing `.env.local`. The endpoint must be an OpenAI-compatible Chat Completions URL. You can also enter the endpoint, model and API key in Settings > General (the key field is masked). Those values are stored in this browser's localStorage, override the environment values per field, show which values come from the environment, and can be removed with "Remove saved connection". They are never included in the configuration export.

**Security:** The local-development key is sent to the browser served by the Vite dev server and appears in its network requests, so use this only for a trusted local session. Production builds do not include or send `LOCAL_LLM_API_KEY`. If a deployed endpoint requires authentication, configure it to authenticate requests at the endpoint/proxy boundary; do not add a privileged key to `VITE_*` variables or the browser bundle.

In development, requests include a Bearer authorization header only when `LOCAL_LLM_API_KEY` is set. Production requests are unauthenticated from the browser. Configure the endpoint and CORS policy accordingly.

Backlog content is only sent when the user requests refinement, decomposition or quality assessment. The app transmits the selected item, its directly linked items and relationships, the relevant refinement conversation, and selected project sources; unrelated backlog items are excluded. The default request timeout is three minutes.

Set `VITE_LLM_STREAMING=true` to request OpenAI-compatible Server-Sent Events (SSE) streaming, or `false` (the default) to wait for a complete response. Streaming sends `"stream": true` and reads the response as SSE chunks, but the assistant response is structured JSON, so the UI only displays it after the complete response has been received and validated. While the request is in flight, the chat automatically scrolls to the bottom and shows the thinking indicator.

Agent instructions and complete Markdown templates can be exported/imported as JSON. Default templates are Markdown files under `src/defaults/templates/`; the base refinement principles and per-type instructions are Markdown files under `src/defaults/instructions/`. User edits to templates, principles and type instructions are saved in IndexedDB (configuration export format version 4 only) and can be reset to the source files. The agent is given the user's saved template for an item type verbatim. Templates are plain Markdown (headings plus `<!-- hint -->` comments, no placeholders): each item stores one Markdown document and the agent decides what to fill in. The agent returns only per-section updates, which the app merges so untouched sections stay byte-identical; confirmed `- [x]` items are never dropped, and the last 10 versions are kept with an “Undo last AI change” button. Sections titled “Assumptions” / “Open questions” (`- [ ]` task lists) get confirm/reject/resolve buttons. “Break this down” gives the model the template of the requested child type and pre-fills each proposed child (including assumptions and open questions); the app then rebuilds every child description on that template's headings, keeping any extra content under “Additional notes”. Refinement sessions and accepted backlog changes remain local and survive reloads; generated child items are only persisted after explicit acceptance.
