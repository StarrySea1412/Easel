import { useEffect, useRef, useState } from 'react';
import Select from './ui/Select';
import { fetchOfficeTaskModels, type OfficeModelOption } from '../lib/officeControls';
import { taskRequest,taskStatus,type GoalSpec,type TaskCriterion,type TaskSchedule,type TaskSnapshot,type TaskPlan } from '../lib/tasks';
import { matchesPlan,nextRunLabel,planFilters,planState,scheduleLabel,scheduleTemplates,type PlanFilter } from '../lib/automation';
import type { ChatSession } from '../lib/store';
import '../styles/automation.css';

const empty:TaskSnapshot={goals:[],plans:[],runs:[],serverTime:0};
const zones=['Asia/Shanghai','America/Los_Angeles','America/New_York','Europe/London','UTC'];
function dateLabel(at:number,zone?:string){try{return new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short',timeZone:zone}).format(at*1000);}catch{return '时间不可用';}}
const defaultSchedule=():TaskSchedule=>({kind:'daily',timezone:'Asia/Shanghai',time:'09:00',minutes:60,weekdays:[0],day:1,at:Math.floor(Date.now()/1000)+3600});

export default function AutomationPage({sessions,sessionId,onOpen,initialDraft,onDraftConsumed}:{sessions:ChatSession[];sessionId:string|null;onOpen:(id:string)=>void;initialDraft?:{objective?:string;title?:string}|null;onDraftConsumed?:()=>void}){
  const [data,setData]=useState(empty),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const [readError,setReadError]=useState(''),[loaded,setLoaded]=useState(false),[readAt,setReadAt]=useState(0),[query,setQuery]=useState(''),[filter,setFilter]=useState<PlanFilter>('all');
  const actionPending=useRef(false);
  const [showForm,setShowForm]=useState(false),[editId,setEditId]=useState<string>();
  const [title,setTitle]=useState(''),[objective,setObjective]=useState(''),[model,setModel]=useState(''),[models,setModels]=useState<OfficeModelOption[]>([]);
  const [session,setSession]=useState(sessionId||''),[criteria,setCriteria]=useState<TaskCriterion[]>([{type:'review',label:'检查交付结果的质量',value:''}]);
  const [iterations,setIterations]=useState(5),[seconds,setSeconds]=useState(1200),[tools,setTools]=useState(40),[images,setImages]=useState(0);
  const [schedule,setSchedule]=useState<TaskSchedule>(defaultSchedule);
  const [missed,setMissed]=useState<'skip'|'coalesce'>('skip'),[preview,setPreview]=useState<number[]>([]),[previewError,setPreviewError]=useState('');
  const [ready,setReady]=useState<boolean|null>(null),[guardReason,setGuardReason]=useState(''),[notice,setNotice]=useState(''),[modelError,setModelError]=useState(''),[previewKey,setPreviewKey]=useState('');
  const scheduleKey=JSON.stringify(schedule),hasDraft=Boolean(title||objective||editId);
  useEffect(()=>{const c=new AbortController();let timer:ReturnType<typeof setTimeout>;async function read(){try{const value=await taskRequest<TaskSnapshot>('',undefined,'GET',c.signal);if(!c.signal.aborted){setData(value);setReadError('');setReadAt(Date.now());setLoaded(true);}}catch(e){if(!c.signal.aborted)setReadError(e instanceof Error?e.message:'任务读取失败');}finally{if(!c.signal.aborted)timer=setTimeout(()=>void read(),5000);}}void read();return()=>{c.abort();clearTimeout(timer);};},[revision]);
  useEffect(()=>{const c=new AbortController();void fetchOfficeTaskModels(null,c.signal).then(v=>{if(!c.signal.aborted){setModels(v.options.filter(o=>o.configured&&o.enabled!==false));setModelError('');}}).catch(e=>{if(!c.signal.aborted)setModelError(e instanceof Error?e.message:'模型选项读取失败');});void taskRequest<{ready:boolean;reason:string}>('/capability',undefined,'GET',c.signal).then(v=>{if(!c.signal.aborted){setReady(v.ready);setGuardReason(v.reason);}}).catch(()=>{if(!c.signal.aborted){setReady(false);setGuardReason('执行状态暂不可读，请刷新后重试。');}});return()=>c.abort();},[revision]);
  useEffect(()=>{if(!showForm)return;const c=new AbortController();const key=JSON.stringify(schedule);void taskRequest<{times:number[]}>('/preview',schedule,'POST',c.signal).then(v=>{if(!c.signal.aborted){setPreview(v.times);setPreviewError('');setPreviewKey(key);}}).catch(e=>{if(!c.signal.aborted){setPreview([]);setPreviewError(e instanceof Error?e.message:'时间无效');setPreviewKey(key);}});return()=>c.abort();},[schedule,showForm]);
  function reset(){setShowForm(true);setEditId(undefined);setTitle('');setObjective('');setModel('');setSession(sessionId||'');setCriteria([{type:'review',label:'检查交付结果的质量',value:''}]);setIterations(5);setSeconds(1200);setTools(40);setImages(0);setSchedule(defaultSchedule());setMissed('skip');setPreviewKey('');setNotice('');setError('');}
  // A draft submitted from the chat composer opens the plan form, prefilled.
  useEffect(()=>{if(!initialDraft||hasDraft)return;reset();setTitle(initialDraft.title||'');setObjective(initialDraft.objective||'');setNotice('对话草稿已带入，保存后可启用。');onDraftConsumed?.();},[initialDraft,hasDraft]); // eslint-disable-line react-hooks/exhaustive-deps
  function edit(p:TaskPlan){setShowForm(true);setEditId(p.id);setTitle(p.title);setObjective(p.goal.objective);setModel(p.goal.modelRef);setSession(p.sessionId||'');setCriteria(p.goal.criteria);setIterations(p.goal.maxIterations);setSeconds(p.goal.maxSeconds);setTools(p.goal.maxTools);setImages(p.goal.maxImages);setSchedule(p.schedule);setMissed(p.missedPolicy);setPreviewKey('');setError('');setNotice('');}
  async function save(event:React.FormEvent){event.preventDefault();if(actionPending.current||modelError||previewKey!==scheduleKey||!preview.length||previewError||!models.some(m=>m.id===model))return;actionPending.current=true;setBusy(true);setError('');try{const goal:GoalSpec={objective,modelRef:model,criteria,maxIterations:iterations,maxSeconds:seconds,maxTools:tools,maxImages:images};const common={title:title||objective.slice(0,50),...(session?{sessionId:session}:{}),goal};await taskRequest(editId?`/plans/${editId}`:'/plans',{...common,schedule,missedPolicy:missed,freshnessSeconds:900},editId?'PUT':'POST');setShowForm(false);setEditId(undefined);setTitle('');setObjective('');setNotice('已保存为暂停计划。');setRevision(v=>v+1);}catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{actionPending.current=false;setBusy(false);}}
  async function planAction(p:TaskPlan,action:string){if(actionPending.current)return;actionPending.current=true;setBusy(true);setError('');try{await taskRequest(`/plans/${p.id}/action`,{action,...(action==='run'?{requestId:crypto.randomUUID()}: {})});setRevision(v=>v+1);setNotice(action==='run'?'本次运行已登记，排期不变。':action==='pause'?'排期已暂停，当前运行不受影响。':'计划已启用。');}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{actionPending.current=false;setBusy(false);}}
  function updateCriterion(i:number,patch:Partial<TaskCriterion>){setCriteria(rows=>rows.map((r,n)=>n===i?{...r,...patch}:r));}
  const filtered=data.plans.filter(p=>matchesPlan(p,data.goals,filter)&&`${p.title} ${p.goal.objective}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const stale=Boolean(readError)||!loaded;
  return <section className="automation-page" aria-label="定时任务"><div className="automation-content">
    <header className="automation-header"><h1>定时任务</h1><div className="task-actions"><button className="btn btn-sm" onClick={()=>setRevision(v=>v+1)}>刷新</button><button className="btn btn-primary" disabled={showForm||busy} onClick={()=>hasDraft?setShowForm(true):reset()}>{hasDraft?'继续编辑':'新建计划'}</button></div></header>
    <div className="automation-toolbar"><div className="automation-filters" role="group" aria-label="计划筛选">{planFilters.map(([id,label])=><button key={id} type="button" aria-pressed={filter===id} onClick={()=>setFilter(id)}>{label}<span>{loaded?data.plans.filter(p=>matchesPlan(p,data.goals,id)).length:'—'}</span></button>)}</div><input type="search" aria-label="搜索计划" placeholder="搜索计划" value={query} onChange={event=>setQuery(event.target.value)}/></div>
    <div className="automation-service"><details><summary>{ready===null?'检查执行状态…':ready?'执行设置':'执行暂不可用'}</summary><p>{guardReason||'轮次、时长、工具与生图数量有上限；Token 与金额不提供硬封顶。'}</p><p>需 Easel 后端保持运行；浏览器可关闭，电脑休眠时不能准时执行。</p>{ready===false&&<button className="btn btn-sm" onClick={()=>setRevision(v=>v+1)}>重新检查</button>}</details><span>{readAt?`${new Date(readAt).toLocaleTimeString('zh-CN')} 更新`:'正在读取计划…'}</span></div>
    {readError&&<p className="task-error" role="alert">{readError}{loaded?' · 显示上次读取结果':''}</p>}{error&&<p className="task-error" role="alert">{error}</p>}{notice&&<p role="status" className="automation-notice">{notice}</p>}
    {showForm&&<form className="automation-form" onSubmit={e=>void save(e)} onInvalidCapture={event=>{const section=(event.target as HTMLElement).closest('details');if(section)section.open=true;}}>
      <div className="task-card-heading"><h2>{editId?'编辑计划':'新建计划'}</h2><button type="button" className="btn btn-sm" disabled={busy} onClick={()=>setShowForm(false)}>收起</button></div>
      <fieldset className="automation-editor" disabled={busy}>
      <label>名称<input value={title} onChange={e=>setTitle(e.target.value)} maxLength={100} placeholder="例如：每周选题初稿"/></label>
      <label>要完成什么<textarea required minLength={3} maxLength={6000} value={objective} onChange={e=>setObjective(e.target.value)} rows={3} placeholder="说明任务、材料与交付文件，避免只写一个模糊方向"/></label>
      <div className="automation-fields"><label>指定执行模型<Select required aria-label="指定执行模型" value={model} options={[...models.map(o=>({value:o.id,label:o.label||o.id,description:o.id})),...(model&&!models.some(o=>o.id===model)?[{value:model,label:`${model}（不可用）`,disabled:true}]:[])]} onChange={setModel} placeholder="选择执行模型"/></label><label>结果放到哪里<Select aria-label="任务对话" value={session} options={[{value:'',label:'每次建立独立对话'},...sessions.filter(s=>s.engine!=='codex'&&!s.importedFromBackup&&!s.parentSessionId).map(s=>({value:s.id,label:s.title}))]} onChange={setSession}/></label></div>
      {modelError&&<p className="task-error" role="alert">{modelError}</p>}
      <details className="automation-advanced"><summary>完成标准与执行上限</summary>
      <fieldset><legend>完成标准</legend><p>文件及指定文字自动核验；视觉效果与内容质量由你确认。</p>{criteria.map((c,i)=><div className="criterion-row" key={i}><Select aria-label={`验收类型 ${i+1}`} value={c.type} options={[{value:'file',label:'文件存在且可读'},{value:'text',label:'输出包含指定文字'},{value:'review',label:'由我验收质量'}]} onChange={v=>updateCriterion(i,{type:v as TaskCriterion['type']})}/><input aria-label={`验收名称 ${i+1}`} required value={c.label} placeholder="验收项名称" maxLength={200} onChange={e=>updateCriterion(i,{label:e.target.value})}/>{c.type!=='review'&&<input aria-label={`验收内容 ${i+1}`} required value={c.value} maxLength={1000} placeholder={c.type==='file'?'outputs 下的相对路径':'必须包含的文字'} onChange={e=>updateCriterion(i,{value:e.target.value})}/>}<button type="button" className="btn btn-sm" disabled={criteria.length===1} aria-label={`删除验收项 ${i+1}`} onClick={()=>setCriteria(rows=>rows.filter((_,n)=>n!==i))}>移除</button></div>)}<button type="button" className="btn btn-sm" disabled={criteria.length>=16} onClick={()=>setCriteria(rows=>[...rows,{type:'file',label:'',value:''}])}>添加验收项</button></fieldset>
      <fieldset><legend>执行上限</legend><div className="automation-budget">{([{label:'最多轮次',value:iterations,set:setIterations,min:1,max:20},{label:'累计秒数',value:seconds,set:setSeconds,min:60,max:7200},{label:'工具次数',value:tools,set:setTools,min:1,max:200},{label:'生图张数',value:images,set:setImages,min:0,max:16}]).map(v=><label key={v.label}>{v.label}<input type="number" required min={v.min} max={v.max} value={v.value} onChange={e=>v.set(Number(e.target.value))}/></label>)}</div><p>生图默认关闭。次数是准入上限，失败预留也计入；工具限制不构成 Shell 沙箱。</p></fieldset>
      </details>
      <fieldset><legend>触发时间</legend><div className="automation-fields"><label>周期<Select aria-label="执行周期" value={schedule.kind} options={[{value:'once',label:'仅一次'},{value:'interval',label:'固定间隔'},{value:'daily',label:'每天'},{value:'workdays',label:'工作日'},{value:'weekly',label:'每周'},{value:'monthly',label:'每月'}]} onChange={v=>setSchedule(s=>({...s,kind:v as TaskSchedule['kind']}))}/></label><label>时区<Select aria-label="计划时区" value={schedule.timezone} options={Array.from(new Set([...zones,schedule.timezone])).map(z=>({value:z,label:z}))} onChange={v=>setSchedule(s=>({...s,timezone:v}))}/></label></div>
        {['once','interval'].includes(schedule.kind)?<label>起始时间（此设备本地时区）<input type="datetime-local" required value={schedule.at?new Date(schedule.at*1000-new Date(schedule.at*1000).getTimezoneOffset()*60000).toISOString().slice(0,16):''} onChange={e=>{const at=new Date(e.target.value).getTime()/1000;if(Number.isFinite(at))setSchedule(s=>({...s,at}));}}/></label>:<label>当地执行时间<input required type="time" value={schedule.time} onChange={e=>setSchedule(s=>({...s,time:e.target.value}))}/></label>}
        {schedule.kind==='interval'&&<label>间隔（分钟）<input type="number" required min={5} max={10080} value={schedule.minutes} onChange={e=>setSchedule(s=>({...s,minutes:Number(e.target.value)}))}/></label>}
        {schedule.kind==='monthly'&&<label>每月几号<input type="number" required min={1} max={31} value={schedule.day||1} onChange={e=>setSchedule(s=>({...s,day:Number(e.target.value)}))}/></label>}
        {schedule.kind==='monthly'&&<p>没有该日期的月份自动跳过（例如31号在二月不执行）。</p>}
        {schedule.kind==='weekly'&&<div className="task-weekdays" role="group" aria-label="执行星期">{['一','二','三','四','五','六','日'].map((label,i)=><label key={i}><input type="checkbox" checked={schedule.weekdays.includes(i)} onChange={e=>setSchedule(s=>({...s,weekdays:e.target.checked?[...s.weekdays,i]:s.weekdays.filter(d=>d!==i)}))}/>周{label}</label>)}</div>}
        <label>服务离线后<Select aria-label="漏跑处理" value={missed} options={[{value:'skip',label:'跳过过期时点'},{value:'coalesce',label:'15分钟内合并补跑一次'}]} onChange={v=>setMissed(v as 'skip'|'coalesce')}/></label>
        <div className="schedule-preview" aria-live="polite"><strong>接下来执行 · {schedule.timezone}</strong>{previewKey!==scheduleKey?<p>正在核对时间…</p>:previewError?<p className="task-error">{previewError}</p>:preview.length?<ol>{preview.map(at=><li key={at}>{dateLabel(at,schedule.timezone)}</li>)}</ol>:<p>没有未来执行时间</p>}</div>
      </fieldset>
      </fieldset>
      <div className="task-actions"><button className="btn btn-primary" disabled={busy||!!modelError||!models.some(m=>m.id===model)||previewKey!==scheduleKey||!preview.length||!!previewError}>{busy?'正在保存…':'保存为暂停计划'}</button><button type="button" className="btn" disabled={busy} onClick={()=>setShowForm(false)}>收起</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>{reset();setShowForm(false);}}>放弃草稿</button></div>
    </form>}
    <section className="automation-plans" aria-label="计划列表" aria-busy={!loaded&&!readError}>
      {!loaded&&!readError&&<p className="automation-empty">正在读取计划…</p>}
      {loaded&&!filtered.length&&<p className="automation-empty">{data.plans.length?'没有匹配的计划':'还没有计划，可以新建或选择模板。'}</p>}
      {filtered.map(p=>{
        const state=planState(p,data.goals);
        return <article key={p.id} className="plan-card" aria-label={`计划：${p.title}`}>
          <header className="plan-heading"><h2 title={p.title}>{p.title}</h2><span className={`plan-state ${state.attention?'is-attention':state.running||p.enabled?'is-active':''}`}>{state.label}</span><details className="plan-more" onKeyDown={event=>{if(event.key==='Escape'){event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();event.stopPropagation();}}}>
            <summary aria-label={`${p.title}的更多操作`}>•••</summary><div className="plan-menu" role="group" aria-label="计划操作">
              <button type="button" disabled={busy||(!p.enabled&&(stale||ready!==true||state.consumed))} onClick={()=>void planAction(p,p.enabled?'pause':'enable')}>{p.enabled?'暂停排期':'启用计划'}</button>
              <button type="button" disabled={busy||stale||p.enabled||(hasDraft&&editId!==p.id)} title={p.enabled?'请先暂停排期':hasDraft&&editId!==p.id?'先保存或放弃当前草稿':undefined} onClick={()=>{if(editId===p.id&&hasDraft)setShowForm(true);else edit(p);}}>编辑计划</button>
              <button type="button" disabled={busy||stale||ready!==true||state.running} onClick={()=>void planAction(p,'run')}>立即运行一次</button>
            </div></details></header>
          <p className="plan-objective" title={p.goal.objective}>{p.goal.objective}</p>
          <div className="plan-timing"><span>{scheduleLabel(p.schedule)}</span><span className={p.enabled?'is-active':''} title={p.enabled&&p.nextAt?`${dateLabel(p.nextAt,p.schedule.timezone)} · ${p.schedule.timezone}`:undefined}>{nextRunLabel(p,data.serverTime||Date.now()/1000)}</span></div>
          {(state.last||state.reason)&&<p className="plan-result" title={state.reason}>{state.last&&<>最近 · {state.status?taskStatus[state.status]||state.status:state.last.goalId?'结果未载入':taskStatus[state.last.status]||state.last.status}{state.reason?' · ':''}</>}{state.reason}</p>}
          <footer className="plan-footer"><span title={p.launchedCount!==undefined?`其中 ${p.launchedCount} 次已建立目标，其余为跳过记录`:undefined}>{p.triggerCount!==undefined?`已触发 ${p.triggerCount} 次`:`最近 ${p.history?.length||0} 条记录`}</span>
          <details className="plan-records"><summary>触发记录 · {p.history?.length||0}</summary>
            <p className="task-model">{p.goal.modelRef} · {p.schedule.timezone}</p>
            {!p.history?.length&&<p>尚未触发</p>}{(p.triggerCount||0)>(p.history?.length||0)&&<p>显示最近 {p.history?.length||0} 条</p>}
            <ol className="plan-history">{p.history?.slice().reverse().map((h,i)=>{
              const g=p.lastGoal?.id===h.goalId?p.lastGoal:data.goals.find(g=>g.id===h.goalId);
              const deleted=g?.sessionDeleted||data.deletedSessions?.some(s=>s.id===h.sessionId);
              return <li key={`${h.at}-${h.goalId||i}`}><div><time>{dateLabel(h.at,p.schedule.timezone)}</time><span>{h.trigger==='manual'?'手动':'定时'} · {g?taskStatus[g.status]||g.status:h.goalId?'已登记，结果未载入':taskStatus[h.status]||h.status}</span></div>{(g?.reason||h.reason)&&<p>{g?.reason||h.reason}</p>}{h.sessionId&&!deleted&&<button className="btn btn-sm" onClick={()=>onOpen(h.sessionId!)}>查看对话与结果</button>}{deleted&&<p>原对话已删除</p>}</li>;
            })}</ol>
          </details>
          </footer>
        </article>;
      })}
    </section>
    {!showForm&&<section className="automation-templates" aria-label="计划模板"><h2>从模板开始</h2><div>{scheduleTemplates.map(template=><button type="button" key={template.id} disabled={hasDraft||busy} title={hasDraft?'先继续编辑或放弃当前草稿':undefined} onClick={()=>{reset();setTitle(template.title);setObjective(template.objective);setSchedule({...defaultSchedule(),kind:template.kind,time:template.time,weekdays:[template.id==='weekly'?4:0]});}}><strong>{template.title}</strong><span>{template.hint}</span><small>{scheduleLabel({...defaultSchedule(),kind:template.kind,time:template.time,weekdays:[template.id==='weekly'?4:0]})}</small></button>)}</div></section>}
  </div></section>;
}
