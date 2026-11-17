# Accessibility

Target: **WCAG 2.2 level AA**, plus **SC 1.4.6 Contrast (Enhanced, AAA)**, which requires 7:1 contrast for text. The app respects operating-system and browser settings: zoom, text size, colour scheme (light/dark), reduced motion, increased contrast and forced colours. The only in-app display preference is the theme (System, Light or Dark) under Settings › Appearance.

> Automated checks (axe-core, contrast tests) catch only part of WCAG. Passing them is **not** a conformance claim. Use the manual protocol below before claiming conformance.

## Principles

- Use native HTML first: `<button>`, `<dialog>`, `<fieldset>`/`<legend>`, `<label>`. Use ARIA only where HTML has no equivalent.
- Every interactive element is reachable and operable with the keyboard, and has a visible focus indicator with at least 3:1 contrast.
- Never use colour alone to convey state.
- Size everything in `rem`, so layouts survive 200% text size and 400% zoom at a width of 320 CSS px.

## Implemented measures

| Area | Measure | SC |
|---|---|---|
| App shell (`App.tsx`, `shell/Topbar.tsx`) | Skip link to `main#main`. Exactly one `h1` ("Backlog Studio – project"), inside the `header` (banner) landmark; the empty-projects screen has its own `h1` in `main`. `document.title` updated per item. Landmarks: `header`, `nav` "Workspace sections" (narrow screens), `main#main` (workspace), `aside` "Backlog", `section` "Refinement workspace", `aside` "Item details", `search` "Filter backlog". Every `<aside>` has a unique label. `<html lang="en">`; there is no content in another language besides user-authored text. | 2.4.1, 2.4.2, 1.3.1, 2.4.6, 3.1.1 |
| Headings | `h1` project → `h2` Backlog / Refinement workspace / Item details (visually hidden) → `h3` session title, card headings, preview sections → `h4` and `h3` inside cards and diffs. Dialogs use `h2` with `aria-labelledby`. | 1.3.1, 2.4.6 |
| Loading / errors | Loading screen with `aria-busy` and `role="status"`. Bootstrap, configuration and sign-in errors (`StatusScreen.tsx`) use `role="alert"`, a heading and a retry button. | 4.1.3 |
| Chat (`chat/`) | Streamed tokens are not read aloud: the transcript is `role="log"` with `aria-live="off"` (focusable, scrollable) and the streaming message is `aria-busy`. Two visually hidden regions announce phase changes: polite ("Agent is working", "Agent replied", "Agent stopped") and assertive (errors). "Needs input" and "Review" are announced by the cards themselves (see live-region policy). Markdown output is sanitised (no raw HTML, http(s)/mailto links only). Activity timeline is a disclosure button (`aria-expanded`) with text status for every row; spinners and the caret respect `prefers-reduced-motion`. Esc in the composer stops a running agent; a Stop button is always available. Run errors show code and run ID with Copy and Retry. Message actions (copy, thumbs) are native buttons with text status. The composer has a visible `:focus-within` ring (the textarea itself has no border). When the ask_user or review card disappears after the answer, focus moves to the composer (or the log) instead of `<body>`. | 4.1.3, 2.1.1, 2.2.2, 2.3.3, 4.1.2, 2.4.7, 2.4.3 |
| Session picker (`ThreadPicker.tsx`) | Disclosure button (`aria-expanded`/`aria-controls`) with native buttons; Esc closes and returns focus to the trigger; no trap (Tab leaves). Rename is an inline text field, delete needs an inline confirmation. Errors `role="alert"`. | 2.1.2, 2.4.3, 4.1.2 |
| Ask-user card (`askuser/`) | Card is a labelled `section` that takes focus when it appears (never from a text field the user is typing in) and announces “The agent has N questions” politely (once: the chat announcer stays silent for this phase). Questions are a WAI-ARIA tabs stepper (roving tabindex, ←/→/Home/End) with “Question n of N”; answered/skipped state is text, not colour only. Options are a native radio group (checkbox group for multi-select, 24 px controls); “Other” has its own labelled textarea. Keys `1`–`5` choose, `Enter` next/submit, `Esc` skips the current question; the digit keys are ignored inside text fields and Shift+Enter adds a line in the “Other” box. Moving to another question focuses its panel and announces “Question n of N: …”. After submitting, the card is replaced by a labelled summary and focus moves to the composer. | 2.1.1, 4.1.2, 4.1.3, 1.4.1, 3.3.2, 2.4.3 |
| Review cards (`review/`) | `ReviewCard`/`ChildProposalCard` are labelled `section`s; on appearance focus goes to their `h3` (`tabindex=-1`). Each section/child has a labelled Accept/Reject/Edit button group with a text state ("Accepted", "Rejected", "Edited"), never colour only; changes are announced in a polite status inside the card ("Section “Summary” accepted."). The inline editor takes focus when opened and returns it to the Edit button on close. Diff and track-changes views carry text equivalents (insert/delete labels). “Accept all”/“Reject all” only set the per-section decisions; nothing is sent until the explicit “Apply n sections” (or “Reject proposal”) button. After the decision, the card unmounts and the result card (`role="status"` summary) is rendered; focus moves to the composer. Stale/expired proposals show text and a Retry button. | 2.1.1, 4.1.2, 4.1.3, 1.4.1, 2.4.3 |
| Command palette (`palette/`) | Native modal `<dialog>` with a WAI-ARIA combobox: the input keeps focus and points to the option with `aria-activedescendant`; grouped `listbox` (Items, Agent commands, Actions); arrows/Home/End move, Enter runs, Esc closes and focus returns to the opener. The scrolling results container is focusable (`tabindex=0`, labelled) so keyboard users can scroll it; a hidden live region announces the result count. Semantic hits carry a text badge. Composer `/` and `@` menus use the same pattern on the textarea (`aria-controls`, `aria-activedescendant`; Tab/Enter choose, Esc closes without stopping a run). | 2.1.1, 4.1.2, 4.1.3, 2.4.3 |
| Context bar (`context/`) | Chips are focusable (≥24 px), with tooltips linked by `aria-describedby` that appear on hover and focus and close with Esc. The related-items popover is a disclosure button (`aria-expanded`) that closes with Esc and returns focus. The pinned budget is a `role="meter"` with text. | 1.4.13, 2.1.1, 4.1.2 |
| Modals (`useModalDialog.ts`) | Native modal `<dialog>` for NewItem, NewProject, Settings, ProjectSettings, Share, Conflict, Sources drawer and the palette: initial focus is set explicitly to `[autofocus]` or the first control, the background is inert, Escape closes (Conflict only when not busy), a click on the backdrop closes, focus returns to the element that opened the dialog, accessible name via `aria-labelledby`/`aria-label`. | 2.1.2, 2.4.3, 4.1.2 |
| Settings (`SettingsModal.tsx`) | `fieldset`/`legend` group the Account (name, email, Sign out) and Appearance sections. The Sign out button is disabled while signing out. | 1.3.1, 3.3.2, 4.1.3 |
| Project settings (`settings/`) | Vertical WAI-ARIA tablist (roving tabindex) with a labelled `tabpanel`; guidance editors have visible labels, a text diff with +/− words (not colour only), `role="alert"` for validation/conflict problems and `role="status"` for save results. Owner-only controls are omitted for contributors, with a visible sentence stating their role; deleting a project needs the project name typed in. | 4.1.2, 1.4.1, 3.3.1, 4.1.3 |
| Share dialog (`collab/ShareDialog.tsx`) | Member list is a labelled list with role selects labelled "Role of …"; add-by-email has a visible label, inline validation text and a `role="status"` confirmation; removing a member or leaving uses the native `confirm` dialog. Initials avatars are decorative (`aria-hidden`) next to the name. | 1.3.1, 3.3.1, 4.1.3 |
| Conflict dialog (`collab/ConflictDialog.tsx`) | Each conflicting section is a `fieldset` with a radiogroup (Mine / Theirs / Both) and side-by-side text previews labelled "Mine"/"Theirs"; the automatic merges are listed as text. "Decide later" keeps the edits. | 1.3.1, 3.3.2 |
| Presence and remote updates (`collab/`) | Avatars are a labelled list with a visually hidden "Anna, editing" per person (initials are `aria-hidden`; `title` is only a hint). The "N is viewing" sentence is visible text. `PresenceAnnouncer` announces joins and leaves politely, batched over 3 s (a flicker cancels out, people already present on load are not announced). `RemoteChangeNotice` announces "Updated by Anna" politely and clears after 10 s. | 1.4.1, 4.1.3 |
| Sources drawer (`sources/`) | Modal `<dialog>` (focus moves to Close, focus trap, Escape, focus returns to the trigger); the header is a `div` (not a second banner). Pinned budget is a `role="meter"` with text. Mode is a `radiogroup` of native radios. Index status uses glyph plus text, never colour alone. Errors use `role="alert"`, successes `role="status"`. Row actions are a keyboard-operable menu; removal needs an inline confirmation. Links use `--accent-text` (7:1). | 2.1.2, 1.4.1, 3.3.1, 4.1.2, 4.1.3 |
| History (`history/`) | Versions are a labelled ordered list of toggle buttons (`aria-pressed`); the selected version has a labelled region, a mode radiogroup and a focusable `<pre>` with a label (so long documents scroll with the keyboard). Diffs use +/− text. Restore needs an inline confirmation that takes focus. The detail pane is not a live region (selecting a version is user-initiated). | 1.4.1, 2.1.1, 4.1.2 |
| Backlog filter (`backlog/`) | A `search` landmark with a labelled input (`/` focuses it, Esc clears), toggle chips (`aria-pressed`, ≥24 px) in labelled groups, and one polite status "3 of 12 items match" that is empty while no filter is active. The tree shows status as a dot with `role="img"` and a text label, quality as a badge with text, and "needs input"/running as text badges. | 1.4.1, 4.1.2, 4.1.3 |
| Quality (`quality/`) | Labelled region with a table whose levels carry glyph plus text; "Stale" is text in a `role="status"`. | 1.4.1, 1.3.1 |
| Topbar (`shell/`) | `header` with native buttons. Project switcher, Settings and "More" are WAI-ARIA menu buttons (`aria-haspopup`, `aria-expanded`; arrows, Home/End, Escape; projects are `menuitemradio`; Tab closes; choosing an entry restores focus to the trigger first). The account button opens a labelled disclosure panel (Esc restores focus); its accessible name starts with the visible initials only via CSS (`data-initials`) so label and name match. The search trigger keeps its accessible name when only the icon is visible. The agent status pill is visual text (not a live region). Up to 1100 px wide the secondary controls collapse into the "More" menu; at ≤420 px the bar wraps instead of overflowing. | 4.1.2, 2.1.1, 1.4.10, 2.5.3 |
| Panel splitters (`shell/`) | Splitters are focusable `role="separator"` with `aria-valuenow/min/max`: arrows resize by 16 px, Home/End jump to the limits, Enter or double-click resets. Dragging is optional (single-pointer alternative = keyboard). The hit area is 24 px wide (the visible handle is 4 px). Focus mode (Ctrl/⌘+. or the topbar button, `aria-pressed`) shows only the panel last used and is announced. | 2.1.1, 2.5.7, 2.5.8, 4.1.2, 4.1.3 |
| Mobile tabs | At ≤860 px the three panels are shown one at a time with toggle buttons (`aria-pressed`); hidden panels are `display:none`, so they are not in the tab order or accessibility tree. | 4.1.2, 1.4.10 |
| Icons / glyphs | Decorative glyphs are `aria-hidden`. Icon-only buttons have an accessible name. | 1.1.1, 4.1.2 |
| Colour (`styles.css`) | Text tokens are at least 7:1 on every surface token (panel, bg, panel-subtle, green/violet/warning/danger-soft) in both themes. UI tokens (control border, focus ring, accent border, status dots) are at least 3:1 on all surfaces. Status dots use tokens, not hex values, so they follow the theme. No text is dimmed with `opacity`. | 1.4.3, 1.4.6, 1.4.11 |
| Focus | One global `:focus-visible` rule: 3 px outline in `--focus` (≥3:1 on all surfaces) with 2 px offset, on buttons, inputs, links, summaries, `[tabindex]`, tabs and separators. The composer, radio/checkbox cards and segmented controls show the ring on the wrapper (`:focus-within`/`:has(:focus-visible)`). Scrollers use `scroll-padding` so a focused control is not hidden under the sticky heading; the toast is dismissible and does not cover the composer. | 2.4.7, 2.4.11, 2.4.13 |
| Targets | Interactive targets are at least 24×24 CSS px: filter chips, activity toggle, context chips, icon buttons, radios and checkboxes in cards (24 px), tree buttons, splitters (24 px hit area). | 2.5.8 |
| Reflow / text | `rem` typography, `min-height` instead of fixed heights for the topbar and tree rows, panels stack on narrow viewports, the topbar wraps at ≤420 px. No horizontal scrolling at 320 CSS px (checked in a real browser). | 1.4.4, 1.4.10, 1.4.12 |
| Theme | Light and dark palettes share the same colour tokens. By default `prefers-color-scheme` decides; a manual choice sets `data-theme` on `<html>`. Both palettes meet 7:1 for text and 3:1 for borders and focus. | 1.4.3, 1.4.6, 1.4.11 |
| Preferences | `prefers-reduced-motion` disables animation (global rule plus per-feature rules for the caret, skeletons, spinners, pulse dots). `prefers-contrast: more` strengthens borders and text. `forced-colors: active` uses system colours: focus rings use `Highlight`, pills/badges/chips get a `ButtonText` border, status dots, splitter handles and meters are repainted with system colours, selected rows/options get an outline. | 2.3.3 (AAA), 1.4.11 |

