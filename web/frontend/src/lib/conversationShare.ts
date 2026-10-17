import type { ChatMessage, ChatSession } from './store';

/** 对话分享：完整快照上传 + 外部接管追加的回传合并（与后端 /api/conversation-shares 对应）。 */
export interface ConversationShare { token: string; title: string; createdAt: number; messageCount: number }
export interface ShareAppendMessage { role: 'user' | 'assistant' | 'system'; content: string }
export interface ShareAppend { appendId: string; at: number; source: { model: string; harness: string }; note: string; messages: ShareAppendMessage[] }

function base(): string {
  return window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
}

/** 只分享有内容的 user/assistant 消息；完整、可读，不夹带内部字段。 */
export function sharePayloadFor(session: ChatSession): { sessionId: string; title: string; messages: ShareAppendMessage[]; meta: { modelRef: string; engine: string } } {
  const messages = session.messages
    .filter(message => (message.role === 'user' || message.role === 'assistant') && (message.content || '').trim())
    .map(message => ({ role: message.role as 'user' | 'assistant', content: message.content }));
  const modelRef = [...session.messages].reverse().find(message => message.requestedModelRef)?.requestedModelRef || '';
  return { sessionId: session.id, title: session.title, messages, meta: { modelRef, engine: session.engine || '' } };
}

export async function createConversationShare(session: ChatSession): Promise<ConversationShare> {
  const payload = sharePayloadFor(session);
  if (!payload.messages.length) throw new Error('这个对话还没有可分享的内容');
  const response = await fetch(`${base()}/api/conversation-shares`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '分享创建失败');
  return value as ConversationShare;
}

export async function fetchShareAppends(token: string): Promise<{ appends: ShareAppend[]; appendCount: number; title: string }> {
  const response = await fetch(`${base()}/api/conversation-shares/${encodeURIComponent(token)}`, { cache: 'no-store' });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '接管内容读取失败');
  return { appends: Array.isArray(value.appends) ? value.appends : [], appendCount: value.appendCount || 0, title: value.title || '' };
}

/** 把接管追加合并进本地会话：按 appendId 去重，逐条标注来源与时间，绝不静默改写历史。 */
export function mergeShareAppends(session: ChatSession, appends: ShareAppend[]): { session: ChatSession; added: number } {
  const loaded = new Set(session.loadedShareAppends || []);
  const fresh = appends.filter(append => append && append.appendId && !loaded.has(append.appendId));
  if (!fresh.length) return { session, added: 0 };
  const token = session.share?.token || '';
  const messages: ChatMessage[] = fresh.flatMap(append => append.messages
    .filter(message => (message.content || '').trim())
    .map(message => ({
      role: message.role === 'system' ? 'assistant' : message.role,
      content: message.content,
      shareAppend: { token, appendId: append.appendId, at: append.at, source: append.source || { model: '', harness: '' } },
    } as ChatMessage)));
  return {
    session: { ...session, messages: [...session.messages, ...messages], loadedShareAppends: [...loaded, ...fresh.map(append => append.appendId)] },
    added: messages.length,
  };
}
