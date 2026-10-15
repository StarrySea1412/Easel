import type { ToastTone, ToastNotice } from './toast';

export type NoticeTarget =
  | { page: 'chat'; sessionId: string }
  | { page: 'image'; medium?: 'image' | 'video' }
  | { page: 'outputs'; filter?: 'all' | 'image' | 'video'; path?: string }
  | { page: 'publish' };
export type EventNotice = {
  id: string; message: string; tone: ToastTone; at: number; read: boolean;
  target?: NoticeTarget; action?: ToastNotice['action'];
};

const key = 'easel:event-notifications';
const limit = 100;
const seenLimit = 1000;
let notices: EventNotice[] = [];
// Keep deduplication separate from the visible history. Clearing the panel must
// not replay a still-pending question or an already-announced publish receipt.
let seen = new Set<string>();
const listeners = new Set<() => void>();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1000;
}
function outputPath(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 4096
    && ![...value].some(character => character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    && value.split('/').every(part => part && part !== '.' && part !== '..') ? value : undefined;
}
function targetFrom(value: unknown): NoticeTarget | undefined {
  if (!record(value)) return undefined;
  if (value.page === 'chat') return validId(value.sessionId) ? { page: 'chat', sessionId: value.sessionId } : undefined;
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
  for (const row of rows) {
    if (!record(row) || !validId(row.id) || ids.has(row.id) || typeof row.message !== 'string'
      || !['info', 'success', 'error'].includes(String(row.tone)) || typeof row.at !== 'number'
      || !Number.isFinite(row.at) || row.at <= 0 || Number.isNaN(new Date(row.at).getTime())) continue;
    ids.add(row.id);
    notices.push({ id: row.id, message: row.message.slice(0, 600), tone: row.tone as ToastTone,
      at: row.at, read: row.read === true, target: targetFrom(row.target) });
    if (notices.length === limit) break;
  }
  const storedSeen = record(stored) && Array.isArray(stored.seen) ? stored.seen.filter(validId) : [];
  seen = new Set([...notices.map(notice => notice.id), ...storedSeen].slice(0, seenLimit));
} catch { /* Storage restrictions or corrupt history must not interrupt tasks. */ }

function changed() {
  try {
    sessionStorage.setItem(key, JSON.stringify({ version: 1,
      notices: notices.map(({ action: _action, ...notice }) => notice), seen: [...seen] }));
  } catch { /* Keep events in memory when this browser cannot persist them. */ }
  listeners.forEach(listener => listener());
}
export const subscribeEvents = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const readEvents = () => notices;

export function recordEvent(message: string, tone: ToastTone, action?: ToastNotice['action'], id?: string, target?: NoticeTarget): boolean {
  const identifier = validId(id) ? id : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (seen.has(identifier)) return false;
  seen = new Set([identifier, ...seen].slice(0, seenLimit));
  notices = [{ id: identifier, message: message.slice(0, 600), tone, at: Date.now(), read: false,
    action, target: targetFrom(target) }, ...notices].slice(0, limit);
  changed();
  return true;
}
export function markEventsRead(id?: string): void {
  if (!notices.some(notice => !notice.read && (!id || notice.id === id))) return;
  notices = notices.map(notice => !id || id === notice.id ? { ...notice, read: true } : notice);
  changed();
}
export function clearEvents(): void {
  notices = [];
  changed();
}