## Live-region policy

There is one **polite** and one **assertive** channel per concern; a state change is announced by exactly one component.

| Event | Announced by | Politeness |
|---|---|---|
| Agent starts, replies, is stopped | `ChatPanel` (`useRunAnnouncements`) | polite |
| Agent error | `ChatPanel` | assertive |
| Agent needs input (`ask_user`) | `AskUserCard` ("The agent has N questions", then "Question n of N: …") | polite |
| Review proposed | `ReviewCard`/`ChildProposalCard` take focus (heading); their status announces each decision | polite |
| Apply / result | `ApplyResultCard` summary (`role="status"`) | polite |
| Agent status pill (topbar) | **nobody**: it is visual only, so it does not repeat the chat announcement | – |
| Save status | Only a failed save ("Your last change could not be saved.") | assertive |
| Edit conflict | The conflict dialog (modal, takes focus); the badge is a button | – |
| Someone joins / leaves | `PresenceAnnouncer`, batched over 3 s | polite |
| Remote update of the open item | `RemoteChangeNotice` | polite |
| Filter result count | `BacklogFilterBar` (only while a filter is active) | polite |
| Palette result count | `CommandPalette` (hidden status) | polite |
| Focus mode on/off | `WorkspaceLayout` (hidden status) | polite |
| Toasts | `Toast` (`role="alert"` for errors, `role="status"` otherwise) | assertive / polite |

