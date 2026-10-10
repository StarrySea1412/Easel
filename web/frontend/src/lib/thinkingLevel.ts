import type { ThinkingLevel } from './api';
import { readLocalValue, writeLocalValue } from './localPersistence';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max', 'ultra',
];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';
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

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: '关闭', minimal: '极简', low: '低', medium: '中', high: '高',
  xhigh: '极高', adaptive: '自适应', max: '最大', ultra: 'Ultra',
};
