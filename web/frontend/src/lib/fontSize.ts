export const FONT_SIZE_STORAGE_KEY = 'easel:font-size';
export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 20;
export const FONT_SIZE_STEP = 0.1;

let snapshot = { size: DEFAULT_FONT_SIZE, persisted: true };
const listeners = new Set<() => void>();
let cleanup: (() => void) | undefined;

function normalize(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_FONT_SIZE;
  return Math.round(Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, value)) * 10) / 10;
}

function fromStorage(value: string | null) {
  if (!value?.trim()) return DEFAULT_FONT_SIZE;
  const size = Number(value);
  return Number.isFinite(size) && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE ? normalize(size) : DEFAULT_FONT_SIZE;
}

function apply(size: number, persisted: boolean) {
  document.documentElement.style.setProperty('--easel-font-size', `${size}px`);
  document.documentElement.style.setProperty('--easel-font-scale', String(size / DEFAULT_FONT_SIZE));
  if (snapshot.size === size && snapshot.persisted === persisted) return;
  snapshot = { size, persisted };
  listeners.forEach(listener => listener());
}

export function initializeFontSize() {
  if (cleanup) return cleanup;
  let size = DEFAULT_FONT_SIZE;
  let persisted = true;
  try { size = fromStorage(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)); } catch { persisted = false; }
  apply(size, persisted);
  const storageChanged = (event: StorageEvent) => {
    if (event.storageArea === window.sessionStorage) return;
    if (event.key === FONT_SIZE_STORAGE_KEY || event.key === null) apply(fromStorage(event.newValue), true);
  };
  window.addEventListener('storage', storageChanged);
  cleanup = () => { window.removeEventListener('storage', storageChanged); cleanup = undefined; };
  return cleanup;
}

export function setFontSize(size: number) {
  if (!Number.isFinite(size)) return;
  size = normalize(size);
  let persisted = true;
  try { window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(size)); } catch { persisted = false; }
  apply(size, persisted);
}

export const readFontSize = () => snapshot;
export const subscribeFontSize = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
