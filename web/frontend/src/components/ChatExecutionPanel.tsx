import { useEffect, useState } from 'react';
import { fetchChatExecution, type ChatExecution } from '../lib/api';
import { decodeExecution, mergeOperations } from '../lib/execution';
import ExecutionOperation from './ExecutionOperation';
import '../styles/chat-execution.css';

export default function ChatExecutionPanel({ sessionId, turnId, streaming, onOpen }: { sessionId: string; turnId: string; streaming: boolean; onOpen?: () => void }) {
  const [snapshot,setSnapshot]=useState<ChatExecution|null>(null),[expanded,setExpanded]=useState(false);
  const [readError,setReadError]=useState<{sessionId:string;turnId:string;message:string}|null>(null);
  const [revision,setRevision]=useState(0),[loading,setLoading]=useState(false),[filter,setFilter]=useState('all');
  useEffect(()=>{setExpanded(false);setFilter('all');},[sessionId,turnId]);
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,version=0;
    const update=(value:ChatExecution)=>setSnapshot(old=>old?.sessionId===sessionId&&old.turnId===turnId?{...old,...value,nextBefore:old.nextBefore===null?null:old.nextBefore===undefined?value.nextBefore:value.nextBefore===undefined?old.nextBefore:Math.min(old.nextBefore,value.nextBefore??0),operations:mergeOperations(old.operations,value.operations)}:value);
    const listen=(event:Event)=>{const value=decodeExecution((event as CustomEvent).detail);if(value?.sessionId!==sessionId||value.turnId!==turnId)return;version++;update(value);setReadError(null);};
    window.addEventListener('easel:execution',listen);
    const read=async()=>{const began=version;try{const value=await fetchChatExecution(sessionId,turnId,controller.signal);if(!controller.signal.aborted&&began===version){update(value);setReadError(null);}}catch{if(!controller.signal.aborted)setReadError({sessionId,turnId,message:'执行记录暂不可读，已有回执保留。'});}finally{if(streaming&&!controller.signal.aborted)timer=setTimeout(()=>void read(),3000);}};
    void read();return()=>{controller.abort();if(timer)clearTimeout(timer);window.removeEventListener('easel:execution',listen);};
  },[sessionId,turnId,streaming,revision]);
  const current=snapshot?.sessionId===sessionId&&snapshot.turnId===turnId?snapshot:null;
  const rows=current?.operations??[];
  const error=readError?.sessionId===sessionId&&readError.turnId===turnId?readError.message:'';
  const note=[error,...(current?.warnings??[])].filter(Boolean).join(' ');
  const notice=note?<div className="chat-execution-note" role="status"><span>{note}</span> <button type="button" onClick={()=>setRevision(x=>x+1)}>重新读取</button></div>:null;
  const loadEarlier=async()=>{if(current?.nextBefore==null||loading)return;setLoading(true);try{const value=await fetchChatExecution(sessionId,turnId,undefined,current.nextBefore);setSnapshot(old=>old?.sessionId===sessionId&&old.turnId===turnId?{...old,nextBefore:value.nextBefore,operations:mergeOperations(value.operations,old.operations)}:old);}catch{setReadError({sessionId,turnId,message:'较早记录暂不可读，已有回执保留。'});}finally{setLoading(false);}};
  if(!rows.length&&!current?.plan?.length&&!current?.progress?.length)return notice?<section className="chat-execution" aria-label="本轮执行记录提示">{notice}{onOpen&&<button type="button" onClick={onOpen}>运行记录 ↗</button>}</section>:null;
  const files=new Set(rows.filter(row=>row.diff&&row.path).map(row=>row.path));
  const filtered=filter==='all'?rows:rows.filter(row=>filter==='files'?row.kind==='file_change':filter==='commands'?row.kind==='command':row.kind==='browser'||row.kind==='search');
  const visible=expanded?filtered:filtered.filter((row,index)=>index>=filtered.length-3||row.status==='running'||row.status==='failed');
  return <section className="chat-execution" aria-label="本轮工具执行">
    <div className="chat-execution-heading"><span>执行过程 · {current?.total??rows.length} 项{files.size>0&&` · ${files.size} 个文件有修改回执`} </span>{onOpen&&<button type="button" onClick={onOpen}>运行记录 ↗</button>}</div>
    <p className="execution-source">{current?.source==='gateway'||current?.source==='codex'?'引擎事件与实际回执':'会话回执 · 定期更新'}{streaming?' · 执行中':''}</p>
    {!!current?.progress?.length&&<details className="execution-progress"><summary>工作进度 · {current.progress.length} 条</summary>{current.progress.map((text,index)=><p key={index}>{text}</p>)}</details>}
    {current?.plan&&current.plan.length>0&&<ol className="execution-plan">{current.plan.map((step,i)=><li key={i}><span>{step.status==='completed'?'已完成':step.status==='inProgress'?'进行中':'待执行'}</span>{step.step}</li>)}</ol>}
    <div className="execution-filters" role="group" aria-label="筛选执行记录">{[['all','全部'],['commands','终端'],['files','文件'],['pages','网页']].map(([id,label])=><button type="button" key={id} aria-pressed={filter===id} onClick={()=>{setFilter(id);setExpanded(true);}}>{label}</button>)}</div>
    {visible.map(row=><ExecutionOperation key={row.id} row={row} running={streaming}/>)}
    {!filtered.length&&<p className="execution-note">本轮没有此类操作回执。</p>}
    {filtered.length>3&&<button type="button" className="chat-execution-more" onClick={()=>setExpanded(x=>!x)}>{expanded?'收起':`查看全部 ${filtered.length} 项`}</button>}
    {current?.nextBefore!=null&&<button type="button" disabled={loading} className="chat-execution-more" onClick={()=>void loadEarlier()}>{loading?'正在读取…':'加载较早记录'}</button>}
    {notice}
  </section>;
}
