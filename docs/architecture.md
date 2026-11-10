# Architecture

Context document for humans and AI agents. **Keep it up to date** whenever behaviour, structure, configuration or features change (see `AGENTS.md`). Sections marked *Proposed* describe a target, not current code.

## 1. Purpose

Browser-based backlog refinement tool. A user keeps backlog items (capability, feature, enabler, user story) as Markdown documents, and an LLM-powered refinement flow assesses items, proposes section updates, asks open questions, and proposes decompositions into child items. In the current app, assessment changes are applied automatically unless the user enables review; proposed child items require explicit acceptance. The target architecture proposes explicit acceptance of all AI-proposed backlog changes.

The target architecture moves agent execution out of the browser into a reusable agent backend. The frontend communicates with agents through AG-UI, while the backend communicates with language models through an OpenAI-compatible LLM Gateway.

## 2. Current system (as built)

Single-page app: React 19, TypeScript, Vite, Vitest, Dexie (IndexedDB), Zod. Package manager: `pnpm`. There is **no backend**: the browser calls an OpenAI-compatible API directly.

```text
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
- **Assessment review:** assessment changes are applied automatically by default; enabling "Review changes before applying" lets the user accept or discard them first. An explicit quality assessment updates the item's quality data without a separate acceptance step.
- **Decomposition:** proposals are only persisted after explicit acceptance; children are rebuilt on the child type's template headings.
- **Persistence:** items, relationships, sessions and settings in IndexedDB. Settings (instructions, principles, templates) are exportable/importable as JSON (export format v4; v1–3 import).

### LLM configuration

- **Base URL only.** `endpoint` is an absolute HTTP(S) URL or a root-relative same-origin path such as `/api`. Root-relative paths resolve against the origin only, not the current app path or query. The app appends `/v1/chat/completions` and `/v1/models` (`infrastructure/llm/apiUrl.ts`; a legacy trailing `/v1` or `/v1/chat/completions` is tolerated).
- **Runtime config, never bundled.** Defaults come from `GET /config.json` at the origin root (independent of the app base path), loaded by `loadRuntimeLlmConfig`. No environment variable is compiled into the build.
  - Dev: a Vite plugin (`vite.config.ts`) serves `/config.json` from `.env.local` (`LLM_ENDPOINT`, `LLM_MODEL`, `LLM_STREAMING`, `LOCAL_LLM_API_KEY`). The API key is only honoured in development.
  - Docker/Kubernetes: `Caddyfile` substitutes container ENV (`LLM_ENDPOINT`, `LLM_MODEL`, `LLM_STREAMING`, `PORT`) when Caddy loads its configuration, then serves those values at `/config.json`. `endpoint` and `model` default to empty strings; `streaming` defaults to the JSON boolean `false` and accepts only `true` or `false`. Changing values requires a container restart or pod rollout with the new environment, or an explicit Caddy reload in a process with the updated environment. In Kubernetes, set the variables on the Caddy container and verify each pod when diagnosing stale or empty config.
  - Other production hosting: serve `/config.json` from that host's runtime/deployment configuration.
- **User overrides:** endpoint/model/API key entered in Settings are stored only in `localStorage` (`llm-connection-overrides`), win per field over config, are removable, and are never part of the configuration export or IndexedDB settings.
- **Models:** listed via `GET /v1/models`; if that fails or is empty the user types a model name.
- **Streaming:** optional SSE; the UI still only renders the complete validated JSON.

### Security notes

The browser sends an API key when the user has entered one, or when a development-only key is configured; production authentication without a user-entered key belongs at the proxy boundary. CORS must allow `/v1/chat/completions` and `/v1/models`. Backlog context is sent when the user requests refinement, decomposition or a quality assessment.

### Build, run, test

`pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm build`. Container: `Dockerfile` (build with pnpm, serve with Caddy).

## 3. Proposed: generic agent backend

*Proposed – not implemented.*

Goal: introduce a reusable, self-hosted agent layer that several prototypes can use in an on-premise deployment.

The target stack is:

```text
React SPA
    │
    │ AG-UI
    │ HTTP + Server-Sent Events
    ▼
FastAPI
    │
    │ agent-framework-ag-ui
    ▼
