import type { ChatSession } from './store';

/**
 * A side chat is a child conversation of its parent: it never enters the main
 * session list, keeps its own transcript in the side panel, and the parent's
 * content is only pulled in when the user explicitly quotes it.
 */
/** All side chats of a parent session, oldest first (tab order). */
export function sideChatsOf(session: ChatSession, sessions: ChatSession[]): ChatSession[] {
  return sessions.filter(item => item.parentSessionId === session.id)
    .slice().sort((a, b) => a.created - b.created);
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