Rules: transcript tokens are never live; routine progress (saving, saved, heartbeat) is never announced; dialogs announce themselves through focus, not through an extra live region; the regions stay in the DOM and only their text changes.

## Keyboard shortcuts

| Keys | Where | Action |
|---|---|---|
| Tab / Shift+Tab | everywhere | Move focus; the skip link is first |
| Ctrl/⌘ + K | anywhere | Open or close the command palette |
| `/` | outside text fields | Focus the backlog filter |
| Esc | filter input | Clear the query, then all filters |
| Esc | dialog, drawer, palette, menu, popover, session list | Close and return focus to the trigger |
| Esc | composer while the agent runs | Stop the agent |
| Esc | ask_user card | Skip the current question (the last one submits) |
| ↑ ↓ Home End, Enter | palette, menus, composer `/` and `@` lists | Move, choose; Tab also chooses in the composer lists |
| 1–5, Enter | ask_user card (outside text fields) | Choose option (5 = Other), next/submit; Shift+Enter adds a line in “Other” |
| ← → Home End | ask_user tabs, panel tabs (Document, Open items, Quality, History) | Move between tabs |
| ← → (16 px), Home / End, Enter | splitter | Resize, jump to limit, reset |
| Ctrl/⌘ + . | workspace | Toggle focus mode |
| Enter, Shift+Enter | composer | Send, new line |

