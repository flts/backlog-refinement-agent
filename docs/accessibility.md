# Accessibility

Target: **WCAG 2.2 level AA**, plus **SC 1.4.6 Contrast (Enhanced, AAA)**, which requires 7:1 contrast for text. The app has no in-app display preferences. It respects operating-system and browser settings instead: zoom, text size, reduced motion, increased contrast and forced colours.

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
| Loading / errors | Loading screen with `aria-busy` and `role="status"`. Bootstrap error with `role="alert"`. | 4.1.3 |
| Chat (`ChatPanel.tsx`) | A single visually hidden `role="status"` announces "Refinement agent is responding…" and "Refinement agent finished responding.", instead of reading the streamed tokens aloud. | 4.1.3 |
| Modals (`useModalDialog.ts`) | Native modal `<dialog>`: focus trap, Escape closes the dialog, focus returns to the trigger, accessible name via `aria-labelledby`. | 2.1.2, 2.4.3, 4.1.2 |
| Settings (`SettingsModal.tsx`) | `fieldset`/`legend` group the LLM connection fields. Status messages for model loading and configuration import. `aria-busy` while importing. | 1.3.1, 3.3.2, 4.1.3 |
| Mobile tabs | Toggle buttons expose their state with `aria-pressed`. | 4.1.2 |
| Icons / glyphs | Decorative glyphs are `aria-hidden`. Icon-only buttons have an accessible name. | 1.1.1, 4.1.2 |
| Colour (`styles.css`) | Text tokens are at least 7:1 on their backgrounds. Borders of UI components are at least 3:1. | 1.4.3, 1.4.6, 1.4.11 |
| Focus | `:focus-visible` outline with at least 3:1 contrast and an offset. Focused elements are not hidden by sticky elements. | 2.4.7, 2.4.11, 2.4.13 (partial) |
| Targets | Interactive targets are at least 24×24 CSS px. | 2.5.8 |
| Reflow / text | `rem` typography, no fixed heights on text containers, panels stack on narrow viewports. | 1.4.4, 1.4.10, 1.4.12 |
| Preferences | `prefers-reduced-motion` disables animation. `prefers-contrast: more` strengthens borders and text. `forced-colors: active` uses system colours and keeps focus and borders visible. | 2.3.3 (AAA), 1.4.11 |

## Automated checks

- `src/test/axe.ts`: `expectNoAxeViolations(container)` runs axe-core in component tests (`components.test.tsx`, `workspace-panels.test.tsx`). The `color-contrast` rule is disabled because jsdom does not compute layout or colours.
- `src/styles.contrast.test.ts`: parses the colour tokens in `styles.css` and asserts these contrast ratios:
  - 7:1 for text;
  - 3:1 for UI borders and focus indicators.

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
8. **Increased contrast.** Use macOS *Increase contrast*, or emulate `prefers-contrast: more`.
9. **Reduced motion.** Enable *Reduce motion*. No animations or transitions run.

Record the date, browser and assistive technology versions, and any findings, in the pull request.

## Known limitations

- There is no dark mode. `prefers-color-scheme: dark` is not yet supported.
- The `--line` dividers are decorative and intentionally below 3:1.
- Rendered Markdown can contain user-authored content, such as images without alt text or wide tables, that the app cannot fix.
- axe-core in jsdom does not cover layout, contrast or screen-reader behaviour.
