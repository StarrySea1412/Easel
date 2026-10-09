import type { UploadedFile } from './api';
import { readLocalValue, writeLocalValue, reportLocalPersistenceFailure } from './localPersistence';

export interface ChatDraft {
  quotes?: string[];
  text: string;
  attachments: UploadedFile[];
  missingAttachments: string[];
  uploading: boolean;
  error: string;
}

const drafts = new Map<string, ChatDraft>();
const protectedSessions = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
const uploads = new Map<string, symbol>();
const keyFor = (sessionId: string) => `easel:chat-draft:${sessionId}`;
const empty = (): ChatDraft => ({ text: '', attachments: [], missingAttachments: [], uploading: false, error: '' });

/** Navigation keeps uploaded references in memory; refresh restores text only.
 * Persisted paths cannot prove that an upload still exists or belongs to this
 * running backend. Names explain what must be reattached without replaying it.
 */
export function getChatDraft(sessionId: string): ChatDraft {
  const cached = drafts.get(sessionId);
  if (cached) return cached;
  const draft = empty();
  const key = keyFor(sessionId);
  const stored = readLocalValue(key);
  if (!stored.ok) protectedSessions.add(sessionId);
  else if (stored.value !== null) {
    try {
      const value: unknown = JSON.parse(stored.value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid draft');
      const saved = value as Record<string, unknown>;
      if (saved.version !== 1 || typeof saved.text !== 'string' || !Array.isArray(saved.attachmentNames)
        || !saved.attachmentNames.every(name => typeof name === 'string')) throw new Error('Invalid draft');
      draft.text = saved.text;
      if (saved.quotes !== undefined) {
        if (!Array.isArray(saved.quotes) || !saved.quotes.every(text => typeof text === 'string')) throw new Error('Invalid quotes');
        draft.quotes = saved.quotes;
      }
      draft.missingAttachments = [...new Set(saved.attachmentNames as string[])];
    } catch {
      protectedSessions.add(sessionId);
      reportLocalPersistenceFailure(key, 'read', 'invalid');
    }
  }
  drafts.set(sessionId, draft);
  return draft;
}

export function subscribeChatDraft(sessionId: string, listener: () => void): () => void {
  let subscribers = listeners.get(sessionId);
  if (!subscribers) { subscribers = new Set(); listeners.set(sessionId, subscribers); }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) listeners.delete(sessionId);
  };
}

function publish(sessionId: string, draft: ChatDraft, persist = true): void {
  drafts.set(sessionId, draft);
  if (persist) {
    const key = keyFor(sessionId);
    if (protectedSessions.has(sessionId)) reportLocalPersistenceFailure(key, 'write', 'unreadable');
    else writeLocalValue(key, JSON.stringify({ version: 1, text: draft.text, ...(draft.quotes?.length ? { quotes: draft.quotes } : {}),
      attachmentNames: [...new Set([...draft.missingAttachments, ...draft.attachments.map(file => file.name)])] }));
  }
  for (const listener of listeners.get(sessionId) || []) listener();
}

export function setChatDraftText(sessionId: string, value: string | ((current: string) => string)): void {
  const draft = getChatDraft(sessionId);
  publish(sessionId, { ...draft, text: typeof value === 'function' ? value(draft.text) : value });
}

export function addChatDraftQuote(sessionId: string, text: string): void {
  const draft = getChatDraft(sessionId);
  if (!text.trim()) return;
  publish(sessionId, { ...draft, quotes: [...(draft.quotes || []), text.trim()] });
}

export function removeChatDraftQuote(sessionId: string, index: number): void {
  const draft = getChatDraft(sessionId);
  publish(sessionId, { ...draft, quotes: (draft.quotes || []).filter((_, position) => position !== index) });
}

export function removeChatDraftAttachment(sessionId: string, path: string): void {
  const draft = getChatDraft(sessionId);
  publish(sessionId, { ...draft, attachments: draft.attachments.filter(file => file.path !== path) });
}

export function dismissMissingDraftAttachments(sessionId: string): void {
  publish(sessionId, { ...getChatDraft(sessionId), missingAttachments: [] });
}

export function setChatDraftError(sessionId: string, error: string): void {
  publish(sessionId, { ...getChatDraft(sessionId), error }, false);
}

export function beginChatDraftUpload(sessionId: string): symbol | null {
  const draft = getChatDraft(sessionId);
  if (draft.uploading) return null;
  const token = Symbol(sessionId);
  uploads.set(sessionId, token);
  publish(sessionId, { ...draft, uploading: true, error: '' }, false);
  return token;
}

export function appendChatDraftUploads(sessionId: string, token: symbol, files: UploadedFile[]): void {
  if (uploads.get(sessionId) !== token) return;
  const draft = getChatDraft(sessionId);
  const names = new Set(files.map(file => file.name));
  publish(sessionId, { ...draft,
    attachments: [...new Map([...draft.attachments, ...files].map(file => [file.path, file])).values()],
    missingAttachments: draft.missingAttachments.filter(name => !names.has(name)),
  });
}

export function finishChatDraftUpload(sessionId: string, token: symbol, error: string): void {
  if (uploads.get(sessionId) !== token) return;
  uploads.delete(sessionId);
  publish(sessionId, { ...getChatDraft(sessionId), uploading: false, error }, false);
}

/** Clear only the accepted draft, or explicitly discard a deleted session's
 * draft. Late uploads from the old draft may not resurrect its attachments.
 */
export function clearChatDraft(sessionId: string, accepted?: ChatDraft): void {
  if (accepted && getChatDraft(sessionId) !== accepted) return;
  getChatDraft(sessionId); // establish whether its stored original is readable
  uploads.delete(sessionId);
  publish(sessionId, empty());
}

export function hasChatDraft(sessionId: string): boolean {
  const draft = getChatDraft(sessionId);
  return protectedSessions.has(sessionId) || Boolean(draft.text || draft.attachments.length
    || draft.quotes?.length || draft.missingAttachments.length || draft.uploading);
}
