import type { ThinkingLevel } from './api';
import { readLocalValue, writeLocalValue } from './localPersistence';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max', 'ultra',
];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';
const KEY = 'easel_thinking_level';

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function loadThinkingLevel(): ThinkingLevel {
  const result = readLocalValue(KEY);
  return result.ok && isThinkingLevel(result.value) ? result.value : DEFAULT_THINKING_LEVEL;
}

export function saveThinkingLevel(value: ThinkingLevel): boolean {
  return writeLocalValue(KEY, value);
}
