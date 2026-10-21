export interface ChatReasoning { thinkingStatus?: 'available'|'unavailable'|'partial'; }
export function decodeChatReasoning(value: unknown): ChatReasoning {
  if (!value || typeof value !== 'object') return {};
  const status = (value as ChatReasoning).thinkingStatus;
  return status === 'available' || status === 'unavailable' || status === 'partial' ? {thinkingStatus: status} : {};
}
