/** Phase-2 protected-data recovery: show, replace, then unprotect.
 *
 * Corrupt localStorage stays untouched until the user confirms a specific
 * replacement; only a successful write unprotects the key, and a failed write
 * leaves protection in place so it can be retried.
 */
import { readLocalValue, writeLocalValue, reportLocalPersistenceFailure } from './localPersistence';

export const RECOVERY_KEYS = ['easel_sessions', 'easel-sessions', 'postcraft_sessions', 'easel_publish_draft', 'postcraft_publish_draft'] as const;
export type RecoveryKey = typeof RECOVERY_KEYS[number];

export interface RecoveryCandidate {
  key: string;
  readable: boolean;
  size: number;
  /** A short, human-checked sample of the value; null when unreadable or absent. */
  sample: string | null;
  present: boolean;
}

export interface RecoveryPlan {
  candidates: RecoveryCandidate[];
}

/** Snapshot what protection currently guards. Unreadable keys keep protection. */
export function inspectProtectedData(): RecoveryPlan {
  const candidates = RECOVERY_KEYS.map((key): RecoveryCandidate => {
    const result = readLocalValue(key);
    if (!result.ok) return { key, readable: false, size: 0, sample: null, present: false };
    if (result.value === null) return { key, readable: true, size: 0, sample: null, present: false };
    return { key, readable: true, size: result.value.length, sample: result.value.slice(0, 120), present: true };
  });
  return { candidates };
}

export interface ReplacementResult {
  status: 'written' | 'failed' | 'rejected';
  message: string;
}

function isRecoveryKey(key: string): key is RecoveryKey {
  return (RECOVERY_KEYS as readonly string[]).includes(key);
}

/** Replace one protected key. Only a confirmed write may unprotect it. */
export function replaceProtectedValue(key: string, value: string): ReplacementResult {
  if (!isRecoveryKey(key)) return { status: 'rejected', message: '该键不在会话恢复范围内，已拒绝写入。' };
  if (value.length > 20 * 1024 * 1024) return { status: 'rejected', message: '替换内容超过 20 MiB 上限，已拒绝写入。' };
  const ok = writeLocalValue(key, value, { queueOnFailure: false });
  if (!ok) {
    reportLocalPersistenceFailure(key, 'write', 'unreadable');
    return { status: 'failed', message: `写入 ${key} 失败，原受保护数据未变动，可重试或先导出备份。` };
  }
  return { status: 'written', message: `${key} 已恢复，保护已解除。刷新页面后生效。` };
}

