export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'theme-preference';
const themeColors = { light: '#f5f6f8', dark: '#121417' } as const;

export function getThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage may be unavailable (private mode); the choice still applies for this session.
  }
  applyTheme(preference);
}

export function applyTheme(preference: ThemePreference, root: HTMLElement = document.documentElement): void {
  if (preference === 'system') delete root.dataset.theme;
  else root.dataset.theme = preference;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    const scheme = preference === 'system' ? ((meta.getAttribute('media') ?? '').includes('dark') ? 'dark' : 'light') : preference;
    meta.content = themeColors[scheme];
  });
}
