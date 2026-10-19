import { useEffect, useId, useRef, useState } from 'react';
import { useChatRun } from '../hooks/useChatRun';
import type { TaskGoal } from '../lib/tasks';
import { taskStatus } from '../lib/tasks';
import { formatChatElapsed } from '../lib/chatTiming';
import '../styles/chat-run-progress.css';

const labels:Record<string,string>={pending:'待执行',inProgress:'进行中',completed:'已完成',blocked:'受阻',failed:'失败'};
export default function ChatProgressCapsule({goal,activity,startedAt,elapsedMs,failed,stopped,onGoal}:{goal?:TaskGoal;activity?:string|string[];startedAt?:number;elapsedMs?:number;failed?:boolean;stopped?:boolean;onGoal:()=>void}) {
  const run=useChatRun(),id=useId(),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const [expanded,setExpanded]=useState(false),[now,setNow]=useState(Date.now);
  const scope=`${run?.sessionId}:${run?.turnId}`;
  useEffect(()=>setExpanded(false),[scope]);
  useEffect(()=>{if(!run?.streaming||startedAt===undefined)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[run?.streaming,startedAt]);
  useEffect(()=>{if(!expanded)return;const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setExpanded(false);};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[expanded]);
  if(!run)return null;
  const snapshot=run.execution.current;
  const plan=snapshot?.plan?.length?snapshot.plan:(!run.turnId||goal?.currentTurnId===run.turnId?goal?.steps?.map(step=>({step:step.title,status:step.status==='in_progress'?'inProgress':step.status})):undefined)||[];
  const completed=plan.filter(step=>step.status==='completed').length;
  const current=plan.find(step=>step.status==='inProgress')||plan.find(step=>step.status==='blocked'||step.status==='failed')||plan.find(step=>step.status==='pending');
  const progress=snapshot?.timeline?.filter(entry=>entry.type==='progress').map(entry=>entry.text||'')||snapshot?.progress||[];
  const activityLabel=typeof activity==='string'?activity.split('\n').at(-1):Array.isArray(activity)?activity.filter(item=>typeof item==='string').at(-1):'';
  const label=run.execution.error?'进度更新中断':failed?'本轮失败':stopped?'本轮已停止':current?.step||(!run.streaming&&plan.length&&completed===plan.length?'清单已完成':progress.at(-1)||activityLabel||goal?.title||(run.streaming?'等待工作进度回执':'本轮记录'));
  if(!plan.length&&!goal&&!run.streaming&&!progress.length&&!activity)return null;
  const elapsed=elapsedMs??(run.streaming&&startedAt!==undefined?Math.max(0,now-startedAt):undefined);
  return <div className="chat-progress-anchor" ref={root} onKeyDown={event=>{if(event.key==='Escape'&&expanded){event.preventDefault();event.stopPropagation();setExpanded(false);trigger.current?.focus();}}}>
    <button type="button" ref={trigger} className={`chat-progress-capsule${run.streaming?' is-running':''}`} aria-expanded={expanded} aria-controls={id} aria-label={`工作进度：${label}`} onClick={()=>setExpanded(value=>!value)}><span className="chat-progress-symbol" aria-hidden="true">{failed?'!':stopped?'Ⅱ':completed===plan.length&&plan.length?'✓':'→'}</span><span className="chat-progress-current">{label}</span>{plan.length>0&&<small>{completed}/{plan.length}</small>}<span aria-hidden="true">{expanded?'⌃':'⌄'}</span></button>
    {expanded&&<section id={id} className="chat-progress-popover" aria-label="工作进度清单">
      <header><strong>{goal?'目标进度':'工作进度'}</strong>{elapsed!==undefined&&<small>{formatChatElapsed(elapsed)}</small>}<button type="button" aria-label="收起工作进度" onClick={()=>{setExpanded(false);trigger.current?.focus();}}>×</button></header>
      {goal&&<p className="chat-progress-objective">{goal.title} <small>{taskStatus[goal.status]||goal.status}</small></p>}
      {plan.length>0?<><div className="chat-progress-count"><span>进程</span><span>{completed}/{plan.length}</span></div><ol>{plan.map((step,index)=><li key={index} data-state={step.status}><span aria-hidden="true">{step.status==='completed'?'✓':step.status==='inProgress'?'→':step.status==='blocked'||step.status==='failed'?'!':'○'}</span><div>{step.step}<small>{labels[step.status]||'状态未上报'}</small></div></li>)}</ol><p className="chat-progress-note">步骤由 Agent 上报；清单勾选不替代最终验收。</p></>:<p className="chat-progress-note">{run.streaming?'Agent 尚未提交结构化清单。长任务会按执行指引主动规划。':'本轮没有结构化清单。'}{label}</p>}
      {progress.length>0&&<details><summary>已记录进度 · {progress.length}</summary>{progress.map((text,index)=><p key={index}>{text}</p>)}</details>}
      {(failed||stopped)&&plan.some(step=>step.status!=='completed')&&<p role="status">{failed?'本轮失败':'本轮已停止'}，未完成步骤保留。</p>}
      {!run.streaming&&!failed&&!stopped&&plan.some(step=>step.status!=='completed')&&<p className="chat-progress-note">本轮已结束，清单仍有未完成项；保留 Agent 最后上报状态。</p>}
      {run.execution.error&&<p role="status">{run.execution.error}<button type="button" onClick={run.execution.refresh}>重新读取</button></p>}
      {goal&&<button type="button" className="chat-progress-goal" onClick={()=>{setExpanded(false);onGoal();}}>目标设置与验收 →</button>}
    </section>}
  </div>;
}
