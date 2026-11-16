# palette/

`CommandPalette` (⌘K / Ctrl+K, or the `shell:open-palette` window event), the composer `/` and `@` assist, and the events below.

## Window events (`PALETTE_EVENTS`, `emitPaletteEvent`, `usePaletteEvent`)

| Event | Detail | Handled by |
|---|---|---|
| `shell:open-palette` | – | `CommandPalette` (dispatched by the topbar ⌘K trigger) |
| `palette:new-item` | – | `App` opens the New item dialog |
| `palette:open-sources` | – | `ProjectPanel` opens the Sources drawer (also dispatched by the context bar's "Manage sources") |
| `palette:open-settings` | – | `App` opens the project settings |
| `palette:share` | – | `App` calls `onOpenShare` |

`CommandPalette` accepts `onNewItem`, `onOpenSources`, `onOpenSettings`, `onShare` callbacks that take precedence over the events.

## Slash commands
`/break-down` (first child type), `/break-down-<kind>` (further child types), `/assess`, `/continue`, `/new-session` → `run.continue(intent, childType)` or `threads.create`.

## @-mentions
Inserts `@[Title](item:<id>)`; the text is sent as-is (the agent resolves the id with `get_item_context`). The transcript shows it as `@Title` (`displayMentions`). Ids are not added to `forwardedProps`.
