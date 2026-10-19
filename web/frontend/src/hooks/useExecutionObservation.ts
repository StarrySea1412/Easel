import { useEffect, useState } from 'react';
import { fetchChatExecution, type ChatExecution } from '../lib/api';
import { decodeExecution, mergeOperations, mergeTimeline } from '../lib/execution';

/** One reader per active turn, shared by the capsule and conversation. */
export function useExecutionObservation(sessionId:string, turnId:string, streaming:boolean, enabled=true) {
  const [snapshot,setSnapshot]=useState<ChatExecution|null>(null);
  const [readError,setReadError]=useState<{sessionId:string;turnId:string;message:string}|null>(null);
  const [revision,setRevision]=useState(0),[loading,setLoading]=useState(false);
  useEffect(()=>{
    if(!enabled||!turnId)return;
    let disposed=false,version=0,reading=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let request:AbortController|undefined;
    const update=(value:ChatExecution)=>setSnapshot(old=>old?.sessionId===sessionId&&old.turnId===turnId?{...old,...value,nextBefore:old.nextBefore===null?null:old.nextBefore===undefined?value.nextBefore:value.nextBefore===undefined?old.nextBefore:Math.min(old.nextBefore,value.nextBefore??0),operations:mergeOperations(old.operations,value.operations),timeline:mergeTimeline(old.timeline,value.timeline)}:value);
    const listen=(event:Event)=>{const value=decodeExecution((event as CustomEvent).detail);if(value?.sessionId!==sessionId||value.turnId!==turnId)return;version++;update(value);setReadError(null);};
    const read=async()=>{
      if(disposed||reading||document.hidden)return;
      reading=true;request=new AbortController();const controller=request,began=version;
      const deadline=setTimeout(()=>controller.abort(),12000);
      try{const value=await fetchChatExecution(sessionId,turnId,controller.signal);if(!disposed&&!controller.signal.aborted&&began===version){update(value);setReadError(null);}}
      catch{if(!disposed&&began===version)setReadError({sessionId,turnId,message:'执行记录暂不可读，已有回执保留。'});}
      finally{clearTimeout(deadline);reading=false;if(!disposed&&streaming&&!document.hidden)timer=setTimeout(()=>void read(),3000);}
    };
    const visibility=()=>{clearTimeout(timer);if(!document.hidden)void read();};
    window.addEventListener('easel:execution',listen);document.addEventListener('visibilitychange',visibility);
    void read();return()=>{disposed=true;request?.abort();clearTimeout(timer);window.removeEventListener('easel:execution',listen);document.removeEventListener('visibilitychange',visibility);};
  },[sessionId,turnId,streaming,revision,enabled]);
  const current=enabled&&snapshot?.sessionId===sessionId&&snapshot.turnId===turnId?snapshot:null;
  const error=enabled&&readError?.sessionId===sessionId&&readError.turnId===turnId?readError.message:'';
  const loadEarlier=async()=>{if(current?.nextBefore==null||loading)return;setLoading(true);try{const value=await fetchChatExecution(sessionId,turnId,undefined,current.nextBefore);setSnapshot(old=>old?.sessionId===sessionId&&old.turnId===turnId?{...old,nextBefore:value.nextBefore,operations:mergeOperations(value.operations,old.operations),timeline:mergeTimeline(old.timeline,value.timeline)}:old);}catch{setReadError({sessionId,turnId,message:'较早记录暂不可读，已有回执保留。'});}finally{setLoading(false);}};
  return {current,error,loading,loadEarlier,refresh:()=>setRevision(x=>x+1)};
}
