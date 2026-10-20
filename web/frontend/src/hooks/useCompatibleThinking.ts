import { useEffect } from 'react';
import { resolveThinkingPreference, saveThinkingLevel, THINKING_LABELS, THINKING_LEVELS } from '../lib/thinkingLevel';
import type { ThinkingPreference } from '../lib/thinkingLevel';

/** Resolve before sending too: a capability response can arrive before effects run. */
export function useCompatibleThinking(value: ThinkingPreference, supported: string[] | undefined, change: (value: ThinkingPreference) => void) {
  const resolved = resolveThinkingPreference(value, supported);
  useEffect(() => {
    if (value !== 'auto' && resolved && resolved !== value) { change(resolved); saveThinkingLevel(resolved); }
  }, [resolved, value, change]);
  const restricted = Boolean(supported?.length && THINKING_LEVELS.some(level => !supported.includes(level)));
  return { level: resolved, notice: value === 'auto'
    ? resolved ? `自适应最高：当前模型使用${THINKING_LABELS[resolved]}，切换模型后自动匹配。可在此手动调整；能力声明不代表调用成功。` : '正在读取模型支持的档位；尚未确认时沿用模型默认，不发送猜测的强度。'
    : !resolved ? '尚未确认模型档位，暂时沿用模型默认；保留手动偏好，读取能力后再匹配。'
    : restricted || resolved !== value
    ? `已按网关能力声明使用${THINKING_LABELS[resolved]}。可选：${supported?.map(level => THINKING_LABELS[level as ThinkingPreference] || level).join('、')}。能力声明不代表本轮执行已验证。` : '' };
}
