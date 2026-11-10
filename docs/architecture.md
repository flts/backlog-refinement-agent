# Architecture

Context document for humans and AI agents. **Keep it up to date** whenever behaviour, structure, configuration or features change (see `AGENTS.md`). Sections marked *Proposed* describe a target, not current code.

## 1. Purpose

Browser-only backlog refinement tool. A user keeps backlog items (capability, feature, enabler, user story) as Markdown documents, and an LLM agent refines them through a chat: it assesses an item, proposes section updates, asks open questions, and proposes decompositions into child items. The user explicitly accepts or rejects every change.

## 2. Current system (as built)

Single-page app: React 19, TypeScript, Vite, Vitest, Dexie (IndexedDB), Zod. Package manager: `pnpm`. There is **no backend**: the browser calls an OpenAI-compatible API directly.

```
Browser (SPA)
 ├─ app/             React UI + hooks (useBacklog, useSettings, useRefinementFlow), composition in services.ts
 ├─ application/     use cases + ports (RefinementProvider, RefinementStore), refinement-service, workspace-service
 ├─ domain/          pure model: backlog-item, relationship, refinement-session, proposal, document (Markdown sections)
 ├─ infrastructure/
 │   ├─ llm/         ProxyLlmProvider (HTTP), ProxyRefinementProvider (prompting), normalizeProposal,
 │   │                llmConfig (runtime config + overrides), apiUrl, availableModels
 │   └─ storage/     IndexedDbRefinementStore, SettingsRepository (Dexie)
 └─ defaults/        Markdown defaults: templates/*.md, instructions/*.md (principles + per type)
```

Dependency direction: `app → application → domain`; `infrastructure` implements application ports. Domain has no I/O.

### Key behaviours
- **Documents:** each item is one Markdown document based on a placeholder-free template (headings + `<!-- hints -->`). The agent returns only per-section updates; the app merges them so untouched sections stay byte-identical. Confirmed `- [x]` items are never dropped. Last 10 versions are kept (undo). "Assumptions"/"Open questions" sections are task lists with confirm/reject/resolve buttons.
- **Agent prompt:** base principles + per-type instructions + user extra instructions + the type's template. Only the selected item, its directly linked items/relationships and its conversation are sent. Output is structured JSON, validated (Zod) with one automatic retry carrying `validationFeedback`.
- **Decomposition:** proposals are only persisted after explicit acceptance; children are rebuilt on the child type's template headings.
- **Persistence:** items, relationships, sessions and settings in IndexedDB. Settings (instructions, principles, templates) are exportable/importable as JSON (export format v4; v1–3 import).

### LLM configuration
- **Base URL only.** `endpoint` is the base of an OpenAI-compatible API (e.g. `https://proxy.example`). The app appends `/v1/chat/completions` and `/v1/models` (`infrastructure/llm/apiUrl.ts`; a legacy trailing `/v1` or `/v1/chat/completions` is tolerated).
- **Runtime config, never bundled.** Defaults come from `GET /config.json` (`{endpoint, model, streaming}`), loaded by `loadRuntimeLlmConfig`. No environment variable is compiled into the build.
  - Dev: a Vite plugin (`vite.config.ts`) serves `/config.json` from `.env.local` (`LLM_ENDPOINT`, `LLM_MODEL`, `LLM_STREAMING`, `LOCAL_LLM_API_KEY`). The API key is only honoured in development.
  - Docker: `Caddyfile` generates `/config.json` per request from container ENV (`LLM_ENDPOINT`, `LLM_MODEL`, `LLM_STREAMING`, `PORT`).
  - Static hosting: replace `public/config.json`.
- **User overrides:** endpoint/model/API key entered in Settings are stored only in `localStorage` (`llm-connection-overrides`), win per field over config, are removable, and are never part of the configuration export or IndexedDB settings.
- **Models:** listed via `GET /v1/models`; if that fails or is empty the user types a model name.
- **Streaming:** optional SSE; the UI still only renders the complete validated JSON.

### Security notes
Browser requests are unauthenticated unless the user enters a key; production auth belongs at the proxy boundary. CORS must allow `/v1/chat/completions` and `/v1/models`. Backlog content leaves the browser only on explicit refine/decompose.

### Build, run, test
`pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm build`. Container: `Dockerfile` (build with pnpm, serve with Caddy).

## 3. Proposed: generic agent backend

*Proposed – not implemented.* Goal: a reusable backend that several prototypes can use through industry-standard APIs, with agents defined declaratively in git.

### Does it work as a generic, standards-based service? Yes.
Standards to expose or consume:
| Concern | Standard | Role |
|---|---|---|
| Invoke an agent / chat | OpenAI-compatible **Responses** and **Chat Completions** API, where the agent name is the `model` id (`GET /v1/models` lists agents) | Any OpenAI-compatible client works, including this SPA unchanged |
| Rich agent UX (tool calls, state, streaming events) | **AG-UI** protocol (SSE events) | Optional, for UIs that want tool/state visibility |
| Tools | **MCP** (Model Context Protocol) servers | Shared tool catalogue, language-independent |
| Agent ↔ agent | **A2A** | Optional, for cross-prototype delegation |
| Skills | **Agent Skills** (`SKILL.md` with frontmatter) | Reusable instruction bundles |

Because agents appear as models, the SPA's existing base-URL + `/v1/models` flow keeps working: pointing it at the backend makes agents selectable as "models".

### Declarative agents in the repo
Agents, skills and tool bindings live in git and are loaded at startup (hot-reload in dev):
```
agents/
  backlog-refiner.agent.md     # YAML frontmatter + Markdown instructions
skills/
  user-story-writing/SKILL.md  # shared across agents
tools/
  tools.yaml                   # MCP servers / OpenAPI tools, with auth by ENV reference
```
`*.agent.md` frontmatter (illustrative): `name`, `description`, `model` (logical alias resolved by the proxy), `skills: [..]`, `tools: [..]`, `output_schema` (JSON Schema), `limits`. The Markdown body is the system prompt. The existing `src/defaults/instructions/*.md` and `templates/*.md` map naturally onto an agent plus a skill, and would move to the backend (or be referenced from it).

### Framework fit
Microsoft Agent Framework (Python or .NET) fits: it supports OpenAI-compatible clients with a custom `base_url` (on-prem models behind a proxy), MCP tools, workflows, and declarative agent definitions. A small loader maps `*.agent.md` + skills + `tools.yaml` to framework agents; the HTTP facade exposes them as above. Keep the declarative format framework-neutral so the framework can be swapped.

### Boundaries
- Backend owns: agent definitions, tool credentials, model routing (via the proxy), audit, auth (OIDC), rate limits.
- Frontend owns: UI and local data. Backlog data stays in IndexedDB and is sent per request as context, unless a prototype needs server-side state.
- Browser-only remains possible for simple agent loops; the backend is needed for secrets, internal tools, long-running tasks, audit and sharing.

### Open decisions
Auth model; where local data tools run (browser as tool executor vs. server); versioning of agent definitions; whether `output_schema` replaces client-side Zod validation (keep client validation regardless).

## 4. Maintenance rule
Any change to structure, configuration, data formats, agent behaviour or features must update this file in the same change.
