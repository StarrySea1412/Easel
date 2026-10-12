import type { ThinkingLevel } from './api';
import { readLocalValue, writeLocalValue } from './localPersistence';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max', 'ultra',
];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';
export type ThinkingPreference = ThinkingLevel | 'auto';
export const DEFAULT_THINKING_PREFERENCE: ThinkingPreference = 'auto';
export function resolveThinkingPreference(value: ThinkingPreference, supported?: readonly string[]): ThinkingLevel | undefined {
  if (value !== 'auto') return compatibleThinkingLevel(value, supported);
  // Auto is a UI preference, never an upstream effort parameter.
  const strongest = [...THINKING_LEVELS].reverse().find(level => level !== 'adaptive' && level !== 'off' && supported?.includes(level));
  return strongest || (supported?.includes('adaptive') ? 'adaptive' : supported?.includes('off') ? 'off' : undefined);
}
export function compatibleThinkingLevel(value: ThinkingLevel, supported?: readonly string[]): ThinkingLevel {
  const available = THINKING_LEVELS.filter(level => supported?.includes(level));
  if (!available.length || available.includes(value)) return value;
  // Adaptive is the model's own choice; otherwise use the nearest allowed
  // strength, preferring the lower one when equally close.
  if (available.includes('adaptive')) return 'adaptive';
  const strengths: readonly ThinkingLevel[] = THINKING_LEVELS.filter(level => level !== 'adaptive');
  const index = strengths.indexOf(value === 'adaptive' ? 'medium' : value);
  return available.reduce((best, level) => Math.abs(strengths.indexOf(level) - index) < Math.abs(strengths.indexOf(best) - index) ? level : best);
}
// New default requested by the user; previous automatically clamped values
// must not turn into manual preferences in the new auto mode.
const KEY = 'easel_thinking_preference';

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function loadThinkingLevel(): ThinkingPreference {
  const result = readLocalValue(KEY);
  return result.ok && (result.value === 'auto' || isThinkingLevel(result.value)) ? result.value : DEFAULT_THINKING_PREFERENCE;
}

export function saveThinkingLevel(value: ThinkingPreference): boolean {
  return writeLocalValue(KEY, value);
}

export const THINKING_LABELS: Record<ThinkingPreference, string> = {
  auto: '自适应最高',
  off: '关闭', minimal: '极简', low: '低', medium: '中', high: '高',
  xhigh: '极高', adaptive: '自适应', max: '最大', ultra: 'Ultra',
};
