import { analysisRequest } from './contentAnalysis';
import type { ChatSession } from './store';
import { hasChatDraft, setChatDraftText } from './chatDrafts';

export interface WritingContext {
  id: string; sessionId: string; sourceSessionId: string; bindingId: string;
  platform: string; accountId: string; sourceTurnId: string; sourceHash: string;
  persona: string; engine: 'openclaw' | 'codex'; createdAt: number;
}

export function isWritingContext(value: unknown): value is WritingContext {
  if (!value || typeof value !== 'object') return false;
  const item = value as WritingContext;
  return ['id', 'sessionId', 'sourceSessionId', 'bindingId', 'platform', 'accountId', 'sourceTurnId', 'sourceHash', 'persona']
    .every(key => typeof item[key as keyof WritingContext] === 'string')
    && ['openclaw', 'codex'].includes(item.engine) && Number.isFinite(item.createdAt);
}

export async function prepareWriting(source: ChatSession): Promise<WritingContext> {
  if (!source.analysisContext || source.importedFromBackup) throw new Error('请从已保存的分析对话准备写作');
  return analysisRequest(`/conversations/${encodeURIComponent(source.analysisContext.id)}/writing`, 'POST', {
    sourceSessionId: source.id, persona: source.persona || '', engine: source.engine || 'openclaw',
  });
}

export function writingSession(source: ChatSession, context: WritingContext, sessions: ChatSession[]): ChatSession {
  const existing = sessions.find(item => item.id === context.sessionId);
  if (existing) return existing;
  return {id: context.sessionId, title: `写作 · ${source.analysisContext?.accountName || context.accountId}`,
    messages: [], created: context.createdAt * 1000, persona: context.persona || undefined,
    engine: context.engine, conversationType: 'content-generation', writingContext: context};
}

export function seedWritingDraft(session: ChatSession): void {
  if (!session.messages.length && !hasChatDraft(session.id)) {
    setChatDraftText(session.id, '基于原分析，选择一个有依据的方向，写出标题和可编辑正文；缺少的事实请标明。');
  }
}