## Automated checks

- `src/test/axe.ts`: `expectNoAxeViolations(container)` runs axe-core (wcag2a/aa, 2.1, 2.2 AA) in component tests. The `color-contrast` rule is disabled because jsdom does not compute layout or colours.
- `src/app/app.a11y.test.tsx`: the full app (Projects → App) with an item selected, an `ask_user` card pending and a review pending, in the light and dark theme; also asserts one `h1`, one banner and one `main`.
- `src/app/focus-management.test.tsx`: every modal (NewProject, NewItem, Settings, ProjectSettings, Share, Conflict, Sources) moves focus in, closes with Escape and restores focus to the trigger, passes axe in both themes; palette, `Menu` and `AccountMenu` likewise.
- `src/app/live-regions.test.tsx`: the live-region policy (presence batching, silent pill, save errors only, single ask_user announcement, focus hand-off after a card is answered, session-picker focus).
- `src/styles.contrast.test.ts`: parses the tokens in `styles.css` for the light palette (`:root`), the dark palette (`:root[data-theme="dark"]`) and its `prefers-color-scheme` mirror, and asserts:
  - 7:1 for every text token on every surface token;
  - 3:1 for every UI token (control border, focus, accent border) on every surface;
  - 7:1 for `--on-accent` on `--green`;
  - the mirror equals the explicit dark theme;
  - the `prefers-contrast: more` overrides keep hairlines/borders ≥3:1 and muted text ≥7:1;
  - no opaque hex colour outside the token blocks (it would not follow the theme) and no `opacity` on text.

  Adding or changing a colour token requires no manual list: the test iterates over the token groups. A *new* surface or text token must be added to the arrays at the top of the test.
