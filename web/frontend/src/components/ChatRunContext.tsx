import { type ReactNode } from 'react';
import { ChatRunContext } from '../hooks/useChatRun';
import { useExecutionObservation } from '../hooks/useExecutionObservation';
import { useAgentOffice } from '../hooks/useAgentOffice';

export function ChatRunProvider({sessionId,turnId,engine,streaming,enabled,children}:{sessionId:string;turnId:string;engine:string;streaming:boolean;enabled:boolean;children:ReactNode}) {
  const execution=useExecutionObservation(sessionId,turnId,streaming,enabled&&Boolean(turnId));
  const office=useAgentOffice(sessionId,enabled&&Boolean(turnId)&&engine!=='codex'&&(!execution.current?.engine||execution.current.engine==='openclaw'));
  return <ChatRunContext.Provider value={enabled?{sessionId,turnId,engine,streaming,execution,office}:null}>{children}</ChatRunContext.Provider>;
}
