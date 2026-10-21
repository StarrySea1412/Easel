import type { ToastTone, ToastNotice } from './toast';

export type NoticeTarget =
  | { page: 'chat'; sessionId: string; tool?: 'image'|'publish'; receiptId?:string }
  | { page: 'image'; medium?: 'image' | 'video' }
  | { page: 'outputs'; filter?: 'all' | 'image' | 'video'; path?: string }
  | { page: 'publish' };
export type EventNotice = {
  id: string; message: string; tone: ToastTone; at: number; read: boolean;
  target?: NoticeTarget; action?: ToastNotice['action'];
};

const key = 'easel:event-notifications';
const limit = 1000;
const seenLimit = 10000;
let notices: EventNotice[] = [];
const deletedSessions = new Set<string>();
// Keep deduplication separate from the visible history. Clearing the panel must
// not replay a still-pending question or an already-announced publish receipt.
let seen = new Set<string>();
const listeners = new Set<() => void>();
type Operation = { method: 'POST' | 'DELETE'; suffix?: string; body?: unknown };
let pending: Operation[] = [];
let syncState = 'local';
let active = 0;
let syncing: Promise<void> | null = null;
export const readEventSync = () => syncState;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1000;
}
function sessionFromChatNotice(id: string): string | undefined {
  return /^chat:([A-Za-z0-9_.-]{1,120}):/.exec(id)?.[1];
}
function belongsToDeletedSession(notice: Pick<EventNotice, 'id' | 'target'>): boolean {
  const sessionId = notice.target?.page === 'chat' ? notice.target.sessionId : sessionFromChatNotice(notice.id);
  return Boolean(sessionId && deletedSessions.has(sessionId));
}
function outputPath(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 4096
    && ![...value].some(character => character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    && value.split('/').every(part => part && part !== '.' && part !== '..') ? value : undefined;
}
function targetFrom(value: unknown): NoticeTarget | undefined {
  if (!record(value)) return undefined;
  if (value.page === 'chat') return validId(value.sessionId) ? { page: 'chat', sessionId: value.sessionId,
    ...(value.tool === 'image' || value.tool === 'publish' ? {tool:value.tool} : {}),
    ...(typeof value.receiptId==='string'&&/^[a-f0-9]{32}$/.test(value.receiptId)?{receiptId:value.receiptId}:{}) } : undefined;
  if (value.page === 'image') return { page: 'image', ...(value.medium === 'image' || value.medium === 'video' ? { medium: value.medium } : {}) };
  if (value.page === 'outputs') return {
    page: 'outputs',
    ...(value.filter === 'all' || value.filter === 'image' || value.filter === 'video' ? { filter: value.filter } : {}),
    ...(outputPath(value.path) ? { path: outputPath(value.path) } : {}),
  };
  if (value.page === 'publish') return { page: 'publish' };
  return undefined;
}

/** Only the application's media endpoint can become a content-library jump. */
export function notificationOutputPath(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, window.location.href);
    if (url.origin !== window.location.origin || url.username || url.password) return undefined;
    const marker = '/api/media/';
    const index = url.pathname.indexOf(marker);
    return index < 0 ? undefined : outputPath(decodeURIComponent(url.pathname.slice(index + marker.length)));
  } catch { return undefined; }
}

try {
  const stored: unknown = JSON.parse(sessionStorage.getItem(key) || 'null');
  const rows = Array.isArray(stored) ? stored : record(stored) && Array.isArray(stored.notices) ? stored.notices : [];
  const ids = new Set<string>();
  if (record(stored) && Array.isArray(stored.deletedSessions)) {
    for (const id of stored.deletedSessions) if (validId(id)) deletedSessions.add(id);
  }
  for (const row of rows) {
    if (!record(row) || !validId(row.id) || ids.has(row.id) || typeof row.message !== 'string'
      || !['info', 'success', 'error'].includes(String(row.tone)) || typeof row.at !== 'number'
      || !Number.isFinite(row.at) || row.at <= 0 || Number.isNaN(new Date(row.at).getTime())) continue;
    ids.add(row.id);
    const target = targetFrom(row.target);
    const notice = { id: row.id, message: row.message.slice(0, 600), tone: row.tone as ToastTone,
      at: row.at, read: row.read === true, target };
    if (belongsToDeletedSession(notice)) continue;
    notices.push(notice);
    if (notices.length === limit) break;
  }
  const storedSeen = record(stored) && Array.isArray(stored.seen) ? stored.seen.filter(validId) : [];
  seen = new Set([...notices.map(notice => notice.id), ...storedSeen].slice(0, seenLimit));
  if (record(stored) && stored.version === 2 && Array.isArray(stored.pending)) {
    pending = stored.pending.filter((op): op is Operation => record(op) && (op.method === 'POST' || op.method === 'DELETE') && (!op.suffix || op.suffix === '/read' || op.suffix === '/remove')).slice(0, 2000);
  } else if (notices.length) pending.push({ method: 'POST', body: { notices } });
} catch { /* Storage restrictions or corrupt history must not interrupt tasks. */ }

