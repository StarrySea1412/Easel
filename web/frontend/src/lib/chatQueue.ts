import type { UploadedFile, ThinkingLevel } from './api';
import type { SkillRequirements } from './selectedSkills';
import { requirementsForSelection } from './selectedSkills';
import { readLocalValue, writeLocalValue, reportLocalPersistenceFailure } from './localPersistence';

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: UploadedFile[];
  missingAttachments: string[];
  selectedSkills: string[];
  skillRequirements: SkillRequirements;
  thinkingLevel?: ThinkingLevel;
  modelRef?: string;
}
export interface ChatQueue { items: QueuedMessage[]; paused: boolean; error: string }
const queues = new Map<string, ChatQueue>();
const protectedSessions = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;
const keyFor = (session: string) => `easel:chat-queue:${session}`;
const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'adaptive', 'ultra']);

export function getChatQueue(session: string): ChatQueue {
  const cached = queues.get(session);
  if (cached) return cached;
  const queue: ChatQueue = { items: [], paused: true, error: '' };
  const stored = readLocalValue(keyFor(session));
  if (!stored.ok) protectedSessions.add(session);
  else if (stored.value) {
    try {
      const saved = JSON.parse(stored.value);
      if (saved.version !== 1 || !Array.isArray(saved.items) || saved.items.length > 20) throw new Error('invalid');
      const ids = new Set<string>();
      queue.items = saved.items.map((row: Record<string, unknown>) => {
        if (!row || typeof row.id !== 'string' || ids.has(row.id) || typeof row.text !== 'string' || row.text.length > 20000
          || !Array.isArray(row.attachmentNames) || !row.attachmentNames.every(name => typeof name === 'string')
          || !Array.isArray(row.selectedSkills) || row.selectedSkills.length > 20 || !row.selectedSkills.every(name => typeof name === 'string')
          || !row.skillRequirements || typeof row.skillRequirements !== 'object' || Array.isArray(row.skillRequirements)
          || !Object.values(row.skillRequirements).every(value => typeof value === 'string' && value.length <= 2000)
          || (row.modelRef !== undefined && (typeof row.modelRef !== 'string' || row.modelRef.length > 500 || !/^[^\s/]+\/[^\s]+$/.test(row.modelRef)))
          || (row.thinkingLevel !== undefined && !levels.has(String(row.thinkingLevel)))) throw new Error('invalid');
        ids.add(row.id);
        return { id: row.id, text: row.text, attachments: [], missingAttachments: row.attachmentNames as string[],
          selectedSkills: row.selectedSkills as string[], skillRequirements: requirementsForSelection(row.skillRequirements as SkillRequirements, row.selectedSkills as string[]),
          thinkingLevel: row.thinkingLevel as ThinkingLevel | undefined, modelRef: row.modelRef as string | undefined };
      });
      // Restored items stay paused. Their row state and missing-media action
      // communicate this without treating an ordinary restore as an error.
    } catch {
      protectedSessions.add(session);
      queue.error = '队列记录无法读取，已保留原始数据；请先导出浏览器数据。';
      reportLocalPersistenceFailure(keyFor(session), 'read', 'invalid');
    }
  }
  queues.set(session, queue);
  return queue;
}

