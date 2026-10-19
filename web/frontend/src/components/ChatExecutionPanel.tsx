import { useEffect } from 'react';
import { useRunExecution, useChatRun } from '../hooks/useChatRun';
import ExecutionOperation from './ExecutionOperation';
import type { Operation } from '../lib/execution';
import '../styles/chat-execution.css';

export default function ChatExecutionPanel({ sessionId, turnId, streaming, onProgressOwnership, kinds, emptyMessage }: { sessionId: string; turnId: string; streaming: boolean; onOpen?: () => void; onProgressOwnership?: (owned:boolean)=>void; kinds?: Operation['kind'][]; emptyMessage?: string }) {
  const {current,error,loading,loadEarlier,refresh}=useRunExecution(sessionId,turnId,streaming);
  const run=useChatRun();
  const shared=run?.sessionId===sessionId&&run.turnId===turnId;
  const rows=current?.operations??[];
  const ownsProgress=Boolean(shared||current?.timeline?.some(entry=>entry.type==='progress')||current?.progress?.length);
  useEffect(()=>{onProgressOwnership?.(ownsProgress);},[ownsProgress,onProgressOwnership]);
  const note=[error,...(current?.warnings??[])].filter(Boolean).join(' ');
  const notice=note?<div className="chat-execution-note" role="status"><span>{note}</span> <button type="button" onClick={refresh}>重新读取</button></div>:null;
  if(kinds){const filtered=rows.filter(row=>kinds.includes(row.kind));return <section className="chat-execution" aria-label="筛选后的本轮执行回执">{filtered.map(row=><ExecutionOperation key={row.id} row={row} running={streaming}/>)}{!filtered.length&&<p className="execution-note">{current?emptyMessage||'本轮暂无对应回执。':error?'尚未取得可核验的执行记录。':'正在读取执行记录…'}</p>}{current?.nextBefore!=null&&<button type="button" className="chat-execution-more" disabled={loading} onClick={()=>void loadEarlier()}>{loading?'正在读取…':'加载较早记录'}</button>}{notice}</section>;}
  if(!rows.length&&(shared||!current?.plan?.length)&&!ownsProgress)return notice?<section className="chat-execution" aria-label="本轮执行记录提示">{notice}</section>:null;
  const byId=new Map(rows.map(row=>[row.id,row]));
  const linked=new Set(current?.timeline?.filter(entry=>entry.type==='operation').map(entry=>entry.operationId));
  const entries=current?.timeline?.filter(entry=>entry.type==='progress'||byId.has(entry.operationId||''))||[];
  const unlinked=rows.filter(row=>!linked.has(row.id));
  return <section className="chat-execution" aria-label="本轮工具执行">
    {!shared&&!current?.timeline?.length&&!!current?.progress?.length&&<details className="execution-progress"><summary>工作进度 · {current.progress.length} 条</summary><p className="execution-note">旧记录未保存进度与操作的共同顺序。</p>{current.progress.map((text,index)=><p key={index}>{text}</p>)}</details>}
    <div className="execution-timeline">{!!entries.length&&!!unlinked.length&&<p className="execution-note">以下旧操作未记录共同顺序，单独保留。</p>}{unlinked.map(row=><ExecutionOperation key={row.id} row={row} running={streaming}/>)}{entries.map(entry=>entry.type==='progress'?shared?null:<p key={entry.id} className="execution-progress-text">{entry.text}</p>:<ExecutionOperation key={entry.id} row={byId.get(entry.operationId!)!} running={streaming}/>)}</div>
    {!shared&&current?.plan&&current.plan.length>0&&<details className="execution-progress"><summary>任务计划 · {current.plan.length} 步</summary><ol className="execution-plan">{current.plan.map((step,i)=><li key={i}><span>{step.status==='completed'?'已完成':step.status==='inProgress'?'进行中':step.status==='blocked'?'受阻':step.status==='failed'?'失败':'待执行'}</span>{step.step}</li>)}</ol></details>}
    {current?.nextBefore!=null&&<button type="button" disabled={loading} className="chat-execution-more" onClick={()=>void loadEarlier()}>{loading?'正在读取…':'加载较早记录'}</button>}
    {notice}
  </section>;
}