Microsoft Agent Framework
    │
    ├─ agents
    ├─ workflows
    ├─ session/state
    ├─ tool execution
    └─ MCP client
    │
    │ OpenAI-compatible API
    │ /v1/responses or /v1/chat/completions
    ▼
LLM Gateway / Proxy
    │
    ├─ on-premise models providers
    └─ future model providers
```

This separates three concerns:

1. **Application ↔ Agent:** AG-UI
2. **Agent ↔ Tools:** MCP
3. **Agent ↔ Model:** OpenAI-compatible inference API

These boundaries reduce coupling to the agent implementation and model provider; each integration still needs to support the selected protocol and capabilities.

### 3.1 Frontend ↔ agent: AG-UI

AG-UI becomes the preferred protocol between interactive frontends and the agent backend.

Instead of the React application directly invoking `/v1/chat/completions`, it submits an AG-UI `RunAgentInput` to an agent endpoint and receives a stream of typed events through Server-Sent Events (SSE).

Conceptually:

```text
React
  │
  │ RunAgentInput
  ▼
POST /agents/{agent}
  │
  │ SSE
  ▼
RUN_STARTED
TEXT_MESSAGE_START
TEXT_MESSAGE_CONTENT
TOOL_CALL_START
TOOL_CALL_END
STATE_DELTA
TEXT_MESSAGE_END
RUN_FINISHED
```

AG-UI provides the application-facing contract for:

- conversations and messages;
- streaming agent output;
- agent lifecycle;
- tool-call visibility;
- shared application/agent state;
- progress and activity;
- human-in-the-loop interaction;
- future generative UI scenarios.

The React application should depend on the AG-UI contract, not on Microsoft Agent Framework-specific APIs.

These are protocol capabilities, not a promise that every capability is implemented in the first version. The protocol does not define agent registration, a catalogue, authentication, authorization, persistence or tool approval policies. The service and application must implement those separately. A tool-call event reports activity; it does not grant permission to execute a tool.

**Impact on this application:**

- React replaces the direct LLM provider with an AG-UI client that starts a run for a selected agent, supplies the relevant local context and consumes the ordered event stream. Discovery of agent IDs and endpoint locations is a separate, still-to-be-designed service contract.
- FastAPI and the Agent Framework adapter translate agent runs into AG-UI events. Both sides must handle run errors, interrupted streams and cancellation explicitly; a partial stream is not a successful proposal. Resumption and retries need a defined contract so interrupted or repeated requests do not cause duplicate side effects.
- Thread and run identifiers identify interactions; they do not themselves persist conversation or state. The service must bind them to the authenticated user and define their lifetime, storage and isolation. The existing IndexedDB remains the source of the browser's backlog data.
- The UI may show streamed progress and tool status, but it must assemble and validate a complete structured proposal before presenting it for acceptance. No streaming event automatically applies a proposed backlog change; the user explicitly accepts or rejects it first. Normal local operations, such as saving messages and session state, can still mutate IndexedDB independently.
- Shared state, human approvals and generative UI require explicit implementation and policy on both sides. AG-UI does not provide authorization or secure tool execution by itself.

See the [AG-UI specification](https://docs.ag-ui.com/spec/1.0) and [Agent Framework state management](https://learn.microsoft.com/en-us/agent-framework/integrations/by-component/ui/ag-ui/state-management).

CopilotKit may be introduced later as a React UI/runtime layer on top of AG-UI, but it is not required by the architecture.

### 3.2 HTTP hosting: FastAPI

The agent service is implemented as a Python service hosted with FastAPI.

Microsoft Agent Framework's Python AG-UI integration provides the bridge between FastAPI and Agent Framework:

```text
FastAPI
    │
add_agent_framework_fastapi_endpoint(...)
    │
    ▼
AgentFrameworkAgent
    │
    ▼
