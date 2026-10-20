import { useEffect, useId, useRef, useState } from 'react';
import { useChatRun } from '../hooks/useChatRun';
import type { TaskGoal } from '../lib/tasks';
import { taskStatus } from '../lib/tasks';
import { formatChatElapsed } from '../lib/chatTiming';
import { progressEntries, progressText } from '../lib/chatProgress';
import { IconCheck, IconChevron, IconClock, IconInfo, IconLoader, IconStop } from './icons';
import '../styles/chat-run-progress.css';

const labels:Record<string,string>={pending:'待执行',inProgress:'进行中',completed:'已完成',blocked:'受阻',failed:'失败'};
export default function ChatProgressCapsule({goal,activity,startedAt,elapsedMs,failed,stopped,onGoal}:{goal?:TaskGoal;activity?:string|string[];startedAt?:number;elapsedMs?:number;failed?:boolean;stopped?:boolean;onGoal:()=>void}) {
  const run=useChatRun(),id=useId(),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const [expanded,setExpanded]=useState(false),[showAll,setShowAll]=useState(false),[now,setNow]=useState(Date.now);
  const [showCompleted,setShowCompleted]=useState(false),[showPending,setShowPending]=useState(false);
  const scope=`${run?.sessionId}:${run?.turnId}`;
  useEffect(()=>{setExpanded(false);setShowAll(false);setShowCompleted(false);setShowPending(false);},[scope]);
  useEffect(()=>{if(!run?.streaming||startedAt===undefined)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[run?.streaming,startedAt]);
  useEffect(()=>{if(!expanded)return;const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setExpanded(false);};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[expanded]);
  if(!run)return null;
  const snapshot=run.execution.current;
  const plan=snapshot?.plan?.length?snapshot.plan:(!run.turnId||goal?.currentTurnId===run.turnId?goal?.steps?.map(step=>({step:step.title,status:step.status==='in_progress'?'inProgress':step.status})):undefined)||[];
  const completed=plan.filter(step=>step.status==='completed').length;
  const current=plan.find(step=>step.status==='inProgress')||plan.find(step=>step.status==='blocked'||step.status==='failed')||plan.find(step=>step.status==='pending');
  const timelineProgress=snapshot?.timeline?.filter(entry=>entry.type==='progress').map(entry=>entry.text||'');
  const rawProgress=timelineProgress?.length?timelineProgress:snapshot?.progress||[];
  const progress=progressEntries(rawProgress);
  const activityLabel=typeof activity==='string'?activity.split('\n').at(-1):Array.isArray(activity)?activity.filter(item=>typeof item==='string').at(-1):'';
  const latest=progressText(rawProgress.at(-1)||activityLabel||'');
  const label=run.execution.error?'进度更新中断':failed?'本轮失败':stopped?'本轮已停止':latest==='等待你回答'?latest:current?.step||(!run.streaming&&plan.length&&completed===plan.length?'清单已完成':latest||progress.at(-1)||goal?.title||(run.streaming?'正在执行':'本轮记录'));
  if(!plan.length&&!goal&&!run.streaming&&!progress.length&&!latest&&!failed&&!stopped&&!run.execution.error)return null;
  const elapsed=elapsedMs??(run.streaming&&startedAt!==undefined?Math.max(0,now-startedAt):undefined);
  const state=failed||run.execution.error?'error':stopped?'stopped':run.streaming?'running':plan.length&&completed===plan.length?'done':'idle';
  const StatusIcon=state==='error'?IconInfo:state==='stopped'?IconStop:state==='running'?IconLoader:state==='done'?IconCheck:IconClock;
  const history=progress.filter(text=>text!==label&&text!==goal?.title&&!plan.some(step=>step.step===text));
  const finishedSteps=plan.filter(step=>step.status==='completed');
  const openSteps=plan.filter(step=>step.status!=='completed');
  const renderStep=(step:typeof plan[number],index:number)=><li key={index} data-state={step.status}><span className="chat-progress-step-icon" aria-hidden="true">{step.status==='completed'?<IconCheck size={14}/>:step.status==='inProgress'?<IconLoader size={14}/>:step.status==='blocked'||step.status==='failed'?<IconInfo size={14}/>:<i/>}</span><div>{step.step}<small>{labels[step.status]||'状态未上报'}</small></div></li>;
  const close=()=>{setExpanded(false);trigger.current?.focus();};
  return <div className="chat-progress-anchor" ref={root} onKeyDown={event=>{if(event.key==='Escape'&&expanded){event.preventDefault();event.stopPropagation();setExpanded(false);trigger.current?.focus();}}}>
    <button type="button" ref={trigger} className="chat-progress-capsule" data-state={state} aria-expanded={expanded} aria-controls={id} aria-label={`工作进度：${label}`} title={label} onClick={()=>setExpanded(value=>!value)}><span className="chat-progress-symbol" aria-hidden="true"><StatusIcon size={14}/></span><span className="chat-progress-current">{label}</span>{plan.length>0&&<small>{completed}/{plan.length}</small>}<span className="chat-progress-chevron" aria-hidden="true"><IconChevron size={13}/></span></button>
    {expanded&&<section id={id} className="chat-progress-popover" aria-label="工作进度清单">
      <header><strong>{goal?'目标进度':'工作进度'}</strong>{elapsed!==undefined&&<small>用时 {formatChatElapsed(elapsed)}</small>}<button type="button" className="chat-progress-collapse" aria-label="收起工作进度" onClick={close}><IconChevron size={14}/></button></header>
      {goal&&<p className="chat-progress-objective">{goal.title} <small>{taskStatus[goal.status]||goal.status}</small></p>}
      {plan.length>0&&<><div className="chat-progress-count"><span>任务清单</span><span>{completed}/{plan.length}</span></div><div className="chat-progress-track" aria-hidden="true"><span style={{width:`${completed/plan.length*100}%`}}/></div>
        {finishedSteps.length>0&&<><button type="button" className="chat-progress-group" aria-expanded={showCompleted} aria-controls={`${id}-completed`} onClick={()=>setShowCompleted(value=>!value)}><IconChevron size={12}/>已完成 {finishedSteps.length} 项</button><ol id={`${id}-completed`} hidden={!showCompleted}>{finishedSteps.map(renderStep)}</ol></>}
        <ol>{openSteps.slice(0,3).map(renderStep)}</ol>
        {openSteps.length>3&&<><button type="button" className="chat-progress-group" aria-expanded={showPending} aria-controls={`${id}-pending`} onClick={()=>setShowPending(value=>!value)}><IconChevron size={12}/>其余待处理 {openSteps.length-3} 项</button><ol id={`${id}-pending`} hidden={!showPending}>{openSteps.slice(3).map(renderStep)}</ol></>}
      </>}
      {!plan.length&&<div className="chat-progress-summary" data-state={state}><StatusIcon size={16}/><span>{label}</span></div>}
      {history.length>0&&<div className="chat-progress-history"><button type="button" className="chat-progress-history-toggle" aria-expanded={showAll} aria-controls={`${id}-history`} onClick={()=>setShowAll(value=>!value)}>{showAll?'收起较早进度':`较早进度 · ${history.length}`}<IconChevron size={12}/></button><div id={`${id}-history`} hidden={!showAll}>{history.map((text,index)=><p key={index}>{text}</p>)}</div></div>}
      {(failed||stopped)&&plan.some(step=>step.status!=='completed')&&<p role="status">{failed?'本轮失败':'本轮已停止'}，未完成步骤保留。</p>}
      {!run.streaming&&!failed&&!stopped&&plan.some(step=>step.status!=='completed')&&<p className="chat-progress-note">本轮已结束，清单仍有未完成项；保留 Agent 最后上报状态。</p>}
      {run.execution.error&&<p role="status">{run.execution.error}<button type="button" onClick={run.execution.refresh}>重新读取</button></p>}
      {goal&&<button type="button" className="chat-progress-goal" onClick={()=>{setExpanded(false);onGoal();}}>目标设置与验收 →</button>}
    </section>}
  </div>;
}
