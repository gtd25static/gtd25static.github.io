export type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'gtd25-theme';
const THEME_EVENT = 'gtd25-theme-change';
const THEMES: readonly string[] = ['light', 'dark', 'system'];

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && THEMES.includes(value);
}

export function getStoredTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  return isTheme(stored) ? stored : 'system';
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'dark' || (theme === 'system' && systemPrefersDark())) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

/**
 * Save, apply and announce a theme. Everything that sets it goes through here —
 * the Settings pick, an import, a restore, a sync — so it takes effect at once
 * (an imported theme used to wait for a reload) and every useTheme() follows.
 * Unknown values (a synced or imported file is untrusted) are ignored.
 */
export function storeTheme(theme: unknown): void {
  if (!isTheme(theme)) return;
  localStorage.setItem(THEME_KEY, theme);
  // Called in the middle of an import or a force pull: showing the theme must
  // never be what aborts one.
  try {
    applyTheme(theme);
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: theme }));
  } catch (e) {
    console.warn('Could not apply the theme:', e);
  }
}

export function onThemeChange(listener: (theme: Theme) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<Theme>).detail);
  window.addEventListener(THEME_EVENT, handler);
  return () => window.removeEventListener(THEME_EVENT, handler);
}
