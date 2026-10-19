import type { ChatSession } from './store';

/**
 * A side chat is a child conversation of its parent: it never enters the main
 * session list, keeps its own transcript in the side panel, and the parent's
 * content is only pulled in when the user explicitly quotes it.
 */
/** All side chats of a parent session, in tab order (sideOrder wins, then creation time). */
export function sideChatsOf(session: ChatSession, sessions: ChatSession[], includeClosed = false): ChatSession[] {
  return sessions.filter(item => item.parentSessionId === session.id && (includeClosed || !item.sideClosed))
    .slice()
    .sort((a, b) => (a.sideOrder ?? Number.MAX_SAFE_INTEGER) - (b.sideOrder ?? Number.MAX_SAFE_INTEGER)
      || a.created - b.created);
}

/** 拖拽后的新顺序：把 draggedId 移到 targetId 之前/之后，返回完整 id 顺序（无效输入原样返回）。 */
export function computeSideOrder(ids: string[], draggedId: string, targetId: string, after: boolean): string[] {
  if (draggedId === targetId || !ids.includes(draggedId) || !ids.includes(targetId)) return ids;
  const rest = ids.filter(id => id !== draggedId);
  const targetIndex = rest.indexOf(targetId);
  if (targetIndex < 0) return ids;
  rest.splice(after ? targetIndex + 1 : targetIndex, 0, draggedId);
  return rest;
}

/** The side chat opened by default: the most recently created one. */
export function sideChatOf(session: ChatSession, sessions: ChatSession[]): ChatSession | undefined {
  return sideChatsOf(session, sessions).at(-1);
}

export function sideChatTitle(parent: ChatSession, sessions: ChatSession[]): string {
  const siblings = sessions.filter(item => item.parentSessionId === parent.id);
  return siblings.length ? `辅助对话 ${siblings.length + 1}` : '辅助对话';
}

/** One-line context handoff: the parent's last exchange, trimmed for quoting. */
export function lastExchangeQuote(session: ChatSession, limit = 600): string {
  const parts: string[] = [];
  for (const message of [...session.messages].reverse()) {
    if (message.role !== 'assistant' && message.role !== 'user') continue;
    const text = (message.content || '').trim();
    if (!text) continue;
    parts.unshift(`${message.role === 'user' ? '我' : '助手'}：${text}`);
    if (parts.length === 2) break;
  }
  const quote = parts.join('\n');
  return quote.length > limit ? `${quote.slice(0, limit)}…` : quote;
}
