export interface SkillEvidence { summary:string; kind?:string; success?:boolean|null }
export interface SkillInvocation { skill:string; status:string; evidence:SkillEvidence[] }
export interface LiveSkillAudit { sessionId:string;turnId:string;status:string;invocation:SkillInvocation[] }
export function skillState(item:SkillInvocation):{label:string;tone:string} {
  if(item.status==='executed')return {label:'执行成功（有证据）',tone:'success'};
  if(item.status==='failed'||item.status==='error'||item.evidence?.some(e=>e.kind==='executed'&&e.success===false))return {label:'执行失败（有证据）',tone:'error'};
  if(item.status==='attempted')return {label:'已尝试执行',tone:'pending'};
  if(item.status==='loaded')return {label:'已读取说明',tone:'loaded'};
  return {label:'未观察到执行证据',tone:'unknown'};
}

export async function fetchSkillRecords(sessionId:string, turnId?:string, signal?:AbortSignal):Promise<LiveSkillAudit[]> {
 const base=window.location.pathname.replace(/\/index\.html$/,'').replace(/\/$/,'');
 const response=await fetch(`${base}/api/skill-audits?${new URLSearchParams({sessionId,...(turnId?{turnId}:{})})}`,{cache:'no-store',signal});
 if(!response.ok)throw new Error('核验记录暂不可读');
 const data=await response.json();if(!Array.isArray(data.records))throw new Error('核验记录格式不正确');
 return data.records.filter((record:LiveSkillAudit)=>record.sessionId===sessionId&&(!turnId||record.turnId===turnId));
}