Agent Framework Agent
```

Use the `agent-framework-ag-ui` package rather than implementing the AG-UI HTTP/SSE protocol manually.

FastAPI remains responsible for the service boundary, including:

- authentication and authorization;
- CORS;
- health/readiness endpoints;
- request limits;
- correlation IDs;
- observability;
- agent endpoint registration;
- production middleware.

Authentication should terminate at this service, not at the LLM Gateway from the browser.

### 3.3 Agent runtime: Microsoft Agent Framework Python

Microsoft Agent Framework Python is the initial agent runtime.

It owns:

- agent execution;
- conversation/session handling where required;
- system instructions;
- tool calling;
- MCP integration;
- workflows;
- structured output;
- human-in-the-loop flows;
- model invocation.

The backend must not expose Agent Framework-specific concepts unnecessarily through its external APIs.

Agent Framework is therefore an implementation detail behind AG-UI:

```text
AG-UI
  │
  ▼
┌───────────────────────────┐
│ Agent service             │
│                           │
│ Microsoft Agent Framework│
│                           │
│ Agent                     │
│ Workflow                  │
│ MCP                       │
│ State                     │
└─────────────┬─────────────┘
              │
              ▼
         LLM Gateway
```

This keeps a runtime replacement possible without exposing framework-specific APIs to React; compatibility with the same AG-UI events, application contracts and supported capabilities would still need to be verified.

### 3.4 Agent ↔ model: LLM Gateway

Agents do not invoke individual model providers directly.

All model inference goes through the existing LLM Gateway / Proxy using an OpenAI-compatible API.

Preferred interface:

```text
/v1/responses
```

Compatibility interface where needed:

```text
/v1/chat/completions
```

The gateway is responsible for:

- model provider abstraction;
- logical model aliases;
- credentials toward model providers;
- routing;
- provider-specific configuration;
- rate limits where applicable;
- inference logging/metrics where permitted;
- on-premise model selection.

Agent definitions refer to logical model names rather than provider-specific endpoints.

For example:

```yaml
model: reasoning-large
```

may be resolved by the gateway to an on-premise vLLM deployment today and another provider later.

The agent layer must not need to know which provider ultimately executes the model request.

### 3.5 Tools: MCP

MCP is the preferred protocol between agents and external tools or data sources.

```text
Agent Framework
      │
      │ MCP
      ├──────────> GitLab MCP
      ├──────────> Jira MCP
      ├──────────> documentation/search MCP
      └──────────> prototype-specific MCP
```

Tool execution credentials are managed server-side. For user-supplied credentials, the browser provides the credential to the service; it is not a provider credential distributed by the service. The proposed Jira-specific lifecycle and restrictions are described in section 3.8.

Browser-local data does not automatically become an MCP tool. Backlog items remain in IndexedDB and relevant context is explicitly provided to the agent by the frontend.

Frontend tool execution may be introduced later through AG-UI when there is a concrete requirement for the agent to interact with browser-local capabilities.

### 3.6 Declarative agents in the repo

Agents, skills and tool bindings live in git and are loaded at application startup. Development may support hot reload.

```text
agent-service/
├─ app/
│  ├─ api/                 FastAPI + AG-UI endpoints
│  ├─ agents/              agent loading and creation
│  ├─ runtime/             Microsoft Agent Framework integration
│  ├─ llm/                 LLM Gateway configuration
│  ├─ tools/               MCP/tool configuration
│  ├─ security/            authentication/authorization
│  └─ observability/       logging, tracing, metrics
│
├─ agents/
│  └─ backlog-refiner.agent.md
│
├─ skills/
│  └─ user-story-writing/
│     └─ SKILL.md
│
└─ tools/
   └─ tools.yaml
```

`*.agent.md` frontmatter can contain, for example:

```yaml
name: backlog-refiner
description: Refines structured backlog items
model: reasoning-large

skills:
  - user-story-writing

tools:
  - backlog-search