export const subscribeChatQueue = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getQueueRevision = () => revision;
function publish(session: string, next: ChatQueue, persist = true): boolean {
  if (persist) {
    if (protectedSessions.has(session)) return false;
    const saved = { version: 1, items: next.items.map(item => ({ id: item.id, text: item.text,
      attachmentNames: [...item.missingAttachments, ...item.attachments.map(file => file.name)],
      selectedSkills: item.selectedSkills, skillRequirements: item.skillRequirements, modelRef: item.modelRef, thinkingLevel: item.thinkingLevel })) };
    if (!writeLocalValue(keyFor(session), JSON.stringify(saved), { queueOnFailure: false })) return false;
  }
  queues.set(session, next); revision++;
  for (const listener of listeners) listener();
  return true;
}
export function enqueueChat(session: string, message: Omit<QueuedMessage, 'id' | 'missingAttachments'>): boolean {
  const queue = getChatQueue(session);
  if (queue.items.length >= 20 || message.text.length > 20000 || (!message.text.trim() && !message.attachments.length)) return false;
  const item = { ...message, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, missingAttachments: [],
    attachments: message.attachments.map(file => ({ ...file })), selectedSkills: [...message.selectedSkills],
    skillRequirements: requirementsForSelection(message.skillRequirements, message.selectedSkills) };
  return publish(session, { items: [...queue.items, item], paused: queue.items.length > 0 && queue.paused, error: queue.paused && queue.items.length ? queue.error : '' });
}
export function pauseChatQueue(session: string, error = ''): void {
  const queue = getChatQueue(session);
  if (!queue.items.length || (queue.paused && queue.error === error)) return;
  publish(session, { ...queue, paused: true, error }, false);
}
export function resumeChatQueue(session: string): boolean {
  const queue = getChatQueue(session);
  if (!queue.items.length || queue.items.some(item => item.missingAttachments.length)) return false;
  return publish(session, { ...queue, paused: false, error: '' }, false);
}
export function removeQueuedMessage(session: string, id: string): boolean {
  const queue = getChatQueue(session);
  return publish(session, { ...queue, items: queue.items.filter(item => item.id !== id) });
}
export function updateQueuedMessage(session: string, id: string, text: string): boolean {
  const queue = getChatQueue(session);
  if (!queue.items.some(item => item.id === id) || !text.trim() || text.length > 20000) return false;
  return publish(session, { ...queue, items: queue.items.map(item => item.id === id ? { ...item, text } : item) });
}
export function attachQueuedFiles(session: string, id: string, files: UploadedFile[]): boolean {
  const queue = getChatQueue(session), names = new Set(files.map(file => file.name));
  if (!queue.items.some(item => item.id === id)) return false;
  return publish(session, { ...queue, items: queue.items.map(item => item.id === id ? { ...item,
    attachments: [...new Map([...item.attachments, ...files].map(file => [file.path, file])).values()],
    missingAttachments: item.missingAttachments.filter(name => !names.has(name)) } : item) });
}
export function moveQueuedMessage(session: string, id: string, offset: number): boolean {
  const queue = getChatQueue(session), items = [...queue.items], from = items.findIndex(item => item.id === id), to = from + offset;
  if (from < 0 || to < 0 || to >= items.length) return false;
  const [item] = items.splice(from, 1);
  items.splice(to, 0, item);
  return publish(session, { ...queue, items });
}
export function clearChatQueue(session: string): void { publish(session, { items: [], paused: true, error: '' }); }
export const hasChatQueue = (session: string) => Boolean(getChatQueue(session).items.length || protectedSessions.has(session));
/** Commit removal before dispatch so a refresh cannot send the same item twice. */
export function dispatchQueuedMessage(session: string, send: (item: QueuedMessage) => boolean): boolean {
  const queue = getChatQueue(session), item = queue.items[0];
  if (queue.paused || !item || item.missingAttachments.length) return false;
  return dispatchSelectedQueuedMessage(session, item.id, send);
}

/** Used after a confirmed stop; remove exactly the selected message, not its neighbours. */
export function dispatchSelectedQueuedMessage(session: string, id: string, send: (item: QueuedMessage) => boolean): boolean {
  const queue = getChatQueue(session), index = queue.items.findIndex(item => item.id === id), item = queue.items[index];
  if (!item || item.missingAttachments.length) return false;
  if (!publish(session, { ...queue, items: queue.items.filter(row => row.id !== id) })) {
    pauseChatQueue(session, '队列更改无法保存，未发送请求。'); return false;
  }
  let accepted = false;
  try { accepted = send(item); } catch { /* restore the unsent item */ }
  if (!accepted) {
    const items = [...getChatQueue(session).items]; items.splice(Math.min(index, items.length), 0, item);
    const restored = { items, paused: true, error: '消息未被接收，已保留在队列中。' };
    if (!publish(session, restored)) publish(session, restored, false);
  }
  return accepted;
}
