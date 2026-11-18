import { describe, expect, it } from 'vitest';
import css from './styles.css?raw';

const HEX = '#[0-9a-fA-F]{6}';

/** Returns the declaration body that starts at the first occurrence of `selector` after `from`. */
function blockAfter(selector: string, from = 0): string {
  const start = css.indexOf(selector, from);
  if (start < 0) throw new Error(`Block ${selector} not found`);
  return css.slice(start, css.indexOf('}', start));
}

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of block.matchAll(new RegExp(`--([a-z-]+):\\s*(${HEX})\\b`, 'g'))) out[match[1]] = match[2];
  return out;
}

const light = tokens(blockAfter(':root {'));
const dark = { ...light, ...tokens(blockAfter(':root[data-theme="dark"]')) };
const darkMirror = { ...light, ...tokens(blockAfter(':root:not([data-theme="light"])', css.indexOf('@media (prefers-color-scheme: dark)'))) };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const surfaces = ['panel', 'bg', 'panel-subtle', 'green-soft', 'violet-soft', 'warning-soft', 'danger-soft'];
// Tokens that are used as text colours anywhere in styles.css.
const textTokens = ['ink', 'muted', 'accent-text', 'accent-hover', 'violet-text', 'warning-text', 'danger'];
// Tokens that carry meaning in non-text UI: control borders, focus rings, status dots, accepted/selected outlines.
const uiTokens = ['border-control', 'focus', 'accent-border'];

const themes = { light, dark, 'dark (prefers-color-scheme mirror)': darkMirror } as const;

describe.each(Object.entries(themes))('colour tokens, %s theme (WCAG 1.4.6 / 1.4.11)', (_name, theme) => {
  it.each(textTokens)('text token --%s reaches 7:1 on every surface', (token) => {
    for (const surface of surfaces) {
      expect(contrast(theme[token], theme[surface]), `${token} on ${surface}`).toBeGreaterThanOrEqual(7);
    }
  });

  it.each(uiTokens)('UI token --%s reaches 3:1 on every surface', (token) => {
    for (const surface of surfaces) {
      expect(contrast(theme[token], theme[surface]), `${token} on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('accent controls (primary buttons, selected segments) reach 7:1 for text', () => {
    expect(contrast(theme['on-accent'], theme.green)).toBeGreaterThanOrEqual(7);
  });

  it('the focus ring reaches 3:1 against the accent fill it can sit on', () => {
    expect(contrast(theme.focus, theme.panel)).toBeGreaterThanOrEqual(3);
  });
});

describe('tokens stay in sync', () => {
  it('the prefers-color-scheme mirror equals the explicit dark theme', () => {
    expect(darkMirror).toEqual(dark);
  });

  it('follows the system preference unless light is chosen', () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/);
  });
});

describe('prefers-contrast: more overrides', () => {
  const lightMore = { ...light, ...tokens(blockAfter(':root {', css.indexOf('@media (prefers-contrast: more)'))) };
  const darkMore = { ...dark, ...tokens(blockAfter(':root[data-theme="dark"]', css.indexOf('@media (prefers-contrast: more)'))) };

  it('keeps hairlines and control borders above 3:1 and muted text above 7:1', () => {
    for (const [theme, bg] of [[lightMore, 'panel'], [darkMore, 'panel']] as const) {
      expect(contrast(theme.line, theme[bg])).toBeGreaterThanOrEqual(3);
      expect(contrast(theme['border-control'], theme[bg])).toBeGreaterThanOrEqual(3);
      for (const surface of surfaces) expect(contrast(theme.muted, theme[surface])).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('stylesheet hygiene', () => {
  const outsideTokenBlocks = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/:root[^{]*\{[^}]*\}/g, '')
    .split('\n')
    // Shadows and gradients use alpha colours and are decorative.
    .filter((line) => !/box-shadow|text-shadow|linear-gradient/.test(line));

  it('hard-codes no opaque colours outside the token blocks (they would break the dark theme)', () => {
    const offenders = outsideTokenBlocks.filter((line) => new RegExp(`${HEX}(?![0-9a-fA-F])`).test(line));
    expect(offenders).toEqual([]);
  });

  it('never dims text with opacity (it lowers contrast below the token value)', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    const offenders: string[] = [];
    for (const [, selector, body] of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      // Disabled controls are exempt from 1.4.3; skeleton lines hold no text; opacity: 0 only hides visually-hidden native inputs.
      if (/disabled|skeleton/.test(selector)) continue;
      if (/(^|[\s;])opacity:\s*0?\.[1-9]/.test(body)) offenders.push(selector.trim());
    }
    expect(offenders).toEqual([]);
  });

  it('keeps focus rings on every focusable control', () => {
    expect(css).toMatch(/\[tabindex\]:focus-visible/);
    expect(css).toMatch(/\.composer:focus-within\s*\{\s*outline: 3px solid var\(--focus\)/);
  });

  it('has forced-colors, reduced-motion and contrast fallbacks', () => {
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (prefers-contrast: more)');
  });
});