output_schema: schemas/refinement-proposal.json
```

The Markdown body contains the agent's core instructions.

The declarative format should remain framework-neutral. A loader translates these definitions into Microsoft Agent Framework agents at runtime.

This prevents the git-based agent definitions from becoming tightly coupled to Microsoft Agent Framework.

The service should load and validate definitions and their referenced skills and tool bindings from a trusted Git revision. Agent IDs and definition versions are distinct from LLM model aliases. How agents are discovered by clients, how versions map to Git revisions, and whether a separate management API is needed remain open design decisions. AG-UI itself does not define these lifecycle or catalogue operations.

### 3.7 Backlog refinement flow and validation

The frontend sends the selected backlog item, relevant related items, conversation and accepted or rejected assumptions to the backlog-refiner agent through AG-UI. The agent uses its instructions, skills and any authorized MCP tools and calls the model through the LLM Gateway.

Run events are streamed back through AG-UI; structured refinement proposals remain an application contract. The agent proposes changes and does not directly mutate IndexedDB.

The backend MUST validate complete proposals against the application contract before returning them. It SHOULD also constrain model output using a JSON Schema or Agent Framework structured-output mechanism where supported; server-side validation remains required when the model cannot enforce that schema.

The frontend MUST continue validating received proposals with Zod before applying them.

Therefore:

```text
LLM
 │
 ▼
Agent Framework
 │
 │ structured output validation
 ▼
AG-UI
 │
 ▼
React
 │
 │ Zod validation
 ▼
Proposal
 │
 ├── Accept ──> IndexedDB
 └── Reject ──> no mutation
```

Server-side validation protects the agent contract.

Client-side validation protects the application state.

They are intentionally complementary.

### 3.8 Future tool: Jira Data Center

*Proposed future functionality – not implemented.* A Jira tool can let the agent retrieve and search issues the user is authorized to access, to provide context for refinement. The agent service uses an MCP server or adapter with Jira Data Center REST APIs; MCP is preferred, but a specific server must be evaluated for safe per-user credential propagation and deployment before adoption. Jira contents are untrusted data, not agent instructions.

**Per-user authentication and authorization:**

1. The user supplies their own Jira Data Center personal access token (PAT) in the frontend. The frontend transmits it over TLS to an authenticated agent-service endpoint, separate from prompts and AG-UI run events.
2. The service associates the credential with the authenticated user and session in a temporary, access-controlled server-side credential context. The lifetime is bounded by the authenticated session; the exact timeout and session mechanism remain to be designed.
3. An authorized run resolves only that user's credential for its own session. The Jira adapter sends it to the approved Jira Data Center endpoint as `Authorization: Bearer <PAT>`. If an MCP server runs separately, pass its credential through an authenticated, TLS-protected per-user connection, never as model-visible tool arguments. The PAT acts with the Jira permissions of its owner; it does not replace the agent service's own authentication, authorization or tool policy.

The PAT is transient: do not persist it in Git, configuration, exports, IndexedDB, localStorage, databases or a persistent secret store. It must not be included in agent instructions, model requests, AG-UI events, logs, traces or audit records. Do not send it back to the browser or expose it as an MCP tool argument or result. Shared tool configuration contains only non-secret connection and policy information; credential resolution is user- and session-scoped, not a shared global environment variable.

Keep the credential only in protected process memory for the session and remove references on explicit disconnect, logout, session expiry and process termination. Clear transient per-run copies when a run ends or fails, and account for memory dumps, rotation and revocation. In a multi-instance deployment, define session affinity and cleanup when an instance fails; a session routed to another instance must not silently reuse another user's credential. If the credential is lost, require the user to provide it again rather than persist or reconstruct it. An expired or revoked PAT and insufficient Jira permissions must produce explicit, sanitized errors.

Begin with scoped read/search capabilities. Any future create, update or other write operation requires a specific, informed user approval before execution, plus authorization and policy checks at execution time. Restrict Jira targets to configured, approved hosts, use TLS and enforce network egress controls to reduce SSRF and credential exfiltration risks. Redact sensitive values from errors and observability, and treat retrieved issues and tool output as untrusted content to limit prompt-injection risks.

See Atlassian's [Data Center PAT documentation](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html). Jira Cloud authentication is outside this future feature's current scope.

### 3.9 Standards

| Concern | Standard | Role |
|---|---|---|
| Interactive application ↔ agent | **AG-UI** | Primary React-to-agent protocol, including messages, streaming, tools and state |
| Agent discovery and management | To be designed | Catalogue, identity and definition versions; not specified by AG-UI |
| Agent ↔ model | **OpenAI Responses / Chat Completions** | Inference through the LLM Gateway |
| Agent ↔ tools | **MCP** | Standard tool and data integration |
| Agent ↔ agent | **A2A** | Optional future cross-agent delegation |
| Reusable instruction bundles | **Agent Skills** | Git-based reusable agent instructions |

### 3.10 Boundaries

**Frontend owns:**

- React UI;
- backlog documents;
- relationships;
- IndexedDB;
- proposal accept/reject;
- undo/history;
- local UI state;
- final client-side validation.

**Agent Service owns:**

- agent definitions;
- agent execution;
- workflows;
- skills;
- tool configuration;
- per-user temporary tool credential handling;
- AG-UI;
- authentication and authorization;
- audit and observability.

**LLM Gateway owns:**

- model catalogue;
- model aliases;
- provider routing;
- model-provider credentials;
- inference API compatibility;
- on-premise routing.

### 3.11 Security boundary

The browser does not receive model-provider credentials. A user-supplied Jira PAT is an explicit exception: the user enters it in the browser, which transmits it to the agent service for temporary session use as described in section 3.8.

Production request flow:

```text
Browser
   │
   │ OIDC access token
   ▼
