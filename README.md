# Backlog Refinement Agent

A local-first React and TypeScript workspace for creating, refining, and decomposing Capabilities, Features, User Stories, and Enablers. Backlog items, relationships, refinement conversations, settings, and templates are stored in browser IndexedDB; the app has no application backend or account system.

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

Set `VITE_LLM_ENDPOINT` and `VITE_LLM_MODEL` for both development and deployment. For local development only, you may also set `LOCAL_LLM_API_KEY` in `.env.local`; the Vite development server adds it as a Bearer token. The production build deliberately replaces this value with an empty string, even if it is present in the build environment. Restart the dev server after changing `.env.local`. The endpoint must be an OpenAI-compatible Chat Completions URL. These values are not configured in the app settings panel; that panel is for agent instructions and templates.

**Security:** The local-development key is sent to the browser served by the Vite dev server and appears in its network requests, so use this only for a trusted local session. Production builds do not include or send `LOCAL_LLM_API_KEY`. If a deployed endpoint requires authentication, configure it to authenticate requests at the endpoint/proxy boundary; do not add a privileged key to `VITE_*` variables or the browser bundle.

In development, requests include a Bearer authorization header only when `LOCAL_LLM_API_KEY` is set. Production requests are unauthenticated from the browser. Configure the endpoint and CORS policy accordingly.

Backlog content is only sent when the user requests refinement or decomposition. The app transmits the selected item, its directly linked items and relationships, and that item's refinement conversation; unrelated backlog items are excluded.

Set `VITE_LLM_STREAMING=true` to request OpenAI-compatible Server-Sent Events (SSE) streaming, or `false` (the default) to wait for a complete response. Streaming sends `"stream": true` and reads the response as SSE chunks, but the assistant response is structured JSON, so the UI only displays it after the complete response has been received and validated. While the request is in flight, the chat automatically scrolls to the bottom and shows the thinking indicator.

Agent instructions and complete Markdown templates can be exported/imported as JSON. Default templates are Markdown files under `src/defaults/templates/`; the base refinement principles and per-type instructions are Markdown files under `src/defaults/instructions/`. User edits to templates, principles and type instructions are saved in IndexedDB (export format version 4; versions 1–3 still import) and can be reset to the source files. The agent is given the user's saved template for an item type verbatim, which equals the source default until it is modified. Templates are plain Markdown (headings plus `<!-- hint -->` comments, no placeholders): each item stores one Markdown document and the agent decides what to fill in. The agent returns only per-section updates, which the app merges so untouched sections stay byte-identical; confirmed `- [x]` items are never dropped, and the last 10 versions are kept with an “Undo last AI change” button. Sections titled “Assumptions” / “Open questions” (`- [ ]` task lists) get confirm/reject/resolve buttons. “Break this down” gives the model the template of the requested child type and pre-fills each proposed child (including assumptions and open questions); the app then rebuilds every child description on that template's headings, keeping any extra content under “Additional notes”. Older items and `{{…}}` templates are converted automatically. Refinement sessions and accepted backlog changes remain local and survive reloads; generated child items are only persisted after explicit acceptance.
