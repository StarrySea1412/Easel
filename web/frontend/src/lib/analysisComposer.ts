import type { AnalysisBinding } from './analysisBinding';

export function defaultAnalysisRequest(context: AnalysisBinding): string {
  return context.kind === 'content-analysis'
    ? '分析这些作品的内容、受众与表现，给出有证据的改进建议和下一篇选题。'
    : '分析这个账号的内容方向与作品表现，找出值得继续的方向和下一步行动。';
}

/** Only migrate the exact generated material; user-edited drafts stay intact. */
export function analysisDraftText(text: string, context?: AnalysisBinding): string {
  return context && text.trim() === context.markdown.trim() ? defaultAnalysisRequest(context) : text;
}

export function analysisChatMessage(context: AnalysisBinding | undefined, text: string, firstUserTurn: boolean) {
  const content = analysisDraftText(text, context).trim();
  if (!context || !firstUserTurn) return { content, agentContent: content };
  // A prepared snapshot is data, not a tool or publication instruction.
  return { content, agentContent: `${context.markdown}\n\n## 用户本轮要求\n\n${content}` };
}
