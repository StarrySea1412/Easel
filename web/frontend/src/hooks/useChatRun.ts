import {createContext,useContext} from 'react';
import {useExecutionObservation} from './useExecutionObservation';
import type {useAgentOffice} from './useAgentOffice';

type Run={sessionId:string;turnId:string;engine:string;streaming:boolean;execution:ReturnType<typeof useExecutionObservation>;office:ReturnType<typeof useAgentOffice>};
export const ChatRunContext=createContext<Run|null>(null);
export const useChatRun=()=>useContext(ChatRunContext);
export function useRunExecution(sessionId:string,turnId:string,streaming:boolean){
  const run=useChatRun(),shared=run?.sessionId===sessionId&&run.turnId===turnId?run.execution:null;
  const own=useExecutionObservation(sessionId,turnId,streaming,!shared);
  return shared||own;
}