- Vitest processes `styles.css` (`test.css.include` in `vite.config.ts`) so that `?raw` imports return the stylesheet contents.

## Success criteria matrix

Legend: **A** = covered by an automated test, **M** = manual check required, **n/a** = not applicable.

| SC | Level | Check | Notes |
|---|---|---|---|
| 1.1.1 Non-text content | A | A + M | axe; verify icon names manually |
| 1.2.x Time-based media | A/AA | n/a | No audio or video |
| 1.3.1 Info and relationships | A | A + M | Landmarks, headings, fieldsets; full-app axe test |
| 1.3.2 Meaningful sequence | A | M | Reading order at every breakpoint |
| 1.3.4 Orientation | AA | M | |
| 1.3.5 Identify input purpose | AA | M | Few personal-data fields |
| 1.4.1 Use of colour | A | M | |
| 1.4.3 / 1.4.6 Contrast | AA/AAA | A | `styles.contrast.test.ts` |
| 1.4.4 Resize text | AA | M | 200% text size |
| 1.4.10 Reflow | AA | M | 320 CSS px / 400% zoom |
| 1.4.11 Non-text contrast | AA | A + M | Tokens tested; check states manually |
| 1.4.12 Text spacing | AA | M | Bookmarklet |
| 1.4.13 Content on hover/focus | AA | M | |
| 2.1.1 / 2.1.2 Keyboard, no trap | A | A + M | Dialog tests |
| 2.4.1 Bypass blocks | A | A | Skip link |
| 2.4.2 Page titled | A | A | `document.title` |
| 2.4.3 Focus order | A | A + M | Focus is restored after a dialog closes |
| 2.4.6 Headings and labels | AA | M | |
| 2.4.7 Focus visible | AA | A + M | Global rule tested in the stylesheet test; check every new control manually |
| 2.4.11 Focus not obscured | AA | M | `scroll-padding`; no sticky overlays over the composer |
| 2.5.3 Label in name | A | M | |
| 2.5.7 Dragging movements | AA | A | Splitters can be dragged but also resized with the keyboard |
| 2.5.8 Target size (minimum) | AA | M | |
| 3.1.1 Language of page | A | A | `<html lang>` |
| 3.2.x Predictable | A/AA | M | |
| 3.3.1 / 3.3.2 / 3.3.3 Input assistance | A/AA | M | |
| 3.3.7 Redundant entry, 3.3.8 Accessible authentication | A/AA | n/a / M | No login flow |
| 4.1.2 Name, role, value | A | A | axe |
| 4.1.3 Status messages | AA | A + M | Live-region policy tested; verify with a screen reader |

