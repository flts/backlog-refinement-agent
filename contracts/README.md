# Contracts

Single source of truth for the data shared by the SPA (`apps/web`, TypeScript), `agent-service` (Python) and
`backlog-api` (Python). Everything here is plain JSON so every runtime can consume it.

```text
contracts/
  schemas/    JSON Schema (draft 2020-12), one file per contract: <name>.schema.json
  fixtures/
    tools/<contract>/{valid,invalid,semantic-invalid}/*.json   payloads used by BOTH test suites
    document/*.json                                            golden fixtures for the document merge logic
  openapi/    backlog-api OpenAPI snapshot (owned by backlog-api)
```

Mirrors, kept in sync by tests:

| Runtime | Location | Technology |
|---|---|---|
| Python | `libs/py-contracts` (`backlog_contracts`) | Pydantic v2 models (camelCase aliases) + `load_schema()` |
| TypeScript | `apps/web/src/contracts` | Zod v4 schemas + inferred types |

## Contracts

Tool schemas carry LLM-facing descriptions; `x-tool` names the tool.

| Schema | What | Producer → consumer |
|---|---|---|
| `ask-user.args` | `ask_user` client tool: 1-3 questions, each 1-4 options, `header` ≤ 24, optional `recommended` index, `multiSelect` | model → SPA (`AskUserCard`); validated by SPA and agent-service |
| `ask-user.result` | Tool message content: `status` answered/skipped/dismissed + `answers[]`. `dismissed` is kept for completeness: the SPA does **not** send it (MAF would overwrite it); on dismissal it sends only the user message, optionally prefixed `[dismissed question q1]` | SPA → agent-service → model |
| `propose-document-changes.args` | `{summary, suggestedTitle?, suggestedStatus?, baseVersion, sections[{id, heading, mode: replace\|append, markdown, rationale?}]}` | model → agent-service (approval interrupt) → SPA review |
| `document-changes.result` | Explicit outcome `{applied, edited, rejected, conflicted[{sectionId, heading, reason, currentMarkdown?}], newVersion, warnings?, titleApplied?, statusApplied?}`; also mirrored into `state.lastApply` | backlog-api (`apply_document_changes`) → agent-service → model/SPA |
| `propose-child-items.args` | `{rationale, childType, children[{proposalId, title, markdown}], relationships?[{sourceRef, targetRef, type}]}` | model → agent-service (approval) → SPA review |
| `child-items.result` | `{created[{proposalId, itemId, title}], edited, rejected, failed, relationshipsCreated, relationshipsSkipped?}` | backlog-api (`create_child_items`) → agent-service → model/SPA |
| `approval-resume` | Resume `payload`: `{approved, editedArgs?}`. `editedArgs` is a **full replacement** of the tool arguments (all keys, accepted/edited sections only, never merged) | SPA → agent-service |
| `resume-entry` | `RunAgentInput.resume[]` element `{interruptId, status: resolved\|cancelled, payload?}`. `interruptId` = **`interrupt.id` (`af-call-…`), not the `toolCallId`** | SPA → agent-service |
| `quality-assessment.args` | `record_quality_assessment`: `{overall, areas[{area, level, note?}], flags…, summary?, documentHash?}` (levels, no numeric scores) | model → agent-service → backlog-api (`set_item_quality`) |
| `suggest-next-actions.args` | ≤ 3 chips `{id, label, intent: refine\|continue\|breakdown\|assess\|message, prompt?}` (`message` needs `prompt`) | model → agent-service → `state.nextActions` → SPA |
| `set-session-title.args` | `{title}` ≤ 60 chars | model → agent-service |
| `agent-state` | Shared AG-UI state `{schemaVersion: 1, projectId, itemId, itemType?, preview, childPreview?, nextActions?, quality?, lastApply?}`. **`preview` is required and nullable; the SPA initialises it to `null`** (a JSON-Patch `replace /preview` fails client-side when the key is absent). Unknown keys are tolerated | SPA ↔ agent-service |
| `forwarded-props` | `{intent: refine\|continue\|breakdown\|assess, childType?}`. Per request only; MAF drops values > 512 serialized characters (the strict schema keeps it far below). `context[]` is **not** part of the contract (MAF ignores it) | SPA → agent-service |
| `run-error-codes` | Sanitized `RUN_ERROR` codes (enum): `APPROVAL_RESUME_{REQUIRED,NOT_FOUND,INVALID,INVALID_RESPONSE}` (from MAF), `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `THREAD_BUSY`, `RATE_LIMITED`, `RUN_TIMEOUT`, `LLM_UNAVAILABLE`, `BACKLOG_UNAVAILABLE`, `TOOL_VALIDATION_FAILED`, `INVALID_REQUEST`, `INTERNAL`. Unknown codes are treated as `INTERNAL` | agent-service → SPA (`RunErrorCard`) |

Consumers: the SPA validates `ask-user.args`, `agent-state`, the interrupt arguments and the results; agent-service
validates every tool argument and `resume` payload (Pydantic) and builds the results; backlog-api returns
`document-changes.result` / `child-items.result` from its MCP tools.

### Predictive `preview`

`state.preview` is the predictive state of `propose_document_changes`: configure MAF
`predict_state_config={"preview": {"tool": "propose_document_changes", "tool_argument": "*"}, "childPreview": {"tool": "propose_child_items", "tool_argument": "*"}}`
so the preview holds the (possibly partial) arguments object. (The spike verified `tool_argument="sections"`, which makes
`preview` a bare array; this contract uses `"*"` so summary/title/status travel with it. `"*"` is supported by the MAF source
but not yet exercised by the spike - `svc-tools` must verify it.) MAF emits one `STATE_DELTA` when the argument JSON is complete.
Clear it with `state_update(state={"preview": None, "lastApply": …})` on apply; on reject the SPA sends `state.preview = null`;
on cancel the SPA ignores a stale preview when no interrupt is pending.

### Validation layers

JSON Schema is the wire contract. The models additionally enforce what JSON Schema cannot express: unique ids
(`questions[].id`, `sections[].id`, `children[].proposalId`), `recommended` < number of options, serialized
`forwardedProps` length. Such payloads live in `fixtures/tools/<contract>/semantic-invalid/` - they **pass** the schema and
**fail** the Pydantic/Zod models. Models reject unknown keys (`extra=forbid` / `strictObject`), except `agent-state`.

## Fixtures

* `fixtures/tools/<contract>/valid` must be accepted by the JSON Schema, the Pydantic model and the Zod schema.
* `invalid` must be rejected by all three; `semantic-invalid` only by the models.
* `fixtures/document/*.json`: `{name, description, fn, input, expected}` generated from the current
  `apps/web/src/domain/document.ts` by `pnpm --filter @backlog/web fixtures:document`
  (`apps/web/scripts/generate-document-fixtures.mjs`). `document.fixtures.test.ts` asserts the TS implementation reproduces
  them; the Python port in backlog-api must assert the same files. Functions: `applySectionUpdates`, `conformToTemplate`,
  `splitSections`, `joinSections`, `normalizeHeading`, `diffDocuments`, `parseChecklistSections`, `updateChecklistLine`,
  `templateHeadings`. Only regenerate on a deliberate behaviour change and review the diff.

## Versioning

* `agent-state.schemaVersion` (currently `1`) identifies the contract generation. **Bump it on every breaking change**
  (removed/renamed/retyped field, tighter limit, new required field) and update schemas, Pydantic and Zod mirrors and fixtures
  in one change. Additive optional fields are non-breaking.
* A new schema `$id` is never reused for a different shape; add a new file instead of editing meaning.
* Tool descriptions (the `description` in the tool schemas) are part of the prompt; changing them is not breaking but should
  be reviewed for model behaviour.

## Python usage

```python
from backlog_contracts import AskUserArgs, load_schema

args = AskUserArgs.model_validate(tool_arguments_dict)   # camelCase or snake_case keys
schema = load_schema("ask-user.args")                    # dict, e.g. to declare the tool
```

`load_schema` finds `contracts/schemas` through `$BACKLOG_CONTRACTS_DIR` (the `contracts` directory) or by walking up from the
package; containers should set the variable.

## Checks

```bash
uv run --package backlog-contracts pytest libs/py-contracts -q
pnpm --filter @backlog/web exec vitest run src/contracts src/domain/document.fixtures.test.ts
```
