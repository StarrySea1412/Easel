import type { ChatMessage, ChatSession } from './store';
import { decodeChatTiming } from './chatTiming';
import { decodeChatReasoning } from './chatReasoning';

export const CODEX_RECOVERED = 'easel:codex-recovered';
export function applyCodexResult(session: ChatSession, turnId: string, snapshot: {
  sessionId?: string; turn_id?: string; status: string; outcome?: string; text: string;
  thinking?: string; error?: ChatMessage['error'];
}): ChatSession {
  if (session.engine !== 'codex' || snapshot.sessionId !== session.id || snapshot.turn_id !== turnId
      || snapshot.status !== 'done' || !['completed','failed','interrupted'].includes(snapshot.outcome || '')) return session;
  const update: ChatMessage = {role:'assistant',turnId,content:snapshot.text,
    thinking:snapshot.thinking || undefined,error:snapshot.error,stopped:snapshot.outcome === 'interrupted',
    ...decodeChatTiming(snapshot),...decodeChatReasoning(snapshot)};
  let found = false;
  const messages = session.messages.map(message=>{
    if (message.role !== 'assistant' || message.turnId !== turnId) return message;
    found = true;
    return {...message,...update};
  });
  if (!found && session.pendingTurnId !== turnId) return session;
  if (!found) messages.push(update);
  return {...session,messages,pendingTurnId:session.pendingTurnId === turnId?undefined:session.pendingTurnId};
}
