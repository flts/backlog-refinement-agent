# Accessibility

Target: **WCAG 2.2 level AA**, plus **SC 1.4.6 Contrast (Enhanced, AAA)**, which requires 7:1 contrast for text. The app respects operating-system and browser settings: zoom, text size, colour scheme (light/dark), reduced motion, increased contrast and forced colours. The only in-app display preference is the theme (System, Light or Dark) under Settings › General.

> Automated checks (axe-core, contrast tests) catch only part of WCAG. Passing them is **not** a conformance claim. Use the manual protocol below before claiming conformance.

## Principles

- Use native HTML first: `<button>`, `<dialog>`, `<fieldset>`/`<legend>`, `<label>`. Use ARIA only where HTML has no equivalent.
- Every interactive element is reachable and operable with the keyboard, and has a visible focus indicator with at least 3:1 contrast.
- Never use colour alone to convey state.
- Size everything in `rem`, so layouts survive 200% text size and 400% zoom at a width of 320 CSS px.

## Implemented measures

| Area | Measure | SC |
|---|---|---|
| App shell (`App.tsx`) | Skip link to `main#main`. One `h1`. `document.title` updated per view. | 2.4.1, 2.4.2, 1.3.1 |
| Loading / errors | Loading screen with `aria-busy` and `role="status"`. Bootstrap, configuration and sign-in errors (`StatusScreen.tsx`) use `role="alert"`, a heading and a retry button. | 4.1.3 |
| Chat (`chat/`) | Streamed tokens are not read aloud: the transcript is `role="log"` with `aria-live="off"` and the streaming message is `aria-busy`. Two visually hidden regions announce phase changes: polite ("Agent is working", "Agent replied", "Agent needs your input", "Review proposed changes") and assertive (errors). Markdown output is sanitised (no raw HTML, http(s)/mailto links only). Activity timeline is a disclosure button (`aria-expanded`) with text status for every row; spinners and the caret respect `prefers-reduced-motion`. Session picker is a disclosure with native buttons (Esc closes, focus returns). Esc in the composer stops a running agent; a Stop button is always available. Run errors show code and run ID with Copy and Retry. | 4.1.3, 2.1.1, 2.2.2, 2.3.3, 4.1.2 |
| Ask-user card (`askuser/`) | Card is a labelled `section` that takes focus when it appears (never from a text field the user is typing in) and announces “The agent has N questions” politely. Questions are a WAI-ARIA tabs stepper (roving tabindex, ←/→/Home/End) with “Question n of N”; answered/skipped state is text, not colour only. Options are a native radio group (checkbox group for multi-select); “Other” has its own labelled textarea. Keys `1`–`5` choose, `Enter` next/submit, `Esc` skips; the digit keys are ignored inside text fields and Shift+Enter adds a line in the “Other” box. Answered and dismissed summaries are labelled regions. | 2.1.1, 4.1.2, 4.1.3, 1.4.1, 3.3.2 |
| Command palette (`palette/`) | Native modal `<dialog>` with a WAI-ARIA combobox: the input keeps focus and points to the option with `aria-activedescendant`; grouped `listbox` (Items, Agent commands, Actions); arrows/Home/End move, Enter runs, Esc closes and focus returns to the opener. A hidden live region announces the result count. Semantic hits carry a text badge. Composer `/` and `@` menus use the same pattern on the textarea (`aria-controls`, `aria-activedescendant`; Tab/Enter choose, Esc closes without stopping a run). | 2.1.1, 4.1.2, 4.1.3, 2.4.3 |
| Context bar (`context/`) | Chips are focusable, with tooltips linked by `aria-describedby` that appear on hover and focus and close with Esc. The related-items popover is a disclosure button (`aria-expanded`) that closes with Esc and returns focus. The pinned budget is a `role="meter"` with text. | 1.4.13, 2.1.1, 4.1.2 |
| Modals (`useModalDialog.ts`) | Native modal `<dialog>`: focus trap, Escape closes the dialog, focus returns to the trigger, accessible name via `aria-labelledby`. | 2.1.2, 2.4.3, 4.1.2 |
| Settings (`SettingsModal.tsx`) | `fieldset`/`legend` group the Account (name, email, Sign out) and Appearance sections. Status message for configuration import. `aria-busy` while importing. | 1.3.1, 3.3.2, 4.1.3 |
| Sources drawer (`sources/`) | Modal `<dialog>` (focus moves to Close, focus trap, Escape, focus returns to the trigger). Pinned budget is a `role="meter"` with text. Mode is a `radiogroup` of native radios. Index status uses glyph plus text, never colour alone. Errors use `role="alert"`, successes `role="status"`. Row actions are a keyboard-operable menu; removal needs an inline confirmation. | 2.1.2, 1.4.1, 3.3.1, 4.1.2, 4.1.3 |
| Topbar (`shell/`) | `header` with native buttons. Project switcher, Settings and "More" are WAI-ARIA menu buttons (`aria-haspopup`, `aria-expanded`; arrows, Home/End, Escape; projects are `menuitemradio`). The account button opens a labelled disclosure panel. The agent status pill is a polite `role="status"` live region with text for every state. Up to 1100 px wide the secondary controls collapse into the "More" menu. | 4.1.2, 4.1.3, 2.1.1, 1.4.10 |
| Panel splitters (`shell/`) | Splitters are focusable `role="separator"` with `aria-valuenow/min/max`: arrows resize by 16 px, Home/End jump to the limits, Enter or double-click resets. Dragging is optional. Focus mode (Ctrl/⌘+. or the topbar button, `aria-pressed`) shows only the panel last used and is announced. | 2.1.1, 2.5.7, 4.1.2, 4.1.3 |
| Mobile tabs | Toggle buttons expose their state with `aria-pressed`. | 4.1.2 |
| Icons / glyphs | Decorative glyphs are `aria-hidden`. Icon-only buttons have an accessible name. | 1.1.1, 4.1.2 |
| Colour (`styles.css`) | Text tokens are at least 7:1 on their backgrounds. Borders of UI components are at least 3:1. | 1.4.3, 1.4.6, 1.4.11 |
| Focus | `:focus-visible` outline with at least 3:1 contrast and an offset. Focused elements are not hidden by sticky elements. | 2.4.7, 2.4.11, 2.4.13 (partial) |
| Targets | Interactive targets are at least 24×24 CSS px. | 2.5.8 |
| Reflow / text | `rem` typography, no fixed heights on text containers, panels stack on narrow viewports. | 1.4.4, 1.4.10, 1.4.12 |
| Theme | Light and dark palettes share the same colour tokens. By default `prefers-color-scheme` decides; a manual choice sets `data-theme` on `<html>`. Both palettes meet 7:1 for text and 3:1 for borders and focus. | 1.4.3, 1.4.6, 1.4.11 |
| Preferences | `prefers-reduced-motion` disables animation. `prefers-contrast: more` strengthens borders and text. `forced-colors: active` uses system colours and keeps focus and borders visible. | 2.3.3 (AAA), 1.4.11 |