function changed() {
  try {
    sessionStorage.setItem(key, JSON.stringify({ version: 2,
      notices: notices.map(({ action: _action, ...notice }) => notice), seen: [...seen], deletedSessions: [...deletedSessions], pending }));
  } catch { /* Keep events in memory when this browser cannot persist them. */ }
  listeners.forEach(listener => listener());
}
function queue(operation: Operation) {
  pending.push(operation);
  changed();
  if (active) void syncEvents();
}

/** Server state is authoritative, including tombstones and cross-tab read state. */
function notificationsBase() {
  return window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
}
export function syncEvents(): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    syncState = 'syncing'; changed();
    const base = notificationsBase();
    const request = async (suffix = '', init: RequestInit = {}) => {
      const response = await fetch(`${base}/api/notifications${suffix}`, { ...init, cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error('通知同步失败');
      return response;
    };
    try {
      do {
        while (pending.length) {
          const operation = pending[0];
          await request(operation.suffix, { method: operation.method, headers: { 'Content-Type': 'application/json' }, ...(operation.body ? { body: JSON.stringify(operation.body) } : {}) });
          pending.shift(); changed();
        }
        const data = await (await request()).json();
        if (!record(data) || !Array.isArray(data.notices) || !Array.isArray(data.seen)) throw Error('通知记录格式无效');
        if (pending.length) continue;
        const actions = new Map(notices.map(notice => [notice.id, notice.action]));
        notices = data.notices.filter((row): row is EventNotice => record(row) && validId(row.id) && typeof row.message === 'string' && ['info', 'success', 'error'].includes(String(row.tone)) && typeof row.at === 'number' && Number.isFinite(row.at) && row.at > 0)
          .slice(0, limit).map(row => ({ ...row, target: targetFrom(row.target), action: actions.get(row.id) }))
          .filter(row => !belongsToDeletedSession(row));
        seen = new Set(data.seen.filter(validId).slice(0, seenLimit));
      } while (pending.length);
      syncState = 'saved';
    } catch { syncState = 'error'; }
    finally { syncing = null; changed(); }
  })();
  return syncing;
}

export function startEventSync() {
  active++;
  void syncEvents();
  const refresh = () => { if (document.visibilityState !== 'hidden') void syncEvents(); };
  const timer = window.setInterval(refresh, 15000);
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', refresh);
  return () => { active--; window.clearInterval(timer); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
}
export const subscribeEvents = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const readEvents = () => notices;

export function recordEvent(message: string, tone: ToastTone, action?: ToastNotice['action'], id?: string, target?: NoticeTarget): boolean {
  const identifier = validId(id) ? id : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (belongsToDeletedSession({ id: identifier, target: targetFrom(target) })) return false;
  if (seen.has(identifier)) return false;
  seen = new Set([identifier, ...seen].slice(0, seenLimit));
  notices = [{ id: identifier, message: message.slice(0, 600), tone, at: Date.now(), read: false,
    action, target: targetFrom(target) }, ...notices].slice(0, limit);
  const { action: _action, ...persisted } = notices[0];
  queue({ method: 'POST', body: { notices: [persisted] } });
  return true;
}
export function markEventsRead(id?: string): void {
  if (!notices.some(notice => !notice.read && (!id || notice.id === id))) return;
  notices = notices.map(notice => !id || notice.id === id ? { ...notice, read: true } : notice);
  queue({ method: 'POST', suffix: '/read', body: id ? { id } : {} });
}
/** Verified targeted removal via its own route: a stale backend without it fails
 *  closed instead of letting an ids body fall through to the clear-all DELETE. */
export async function removeEvents(ids: string[]): Promise<boolean> {
  const wanted = new Set(ids.filter(validId));
  if (!wanted.size) return false;
  try {
    const response = await fetch(`${notificationsBase()}/api/notifications/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...wanted] }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return false;
  } catch { return false; }
  const before = notices.length;
  notices = notices.filter(notice => !wanted.has(notice.id));
  if (notices.length !== before) changed();
  return true;
}
export function clearEvents(): void {
  notices = [];
  queue({ method: 'DELETE' });
}

/** Called only after a conversation was deleted, never from a partial list. */
export function removeSessionEvents(sessionId: string): void {
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(sessionId)) return;
  deletedSessions.add(sessionId);
  notices = notices.filter(row => !belongsToDeletedSession(row));
  queue({ method: 'POST', suffix: '/remove', body: { sessionId } });
}
