import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import Select from './ui/Select';
import {fetchOfficeTaskModels,type OfficeModelOption} from '../lib/officeControls';
import {taskRequest,type TaskGoal,type GoalSpec} from '../lib/tasks';
import '../styles/chat-goal.css';

export default function ChatGoalDialog({sessionId,engine,title,goal,seed='',modelRef='',onClose,onChanged,onConfigured}:{sessionId:string;engine:string;title:string;goal?:TaskGoal;seed?:string;modelRef?:string;onClose:()=>void;onChanged:()=>void;onConfigured?:()=>void}) {
  const [objective,setObjective]=useState(seed||goal?.objective||'');
  const [models,setModels]=useState<OfficeModelOption[]>([]),[model,setModel]=useState(goal?.modelRef||modelRef);
  const [iterations,setIterations]=useState(goal?.maxIterations||5),[seconds,setSeconds]=useState(goal?.maxSeconds||1200),[tools,setTools]=useState(goal?.maxTools||40),[images,setImages]=useState(goal?.maxImages||0);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[savedId,setSavedId]=useState('');
  const dialog=useRef<HTMLDivElement>(null),textarea=useRef<HTMLTextAreaElement>(null);
  const unsupported=engine==='codex';
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;textarea.current?.focus();
    return()=>{if(previous?.isConnected)previous.focus();};
  },[]);
  useEffect(()=>{if(unsupported||goal)return;const controller=new AbortController();
    void fetchOfficeTaskModels(sessionId,controller.signal).then(value=>{if(controller.signal.aborted)return;const options=value.options.filter(o=>o.configured);setModels(options);
      if(!modelRef)setModel(value.currentModelRef||value.defaultModelRef||'');
    }).catch(()=>{if(!controller.signal.aborted)setError('当前模型暂不可核验，请关闭后重试。');});
    return()=>controller.abort();
  },[sessionId,modelRef,unsupported,goal]);
  const locked=Boolean(goal&&['active','completed','cancelled'].includes(goal.status));
  const criteria=goal?.criteria||[{type:'review' as const,label:'目标结果由我验收',value:''}];
  async function save(start:boolean){
    setBusy(true);setError('');let key=savedId;
    try {
      if(!key){
        if(goal){await taskRequest(`/goals/${goal.id}`,{objective:objective.trim(),criteria},'PUT');key=goal.id;}
        else {const spec:GoalSpec={objective:objective.trim(),modelRef:model,criteria,maxIterations:iterations,maxSeconds:seconds,maxTools:tools,maxImages:images};key=(await taskRequest<TaskGoal>('/goals',{sessionId,goal:spec})).id;}
        setSavedId(key);onChanged();onConfigured?.();
      }
      if(start)await taskRequest(`/goals/${key}/action`,{action:goal?'resume':'start'});
      onChanged();onClose();
    }catch(e){setError((key?'目标已保存，尚未确认启动。':'')+(e instanceof Error?e.message:'保存失败，请重试。'));}
    finally{setBusy(false);}
  }
  const close=()=>{if(!busy)onClose();};
  return createPortal(<div className="chat-goal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close();}}>
    <div className="chat-goal-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-goal-title" ref={dialog} tabIndex={-1} onKeyDown={e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}
      if(e.key==='Tab'){const items=[...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),[tabindex="0"]')||[])].filter(n=>n.getClientRects().length>0);
        const first=items[0],last=items.at(-1);if(!first){e.preventDefault();return;}if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
    }}>
      <div className="chat-goal-dialog-heading"><div><span>当前对话 · {title}</span><h2 id="chat-goal-title">{goal?'修改目标':'设置目标'}</h2></div><button type="button" onClick={close} disabled={busy} aria-label="关闭目标设置">×</button></div>
      <p>告诉助手要持续做到什么。它会在这个对话里拆分步骤、推进工作，遇到阻塞或执行上限时停下。</p>
      <form onSubmit={e=>{e.preventDefault();void save(true);}}>
        <label className="chat-goal-objective-label">要持续追求的目标<textarea ref={textarea} required minLength={3} maxLength={6000} rows={4} value={objective} disabled={busy||locked||!!savedId||unsupported} onChange={e=>setObjective(e.target.value)} placeholder="例如：完成这组8张卡片及可编辑HTML，检查中文可读性，直到可以交付"/></label>
        {unsupported&&<p role="status" className="task-reason">Codex 目标执行尚未接入。可继续普通对话，或在 OpenClaw 对话设置目标；不会自动切换引擎。</p>}
        {locked&&<p role="status" className="task-reason">请先暂停并等待当前执行结算，再修改未完成目标。已完成或取消的目标保留历史。</p>}
        <div className="chat-goal-model"><span>执行模型</span>{goal?<strong>{goal.modelRef}</strong>:<Select aria-label="目标执行模型" required value={model} disabled={busy||!!savedId||unsupported} options={models.map(o=>({value:o.id,label:o.label||o.id,description:o.id}))} onChange={setModel} placeholder="选择模型"/>}</div>
        <details className="chat-goal-settings"><summary>执行上限{goal?' · 累计用量保留':''}</summary><div className="chat-goal-budget">{[{label:'轮次',value:iterations,set:setIterations,min:1,max:20},{label:'秒数',value:seconds,set:setSeconds,min:60,max:7200},{label:'工具',value:tools,set:setTools,min:1,max:200},{label:'生图',value:images,set:setImages,min:0,max:16}].map(v=><label key={v.label}>{v.label}<input type="number" required min={v.min} max={v.max} value={v.value} disabled={!!goal||busy||!!savedId||unsupported} onChange={e=>v.set(Number(e.target.value))}/></label>)}</div><p>最多{iterations}轮、{seconds}秒、{tools}次工具、{images}张图。生图预留计入上限；Token与金额暂不硬封顶。修改目标不重置限额。</p></details>
        <small className="chat-goal-quality">步骤完成由助手报告，最终结果由你验收。关闭此窗口不会启动任务。</small>
        {error&&<p role="alert" className="task-error">{error}</p>}
        <div className="chat-goal-dialog-actions"><button className="btn" type="button" onClick={close} disabled={busy}>取消</button><button className="btn" type="button" disabled={busy||locked||unsupported||objective.trim().length<3||!model||!!savedId} onClick={()=>void save(false)}>仅保存</button><button className="btn btn-primary" disabled={busy||locked||unsupported||objective.trim().length<3||!model}>{busy?'正在保存…':savedId?'重试启动':goal?'保存并继续':'设置并开始'}</button></div>
      </form>
    </div>
  </div>,document.body);
}
