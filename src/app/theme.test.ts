import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, getThemePreference, setThemePreference, THEME_STORAGE_KEY } from './theme';

describe('theme preference', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f5f6f8"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#121417">';
  });
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    vi.restoreAllMocks();
  });

  const metaContents = () => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((meta) => meta.content);

  it('defaults to system and ignores unknown values', () => {
    expect(getThemePreference()).toBe('system');
    localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(getThemePreference()).toBe('system');
  });

  it('stores a manual choice and applies it to the document', () => {
    setThemePreference('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(getThemePreference()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(metaContents()).toEqual(['#121417', '#121417']);
  });

  it('removes the override when returning to system', () => {
    setThemePreference('light');
    setThemePreference('system');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(metaContents()).toEqual(['#f5f6f8', '#121417']);
  });

  it('falls back to system when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(getThemePreference()).toBe('system');
    expect(() => setThemePreference('dark')).not.toThrow();
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
