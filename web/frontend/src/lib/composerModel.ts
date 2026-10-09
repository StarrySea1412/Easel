import { readLocalValue, writeLocalValue } from './localPersistence';

const KEY = 'easel_chat_model_ref';
export function isCompleteModelRef(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 300 && /^[^\s/]+\/[^\s]+$/.test(value);
}
export function loadComposerModel(): string {
  const saved = readLocalValue(KEY);
  return saved.ok && isCompleteModelRef(saved.value) ? saved.value : '';
}
export function saveComposerModel(value: string): boolean {
  return (value === '' || isCompleteModelRef(value)) && writeLocalValue(KEY, value);
}
