import { useEffect } from 'react';
import type { ThinkingLevel } from '../lib/api';
import { compatibleThinkingLevel, saveThinkingLevel, THINKING_LABELS, THINKING_LEVELS } from '../lib/thinkingLevel';

/** Resolve before sending too: a capability response can arrive before effects run. */
export function useCompatibleThinking(value: ThinkingLevel, supported: string[] | undefined, change: (value: ThinkingLevel) => void) {
  const resolved = compatibleThinkingLevel(value, supported);
  useEffect(() => {
    if (resolved !== value) { change(resolved); saveThinkingLevel(resolved); }
  }, [resolved, value, change]);
  const restricted = Boolean(supported?.length && THINKING_LEVELS.some(level => !supported.includes(level)));
  return { level: resolved, notice: restricted || resolved !== value
    ? `已按网关能力声明使用${THINKING_LABELS[resolved]}。可选：${supported?.map(level => THINKING_LABELS[level as ThinkingLevel] || level).join('、')}；不支持的档位已禁用。能力声明不代表本轮执行已验证。` : '' };
}
