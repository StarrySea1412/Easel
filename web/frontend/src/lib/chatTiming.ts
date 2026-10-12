export interface ChatTiming { startedAt?: number; elapsedMs?: number }

export function decodeChatTiming(value: unknown): ChatTiming {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>, result: ChatTiming = {};
  if (typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) && raw.startedAt > 0 && raw.startedAt <= 8640000000000000) result.startedAt = raw.startedAt;
  if (typeof raw.elapsedMs === 'number' && Number.isFinite(raw.elapsedMs) && raw.elapsedMs >= 0 && raw.elapsedMs <= 31536000000) result.elapsedMs = raw.elapsedMs;
  return result;
}

export function finishChatTiming(value: ChatTiming, now = Date.now()): ChatTiming {
  return { ...value, ...(value.elapsedMs === undefined && value.startedAt !== undefined
    ? { elapsedMs: Math.max(0, now - value.startedAt) } : {}) };
}

export function formatChatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours}小时${minutes}分${seconds % 60}秒` : minutes ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}