## Manual test protocol

Run this protocol on each release that changes the UI.

1. **Keyboard only.**
   - Tab through every view. The skip link appears first.
   - Focus is always visible (including chips, tabs, splitters, menu items, palette options, the composer) and never hidden behind sticky content.
   - Dialogs trap focus, Escape closes them, and focus returns to the trigger.
   - There are no keyboard traps; the shortcuts in the table above work.
2. **VoiceOver + Safari (macOS).**
   - Check the landmarks and heading rotor: one `h1`, `Backlog`, `Refinement workspace` and `Item details` regions.
   - Every button and field has a correct name.
   - Chat start and finish are announced once each (not by the status pill as well).
   - Import (guidance, project backup) and indexing statuses are announced.
   - **ask_user flow.** Send a message that makes the agent ask questions. Expect "The agent has N questions" once, then focus on the card's heading region. Use VO+Right to read the question, options and rationale. Press `1`–`3`: the option becomes selected (radio announced as selected). Press Enter: "Question 2 of 3: …" is announced and focus moves to the new question. Submit; the summary region appears and focus lands in the message box. Repeat with Esc (skip) and with the "Other" text box (digits must type, not select).
   - **Review flow.** Make the agent propose changes. Expect focus on the proposal heading. Navigate the sections: each says its heading, change mode and state ("Accepted"). Accept, reject and edit one section; each decision is announced; closing the editor returns focus to the Edit button. Apply: the result summary is read and focus lands in the message box. Check that the *Item details › Document* tab describes the proposed changes in text.
   - **Collaboration.** With a second user, check "Anna joined/left", "Updated by Anna" and that saving does not chatter. Force a conflict: the dialog takes focus and each conflict is a labelled radiogroup.
3. **NVDA + Firefox/Chrome (Windows).** Repeat step 2 (browse and focus mode; the live-region texts above must be read once).
4. **200% text size.** Increase the browser's text size only. Nothing is clipped or overlaps; the topbar may wrap.
5. **400% zoom at 1280 px**, which equals 320 CSS px. Content reflows with no horizontal scrolling, except in the Markdown preview of wide tables. Use the mobile tabs to switch panels.
6. **Text spacing.** Apply the WCAG 1.4.12 bookmarklet (line height 1.5, paragraph spacing 2, letter spacing 0.12, word spacing 0.16). No content is lost.
7. **Forced colours.** Use Windows High Contrast, or Chrome DevTools forced-colors emulation. Borders, focus rings, status dots, pills, selected rows and splitter handles remain visible.
8. **Dark mode.** Switch the OS to dark mode with Settings › Appearance on *System*, then choose *Light* and *Dark* explicitly. Check text, borders, focus and selected states in both themes, and that a reload keeps the choice without a flash of the wrong theme.
9. **Increased contrast.** Use macOS *Increase contrast*, or emulate `prefers-contrast: more`.
10. **Reduced motion.** Enable *Reduce motion*. No animations or transitions run (caret, skeleton, spinner, pulse dots).

Record the date, browser and assistive technology versions, and any findings, in the pull request.

## Known limitations

- The `--line` dividers are decorative and intentionally below 3:1.
- Rendered Markdown can contain user-authored content, such as images without alt text or wide tables, that the app cannot fix.
- axe-core in jsdom does not cover layout, contrast or screen-reader behaviour.
- The 7:1 test covers the design tokens. Text that is coloured by the browser (e.g. the default link colour in user-authored Markdown) is styled with `--accent-text` in the app, but third-party content is not checked.
- A pending tooltip, popover or toast can overlap content at 400% zoom; they are dismissible with Esc or the close button.
- Screen-reader behaviour (VoiceOver, NVDA) is only covered by the manual protocol.
