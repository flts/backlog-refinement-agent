import { describe, expect, it } from 'vitest';
import css from './styles.css?raw';

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`Token --${name} not found`);
  return match[1];
}

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

describe('colour tokens (WCAG 1.4.6 / 1.4.11)', () => {
  const backgrounds = ['#ffffff', '#f5f6f8'];

  it.each(['ink', 'muted', 'green', 'violet'])('text token --%s reaches 7:1 on light surfaces', (name) => {
    for (const bg of backgrounds) expect(contrast(token(name), bg)).toBeGreaterThanOrEqual(7);
  });

  it('control borders reach 3:1 against white', () => {
    expect(css).toContain('#8a909b');
    expect(contrast('#8a909b', '#ffffff')).toBeGreaterThanOrEqual(3);
  });

  it('primary button text reaches 7:1', () => {
    expect(contrast('#ffffff', '#1a5c3f')).toBeGreaterThanOrEqual(7);
  });
});

describe('dark palette (WCAG 1.4.6 / 1.4.11)', () => {
  const start = css.indexOf(':root[data-theme="dark"]');
  const block = css.slice(start, css.indexOf('}', start));
  const dark = (name: string): string => {
    const match = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
    if (!match) throw new Error(`Dark token --${name} not found`);
    return match[1];
  };

  it.each(['ink', 'muted', 'green', 'violet', 'accent-text', 'warning-text', 'danger'])('text token --%s reaches 7:1 on dark surfaces', (name) => {
    for (const bg of ['bg', 'panel', 'panel-subtle']) expect(contrast(dark(name), dark(bg))).toBeGreaterThanOrEqual(7);
  });

  it('accent button text reaches 7:1', () => {
    expect(contrast(dark('on-accent'), dark('green'))).toBeGreaterThanOrEqual(7);
  });

  it('control borders and focus reach 3:1', () => {
    for (const name of ['border-control', 'focus']) expect(contrast(dark(name), dark('panel'))).toBeGreaterThanOrEqual(3);
  });

  it('follows the system preference unless light is chosen', () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/);
  });
});
