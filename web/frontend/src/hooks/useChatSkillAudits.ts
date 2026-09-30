import { useEffect, useState } from 'react';
import { fetchSkillRecords, type LiveSkillAudit } from '../lib/skillEvidence';
export function useChatSkillAudits(sessionId:string,streaming:boolean,refreshKey:number,disabled=false) {
 const [records,setRecords]=useState<LiveSkillAudit[]>([]);
 const [error,setError]=useState('');
 useEffect(()=>{
  if(disabled||!sessionId)return;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const read=async()=>{
   try {
    const records=await fetchSkillRecords(sessionId,undefined,controller.signal);
    if(!controller.signal.aborted){setRecords(records);setError('');}
   }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'核验记录暂不可读');}
   finally{if(streaming&&!controller.signal.aborted)timer=setTimeout(()=>void read(),3000);}
  };
  void read();return()=>{controller.abort();if(timer)clearTimeout(timer);};
 },[sessionId,streaming,refreshKey,disabled]);
 return {records:disabled?[]:records.filter(r=>r.sessionId===sessionId),error:disabled?'':error};
}
