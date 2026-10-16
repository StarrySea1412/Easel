import {useEffect,useId,useRef,useState} from 'react';
import {fetchOfficeTaskModels,type OfficeModelOption} from '../lib/officeControls';
import {taskRequest,type TaskGoal,type GoalSpec} from '../lib/tasks';
import Select from './ui/Select';
import '../styles/chat-goal.css';

/** Goal setup occupies the message composer; the ordinary draft stays untouched. */
export default function ChatGoalComposer({sessionId,engine,goal,seed='',modelRef='',blocked=false,onStop,onClose,onChanged,onConfigured}:{sessionId:string;engine:string;goal?:TaskGoal;seed?:string;modelRef?:string;blocked?:boolean;onStop?:()=>void;onClose:()=>void;onChanged:()=>void;onConfigured?:()=>void}) {
  const [objective,setObjective]=useState(seed||goal?.objective||'');
  const [models,setModels]=useState<OfficeModelOption[]>([]),[model,setModel]=useState(goal?.modelRef||modelRef);
  const [iterations,setIterations]=useState(goal?.maxIterations||5),[seconds,setSeconds]=useState(goal?.maxSeconds||1200),[tools,setTools]=useState(goal?.maxTools||40),[images,setImages]=useState(goal?.maxImages||0);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[savedId,setSavedId]=useState('');
  const [loading,setLoading]=useState(!goal&&engine!=='codex'),[modelReady,setModelReady]=useState(Boolean(goal)),[revision,setRevision]=useState(0);
  const textarea=useRef<HTMLTextAreaElement>(null),submitting=useRef(false),alive=useRef(true),saved=useRef('');
  const inputId=useId(),unsupported=engine==='codex';
  useEffect(()=>{alive.current=true;textarea.current?.focus();return()=>{alive.current=false;};},[]);
  useEffect(()=>{if(unsupported||goal)return;const controller=new AbortController();setLoading(true);setModelReady(false);
    void fetchOfficeTaskModels(sessionId,controller.signal).then(value=>{
      if(controller.signal.aborted)return;
      const options=value.available?value.options.filter(o=>o.configured):[],requested=modelRef||value.currentModelRef||value.defaultModelRef||'';
      setModels(options);setModel(requested);setModelReady(value.available&&options.some(o=>o.id===requested));
      setError(value.available&&options.some(o=>o.id===requested)?'':'当前所选模型不可用，请在执行选项中选择已配置模型；不会自动更换模型。');
    }).catch(()=>{if(!controller.signal.aborted)setError('模型暂不可核验，请刷新模型后重试。');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[sessionId,modelRef,unsupported,goal,revision]);
  const locked=Boolean(goal&&['active','completed','cancelled'].includes(goal.status));
  const disabled=busy||blocked||locked||unsupported;
  const criteria=goal?.criteria||[{type:'review' as const,label:'目标结果由我验收',value:''}];
  async function save(start:boolean){
    if(submitting.current||disabled||loading||!modelReady||objective.trim().length<3||objective.trim().length>6000||textarea.current?.form?.reportValidity()===false)return;
    submitting.current=true;setBusy(true);setError('');let key=saved.current;
    try {
      if(!key){
        if(goal){await taskRequest(`/goals/${goal.id}`,{objective:objective.trim(),criteria},'PUT');key=goal.id;}
        else {const spec:GoalSpec={objective:objective.trim(),modelRef:model,criteria,maxIterations:iterations,maxSeconds:seconds,maxTools:tools,maxImages:images};key=(await taskRequest<TaskGoal>('/goals',{sessionId,goal:spec})).id;}
        saved.current=key;
        onChanged();
        if(alive.current){setSavedId(key);onConfigured?.();}
      }
      if(start)await taskRequest(`/goals/${key}/action`,{action:goal?'resume':'start'});
      onChanged();if(alive.current)onClose();
    }catch(e){if(alive.current)setError((key?'目标已保存，尚未确认启动。':'')+(e instanceof Error?e.message:'保存失败，请重试。'));}
    finally{submitting.current=false;if(alive.current)setBusy(false);}
  }
  return <section className="chat-goal-composer" aria-label={goal?'修改当前目标':'设置当前目标'}>
    <div className="chat-goal-composer-heading"><span className="chat-goal-mode"><span aria-hidden="true">◎</span> {goal?'修改目标':'目标模式'}</span><span>在当前对话持续推进</span><button type="button" onClick={onClose} disabled={busy} aria-label="退出目标模式">×</button></div>
    <form onSubmit={e=>{e.preventDefault();void save(true);}}>
      <textarea id={inputId} ref={textarea} className="chat-input chat-goal-input" aria-label="要持续追求的目标" required minLength={3} maxLength={6000} rows={3} value={objective} disabled={busy||locked||!!savedId||unsupported} onChange={e=>setObjective(e.target.value)} onKeyDown={e=>{
        if(e.nativeEvent.isComposing||e.keyCode===229)return;
        if(e.key==='Escape'&&!busy){e.preventDefault();e.stopPropagation();onClose();}
        if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();e.currentTarget.form?.requestSubmit();}
      }} placeholder="描述要完成的事，例如：完成8张卡片并检查中文排版，直到可以交付"/>
      {unsupported&&<p role="status" className="task-reason">Codex 目标执行尚未接入。退出后可继续普通对话，不会自动切换引擎。</p>}
      {(blocked||locked)&&<p role="status" className="task-reason">请先暂停并等待当前执行结束，再设置或修改目标。草稿已保留。</p>}
      {error&&<p role="alert" className="task-error">{error}{!goal&&!savedId&&<button type="button" onClick={()=>setRevision(v=>v+1)} disabled={loading||busy}>刷新模型</button>}</p>}
      <div className="chat-goal-composer-bar"><span className="chat-goal-current-model" title={model}>{loading?'正在确认模型…':model||'尚未选择模型'}</span><button type="submit" className="btn btn-primary" disabled={disabled||loading||!modelReady||objective.trim().length<3}>{busy?'正在设置…':savedId?'重试启动':goal?'保存并继续':'开始目标'}</button></div>
      <details className="chat-goal-settings"><summary>执行选项 <span>默认{iterations}轮 · {Math.round(seconds/60)}分钟</span></summary>
        {!goal&&<div className="chat-goal-model"><span>沿用当前模型</span><Select aria-label="目标执行模型" value={model} disabled={busy||!!savedId||unsupported||loading} options={models.map(o=>({value:o.id,label:o.label||o.id,description:o.id}))} onChange={value=>{setModel(value);setModelReady(models.some(o=>o.id===value));setError('');}} placeholder="选择模型"/></div>}
        <div className="chat-goal-budget">{[{label:'轮次',value:iterations,set:setIterations,min:1,max:20},{label:'秒数',value:seconds,set:setSeconds,min:60,max:7200},{label:'工具',value:tools,set:setTools,min:1,max:200},{label:'生图',value:images,set:setImages,min:0,max:16}].map(v=><label key={v.label}>{v.label}<input type="number" required min={v.min} max={v.max} value={v.value} disabled={!!goal||busy||!!savedId||unsupported} onChange={e=>v.set(Number(e.target.value))}/></label>)}</div>
        <p>最多{iterations}轮、{seconds}秒、{tools}次工具、{images}张图。修改目标保留累计限额；Token与金额暂不硬封顶。</p>
        <button type="button" className="btn btn-sm" disabled={disabled||loading||!modelReady||objective.trim().length<3||!!savedId} onClick={()=>void save(false)}>仅保存，稍后开始</button>
      </details>
      <div className="chat-goal-composer-hint"><small>Enter 开始 · Shift+Enter 换行 · Escape 返回对话</small>{onStop&&blocked&&<button type="button" onClick={onStop}>停止当前对话</button>}</div>
    </form>
  </section>;
}
