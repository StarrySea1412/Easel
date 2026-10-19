import { useEffect, useState } from 'react';
import { fetchChatExecution, type ChatExecution } from '../lib/api';
import { decodeExecution, mergeOperations, mergeTimeline } from '../lib/execution';
import ExecutionOperation from './ExecutionOperation';
import type { Operation } from '../lib/execution';
import '../styles/chat-execution.css';

export default function ChatExecutionPanel({ sessionId, turnId, streaming, onProgressOwnership, kinds, emptyMessage }: { sessionId: string; turnId: string; streaming: boolean; onOpen?: () => void; onProgressOwnership?: (owned:boolean)=>void; kinds?: Operation['kind'][]; emptyMessage?: string }) {
  const [snapshot,setSnapshot]=useState<ChatExecution|null>(null);
  const [readError,setReadError]=useState<{sessionId:string;turnId:string;message:string}|null>(null);
  const [revision,setRevision]=useState(0),[loading,setLoading]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,version=0;
    const update=(value:ChatExecution)=>setSnapshot(old=>old?.sessionId===sessionId&&old.turnId===turnId?{...old,...value,nextBefore:old.nextBefore===null?null:old.nextBefore===undefined?value.nextBefore:value.nextBefore===undefined?old.nextBefore:Math.min(old.nextBefore,value.nextBefore??0),operations:mergeOperations(old.operations,value.operations),timeline:mergeTimeline(old.timeline,value.timeline)}:value);
    const listen=(event:Event)=>{const value=decodeExecution((event as CustomEvent).detail);if(value?.sessionId!==sessionId||value.turnId!==turnId)return;version++;update(value);setReadError(null);};
    window.addEventListener('easel:execution',listen);
    const read=async()=>{const began=version;try{const value=await fetchChatExecution(sessionId,turnId,controller.signal);if(!controller.signal.aborted&&began===version){update(value);setReadError(null);}}catch{if(!controller.signal.aborted)setReadError({sessionId,turnId,message:'执行记录暂不可读，已有回执保留。'});}finally{if(streaming&&!controller.signal.aborted)timer=setTimeout(()=>void read(),3000);}};
    void read();return()=>{controller.abort();if(timer)clearTimeout(timer);window.removeEventListener('easel:execution',listen);};
  },[sessionId,turnId,streaming,revision]);
  const current=snapshot?.sessionId===sessionId&&snapshot.turnId===turnId?snapshot:null;
  const rows=current?.operations??[];
  const ownsProgress=Boolean(current?.timeline?.some(entry=>entry.type==='progress')||current?.progress?.length);
  useEffect(()=>{onProgressOwnership?.(ownsProgress);},[ownsProgress,onProgressOwnership]);
  const error=readError?.sessionId===sessionId&&readError.turnId===turnId?readError.message:'';
  const note=[error,...(current?.warnings??[])].filter(Boolean).join(' ');
  const notice=note?<div className="chat-execution-note" role="status"><span>{note}</span> <button type="button" onClick={()=>setRevision(x=>x+1)}>重新读取</button></div>:null;
  const loadEarlier=async()=>{if(current?.nextBefore==null||loading)return;setLoading(true);try{const value=await fetchChatExecution(sessionId,turnId,undefined,current.nextBefore);setSnapshot(old=>old?.sessionId===sessionId&&old.turnId===turnId?{...old,nextBefore:value.nextBefore,operations:mergeOperations(value.operations,old.operations),timeline:mergeTimeline(old.timeline,value.timeline)}:old);}catch{setReadError({sessionId,turnId,message:'较早记录暂不可读，已有回执保留。'});}finally{setLoading(false);}};
  if(kinds){const filtered=rows.filter(row=>kinds.includes(row.kind));return <section className="chat-execution" aria-label="筛选后的本轮执行回执">{filtered.map(row=><ExecutionOperation key={row.id} row={row} running={streaming}/>)}{!filtered.length&&<p className="execution-note">{current?emptyMessage||'本轮暂无对应回执。':error?'尚未取得可核验的执行记录。':'正在读取执行记录…'}</p>}{current?.nextBefore!=null&&<button type="button" className="chat-execution-more" disabled={loading} onClick={()=>void loadEarlier()}>{loading?'正在读取…':'加载较早记录'}</button>}{notice}</section>;}
  if(!rows.length&&!current?.plan?.length&&!ownsProgress)return notice?<section className="chat-execution" aria-label="本轮执行记录提示">{notice}</section>:null;
  const byId=new Map(rows.map(row=>[row.id,row]));
  const linked=new Set(current?.timeline?.filter(entry=>entry.type==='operation').map(entry=>entry.operationId));
  const entries=current?.timeline?.filter(entry=>entry.type==='progress'||byId.has(entry.operationId||''))||[];
  const unlinked=rows.filter(row=>!linked.has(row.id));
  return <section className="chat-execution" aria-label="本轮工具执行">
    {!current?.timeline?.length&&!!current?.progress?.length&&<details className="execution-progress"><summary>工作进度 · {current.progress.length} 条</summary><p className="execution-note">旧记录未保存进度与操作的共同顺序。</p>{current.progress.map((text,index)=><p key={index}>{text}</p>)}</details>}
    <div className="execution-timeline">{!!entries.length&&!!unlinked.length&&<p className="execution-note">以下旧操作未记录共同顺序，单独保留。</p>}{unlinked.map(row=><ExecutionOperation key={row.id} row={row} running={streaming}/>)}{entries.map(entry=>entry.type==='progress'?<p key={entry.id} className="execution-progress-text">{entry.text}</p>:<ExecutionOperation key={entry.id} row={byId.get(entry.operationId!)!} running={streaming}/>)}</div>
    {current?.plan&&current.plan.length>0&&<details className="execution-progress"><summary>任务计划 · {current.plan.length} 步</summary><ol className="execution-plan">{current.plan.map((step,i)=><li key={i}><span>{step.status==='completed'?'已完成':step.status==='inProgress'?'进行中':'待执行'}</span>{step.step}</li>)}</ol></details>}
    {current?.nextBefore!=null&&<button type="button" disabled={loading} className="chat-execution-more" onClick={()=>void loadEarlier()}>{loading?'正在读取…':'加载较早记录'}</button>}
    {notice}
  </section>;
}
