import { readLocalValue, writeLocalValue } from './localPersistence';

const KEY = 'easel_chat_model_ref';
const CHANGED = 'easel:composer-model-changed';
export function isCompleteModelRef(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 300 && /^[^\s/]+\/[^\s]+$/.test(value);
}
export function loadComposerModel(): string {
  const saved = readLocalValue(KEY);
  return saved.ok && isCompleteModelRef(saved.value) ? saved.value : '';
}
export function saveComposerModel(value: string): boolean {
  const saved = (value === '' || isCompleteModelRef(value)) && writeLocalValue(KEY, value);
  if (saved) window.dispatchEvent(new window.Event(CHANGED));
  return saved;
}
export function subscribeComposerModel(listener: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) listener(); };
  window.addEventListener(CHANGED, listener); window.addEventListener('storage', storage);
  return () => { window.removeEventListener(CHANGED, listener); window.removeEventListener('storage', storage); };
}
