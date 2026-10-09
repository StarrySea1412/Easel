import type { ThinkingLevel } from './api';

export interface TitleMessage { role: 'user' | 'assistant'; content: string }

/** User click only. This calls the configured default model and never retries. */
export async function requestConversationTitle(messages: TitleMessage[], options: { thinkingLevel?: ThinkingLevel; signal?: AbortSignal } = {}): Promise<string> {
  const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  const response = await fetch(base + '/api/chat/title', {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, signal: options.signal,
    body: JSON.stringify({ messages: messages.slice(-6).map(message => ({ role: message.role, content: [...message.content].slice(0, 900).join('') })), thinkingLevel: options.thinkingLevel }),
  });
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error('Agent 命名返回格式无效；未自动重试'); }
  if (!response.ok) {
    const detail = data && typeof data === 'object' && 'detail' in data ? (data as { detail: unknown }).detail : null;
    throw new Error(typeof detail === 'string' ? detail : 'Agent 命名失败；未自动重试');
  }
  const title = data && typeof data === 'object' && 'title' in data ? (data as { title: unknown }).title : null;
  if (typeof title !== 'string' || [...title].length < 1 || [...title].length > 32 || title !== title.trim() || /[\p{C}\r\n\t\u2028\u2029`<>[\]{}]/u.test(title)) {
    throw new Error('Agent 命名返回的标题无效；未自动重试');
  }
  return title;
}
