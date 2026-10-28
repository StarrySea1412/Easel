import { readLocalValue, writeLocalValue } from './localPersistence';

export function readChatAutoContinue(sessionId: string): boolean {
  const saved = readLocalValue(`easel_chat_auto_continue:${sessionId}`);
  return saved.ok && saved.value !== 'off';
}
export function saveChatAutoContinue(sessionId: string, enabled: boolean): boolean {
  return writeLocalValue(`easel_chat_auto_continue:${sessionId}`, enabled ? 'on' : 'off');
}
