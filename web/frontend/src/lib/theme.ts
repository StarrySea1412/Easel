export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
export const THEME_STORAGE_KEY = 'easel:theme';
const valid = (value: unknown): value is ThemePreference => value === 'system' || value === 'light' || value === 'dark';
let snapshot: { preference: ThemePreference; resolved: ResolvedTheme; persisted: boolean } = { preference: 'system', resolved: 'light', persisted: true };
const listeners = new Set<() => void>();
let media: MediaQueryList | undefined;
let cleanup: (() => void) | undefined;

function apply(preference: ThemePreference, persisted = true) {
  const resolved = preference === 'system' ? (media?.matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  if (snapshot.preference === preference && snapshot.resolved === resolved && snapshot.persisted === persisted) return;
  snapshot = { preference, resolved, persisted };
  listeners.forEach(listener => listener());
}

/** Bootstrap and runtime use the same storage and validation contract. */
export function initializeTheme() {
  if (cleanup) return cleanup;
  media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;
  let preference: ThemePreference = 'system';
  let persisted = true;
  try { const stored = window.localStorage.getItem(THEME_STORAGE_KEY); if (valid(stored)) preference = stored; } catch { persisted = false; }
  apply(preference, persisted);
  const systemChanged = () => { if (snapshot.preference === 'system') apply('system', snapshot.persisted); };
  const storageChanged = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key === THEME_STORAGE_KEY || event.key === null) apply(valid(event.newValue) ? event.newValue : 'system');
  };
  media?.addEventListener('change', systemChanged);
  window.addEventListener('storage', storageChanged);
  cleanup = () => { media?.removeEventListener('change', systemChanged); window.removeEventListener('storage', storageChanged); cleanup = undefined; };
  return cleanup;
}

export function setThemePreference(preference: ThemePreference) {
  if (!valid(preference)) return;
  let persisted = true;
  try { window.localStorage.setItem(THEME_STORAGE_KEY, preference); } catch { persisted = false; }
  apply(preference, persisted);
}
export const readTheme = () => snapshot;
export const subscribeTheme = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