Agent Service
   │
   ├── authorization
   ├── agent policy
   ├── tool credentials
   └── audit
   │
   │ workload/service credential
   ▼
LLM Gateway
   │
   ▼
Model Provider
```

The existing browser-to-LLM flow is therefore transitional and should be removed once the agent backend is adopted.

Backlog content leaves the browser only when the user explicitly starts an agent operation such as refinement, decomposition or a quality assessment.

The current browser runtime configuration described in section 2 targets the LLM directly. The future frontend must instead discover or be configured with the agent-service endpoint and agent identity; the configuration format and migration are not yet designed. LLM Gateway endpoints, model aliases and credentials belong to the agent-service deployment and must not be mistaken for frontend agent endpoints.

### 3.12 Migration

Migration should be incremental.

**Phase 1: Introduce Agent Service**

- Deploy Python + FastAPI.
- Add Microsoft Agent Framework.
- Add `agent-framework-ag-ui`.
- Implement `backlog-refiner`.
- Connect Agent Framework to the existing OpenAI-compatible LLM Gateway.
- Keep current IndexedDB persistence.

**Phase 2: Move React to AG-UI**

Replace:

```text
React
  ↓
/v1/chat/completions
  ↓
LLM Gateway
```

with:

```text
React
  ↓
AG-UI
  ↓
FastAPI
  ↓
Microsoft Agent Framework
  ↓
LLM Gateway
```

Move prompting and agent instructions from `ProxyRefinementProvider` into the backend agent definition.

Preserve the user's current customizable instructions and templates, including their export/import and restore behavior, through an explicitly designed migration and request contract. Keep Zod validation and proposal acceptance in React.

The target requires explicit acceptance before applying any AI-proposed backlog change. This intentionally changes the current default, which automatically applies assessment changes unless review is enabled; migration must make that UX change clear. Define separately whether and how quality assessments update stored quality data.

**Phase 3: Introduce tools**

Add MCP servers only where agents require access to external systems. Jira Data Center is a future integration with per-user, session-only PAT handling as described in section 3.8.

**Phase 4: Rich agent UX**

Use additional AG-UI capabilities for:

- visible agent progress;
- tool-call status;
- human approval;
- shared state;
- longer-running workflows;
- generative UI where useful.

CopilotKit can be evaluated in this phase rather than being a prerequisite for the initial architecture.

### 3.13 Open decisions

- OIDC provider and authorization model.
- Session persistence: stateless request context vs. server-side agent threads.
- AG-UI endpoint discovery and agent catalogue, management API, access control and Git version mapping.
- LLM Gateway model alias conventions.
- Server-side structured-output retry policy.
- Agent-service endpoint configuration and migration of current user-customized instructions and templates.
- Session-only Jira credential lifetime, instance affinity and cleanup under failure.
- Where browser-local tool execution belongs if required later.
- Audit retention and prompt/content logging policy.
- Whether CopilotKit provides enough value beyond a lightweight AG-UI React integration.

## 4. Maintenance rule

Any change to structure, configuration, data formats, agent behaviour or features must update this file in the same change.