import type { ChatSession } from './store';

/**
 * 终态角标（失败/已停止/已完成）的“已读”记录：看过会话（或标记对应通知已读）后，
 * 该会话的终态签名记入本机；出现新结局（新消息/新失败）时签名变化，角标重新出现。
 */
const STORAGE_KEY = 'easel:seen-session-status';

type SeenMap = Record<string, string>;

let cache: SeenMap | null = null;
let version = 0;
const listeners = new Set<() => void>();

function read(): SeenMap {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SeenMap : {};
  } catch {
    cache = {};
  }
  return cache;
}

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

function write(next: SeenMap) {
  cache = next;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* 存储受限时仅本会话内生效 */ }
  notify();
}

/** 终态签名：随最后一条消息与结局变化；新结局得到不同签名。 */
export function statusSignature(session: ChatSession): string {
  const last = session.messages.at(-1);
  if (!last) return '';
  const flag = last.stopped ? 'stopped' : last.error ? 'error:' + (last.error.message || '').slice(0, 120) : 'ok';
  return [session.messages.length, last.role, last.turnId || last.taskRunId || '', flag].join('|');
}

/** 该会话的当前终态是否已被看过。 */
export function isSessionTerminalSeen(session: ChatSession): boolean {
  const signature = statusSignature(session);
  return Boolean(signature) && read()[session.id] === signature;
}

/** 把会话的当前终态记为已读（打开/停留查看会话，或标记对应通知已读时调用）。 */
export function markSessionSeen(session: ChatSession): void {
  const signature = statusSignature(session);
  if (!signature) return;
  const current = read();
  if (current[session.id] === signature) return;
  write({ ...current, [session.id]: signature });
}

export function markSessionSeenById(sessionId: string, sessions: ChatSession[]): void {
  const session = sessions.find(item => item.id === sessionId);
  if (session) markSessionSeen(session);
}

export function readSeenStatuses(): SeenMap {
  return read();
}

export function subscribeSeenStatuses(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSeenStatusVersion(): number {
  return version;
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY || event.key === null) {
      cache = null;
      notify();
    }
  });
}
