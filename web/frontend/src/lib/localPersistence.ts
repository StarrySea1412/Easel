/** Storage is optional at runtime: blocked access must never prevent rendering. */
export interface LocalPersistenceStatus {
  unsaved: boolean;
  unavailable: boolean;
  message: string | null;
}

type FailureReason = 'quota' | 'unavailable' | 'invalid' | 'unreadable';
type Operation = 'read' | 'write';
const failures = new Map<string, { operation: Operation; reason: FailureReason }>();
const pendingWrites = new Map<string, string>();
const listeners = new Set<() => void>();
let snapshot: LocalPersistenceStatus = { unsaved: false, unavailable: false, message: null };
let notificationPending = false;

function updateStatus(): void {
  const issues = [...failures.values()];
  const unsaved = issues.some(issue => issue.operation === 'write');
  const unavailable = issues.some(issue => issue.reason !== 'quota');
  const unreadable = issues.some(issue => issue.reason === 'invalid' || issue.reason === 'unreadable');
  const message = unreadable
    ? '部分历史数据无法读取，已保留原始数据；当前更改可能尚未保存，请保留当前页面。'
    : unsaved
      ? (unavailable ? '浏览器存储不可用，最新更改尚未保存，请保留当前页面。'
        : '浏览器存储空间不足，最新更改尚未保存，请保留当前页面并释放存储空间。')
      : unavailable ? '无法读取浏览器中的历史数据，请检查浏览器存储权限。' : null;
  if (snapshot.unsaved === unsaved && snapshot.unavailable === unavailable && snapshot.message === message) return;
  snapshot = { unsaved, unavailable, message };
  // Callers sometimes save inside a React state updater. Notify after that
  // updater finishes, without throwing from subscriber code into the save.
  if (!notificationPending) {
    notificationPending = true;
    queueMicrotask(() => {
      notificationPending = false;
      for (const listener of listeners) {
        try { listener(); } catch { /* one observer must not break persistence */ }
      }
    });
  }
}

export function getLocalPersistenceStatus(): LocalPersistenceStatus { return snapshot; }
export function subscribeLocalPersistence(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function reportLocalPersistenceFailure(key: string, operation: Operation, reason: FailureReason): void {
  // If the newest value cannot be serialized or would replace unread history,
  // an older queued snapshot must not later be retried and reported as current.
  if (operation === 'write' && (reason === 'invalid' || reason === 'unreadable')) pendingWrites.delete(key);
  failures.set(`${operation}:${key}`, { operation, reason });
  updateStatus();
}

function clearFailure(key: string, operation: Operation): void {
  failures.delete(`${operation}:${key}`);
  updateStatus();
}

export function readLocalValue(key: string): { ok: boolean; value: string | null } {
  try {
    const value = localStorage.getItem(key);
    clearFailure(key, 'read');
    return { ok: true, value };
  } catch {
    reportLocalPersistenceFailure(key, 'read', 'unavailable');
    return { ok: false, value: null };
  }
}

export function writeLocalValue(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    pendingWrites.delete(key);
    clearFailure(key, 'read');
    clearFailure(key, 'write');
    return true;
  } catch (error) {
    pendingWrites.set(key, value);
    const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
    reportLocalPersistenceFailure(key, 'write', name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' ? 'quota' : 'unavailable');
    return false;
  }
}

/** Retry only the latest failed value for each key; never reload or clear UI state. */
export function retryPendingLocalWrites(): boolean {
  for (const [key, value] of [...pendingWrites]) writeLocalValue(key, value);
  return getLocalPersistenceStatus().message === null;
}

/** Cleanup is optional; only call after the replacement was successfully saved. */
export function removeMigratedLocalValue(key: string): void {
  try { localStorage.removeItem(key); } catch { /* retaining both copies is safe */ }
}
