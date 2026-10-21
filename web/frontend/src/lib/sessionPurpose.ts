import type { ChatSession } from './store';

export function sessionPurpose(session: ChatSession): { kind: 'analysis' | 'generation' | 'general'; label: string; detail: string } {
  const type = session.analysisContext?.kind || session.conversationType;
  if (type === 'account-analysis' || type === 'content-analysis') {
    return { kind: 'analysis', label: '分析资料', detail: `分析资料 · ${type === 'account-analysis' ? '账号分析' : '作品分析'}` };
  }
  if (type === 'content-generation') return { kind: 'generation', label: '生成内容', detail: '生成内容' };
  if (session.messages.some(message => message.role === 'user' && message.kind === 'breakdown')) {
    return { kind: 'analysis', label: '分析资料', detail: '分析资料 · 爆款拆解' };
  }
  return { kind: 'general', label: '普通对话', detail: '普通对话' };
}