## Automated checks

- `src/test/axe.ts`: `expectNoAxeViolations(container)` runs axe-core in component tests (`components.test.tsx`, `workspace-panels.test.tsx`). The `color-contrast` rule is disabled because jsdom does not compute layout or colours.
- `src/styles.contrast.test.ts`: parses the colour tokens in `styles.css` and asserts these contrast ratios:
  - 7:1 for text;
  - 3:1 for UI borders and focus indicators.

  This applies to both the light palette (`:root`) and the dark palette (`:root[data-theme="dark"]`, mirrored in the `prefers-color-scheme: dark` media query).

  Adding or changing a colour token requires updating this test.
- Vitest processes `styles.css` (`test.css.include` in `vite.config.ts`) so that `?raw` imports return the stylesheet contents.

## Success criteria matrix

Legend: **A** = covered by an automated test, **M** = manual check required, **n/a** = not applicable.

| SC | Level | Check | Notes |
|---|---|---|---|
| 1.1.1 Non-text content | A | A + M | axe; verify icon names manually |
| 1.2.x Time-based media | A/AA | n/a | No audio or video |
| 1.3.1 Info and relationships | A | A + M | Landmarks, headings, fieldsets |
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
| 2.4.7 Focus visible | AA | M | |
| 2.4.11 Focus not obscured | AA | M | |
| 2.5.3 Label in name | A | M | |
| 2.5.7 Dragging movements | AA | n/a | No dragging |
| 2.5.8 Target size (minimum) | AA | M | |
| 3.1.1 Language of page | A | A | `<html lang>` |
| 3.2.x Predictable | A/AA | M | |
| 3.3.1 / 3.3.2 / 3.3.3 Input assistance | A/AA | M | |
| 3.3.7 Redundant entry, 3.3.8 Accessible authentication | A/AA | n/a / M | No login flow |
| 4.1.2 Name, role, value | A | A | axe |
| 4.1.3 Status messages | AA | A + M | Live regions; verify with a screen reader |

## Manual test protocol

Run this protocol on each release that changes the UI.

1. **Keyboard only.**
   - Tab through every view. The skip link appears first.
   - Focus is always visible and never hidden behind sticky content.
   - Dialogs trap focus, Escape closes them, and focus returns to the trigger.
   - There are no keyboard traps.
2. **VoiceOver + Safari (macOS).**
   - Check the landmarks and heading rotor.
   - Every button and field has a correct name.
   - Chat start and finish are announced once each.
   - Import and model-loading statuses are announced.
3. **NVDA + Firefox/Chrome (Windows).** Repeat step 2.
4. **200% text size.** Increase the browser's text size only. Nothing is clipped or overlaps.
5. **400% zoom at 1280 px**, which equals 320 CSS px. Content reflows with no horizontal scrolling, except in the Markdown preview of wide tables.
6. **Text spacing.** Apply the WCAG 1.4.12 bookmarklet (line height 1.5, paragraph spacing 2, letter spacing 0.12, word spacing 0.16). No content is lost.
7. **Forced colours.** Use Windows High Contrast, or Chrome DevTools forced-colors emulation. Borders, focus and selected states remain visible.
8. **Dark mode.** Switch the OS to dark mode with Settings › General › Appearance on *System*, then choose *Light* and *Dark* explicitly. Check text, borders, focus and selected states in both themes, and that a reload keeps the choice without a flash of the wrong theme.
9. **Increased contrast.** Use macOS *Increase contrast*, or emulate `prefers-contrast: more`.
10. **Reduced motion.** Enable *Reduce motion*. No animations or transitions run.

Record the date, browser and assistive technology versions, and any findings, in the pull request.

## Known limitations

- The `--line` dividers are decorative and intentionally below 3:1.
- Rendered Markdown can contain user-authored content, such as images without alt text or wide tables, that the app cannot fix.
- axe-core in jsdom does not cover layout, contrast or screen-reader behaviour.
