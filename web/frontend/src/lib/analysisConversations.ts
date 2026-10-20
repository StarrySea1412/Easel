import { analysisRequest } from './contentAnalysis';
import type { ChatMessage, ChatSession } from './store';

import type { AnalysisBinding } from './analysisBinding';
export { isAnalysisBinding } from './analysisBinding';
export type { AnalysisBinding, AnalysisChatRequest } from './analysisBinding';
export async function saveAnalysisChatResult(session: ChatSession | undefined, message: ChatMessage): Promise<AnalysisBinding | null> {
  const context = session?.analysisContext;
  if (!context || session?.importedFromBackup || message.error || message.stopped || !message.turnId || !message.content.trim()) return null;
  return analysisRequest(`/conversations/${encodeURIComponent(context.id)}/result`, 'POST', {
    platform: context.platform, accountId: context.accountId, sessionId: session.id, turnId: message.turnId, markdown: message.content,
  });
}
