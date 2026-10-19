import { useEffect, useState } from 'react';
import { taskRequest, taskStatus, type TaskSnapshot } from '../lib/tasks';
import { fetchPublishReceipts, type PublishReceipt } from '../lib/api';
import { publishReceiptStatus, publishPlatformLabel } from '../lib/publishReceipts';
import Select from './ui/Select';
import { IconTarget, IconCalendar, IconPublish, IconChevron, IconRefresh } from './icons';
import '../styles/activity-hub.css';

export default function TaskOverview({onChat,onSchedules,onPublish}:{onChat?:(id:string)=>void;onSchedules?:()=>void;onPublish?:()=>void}) {
  const [data,setData]=useState<{tasks:TaskSnapshot;receipts:PublishReceipt[];at:string}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0),[filter,setFilter]=useState('all');
  useEffect(()=>{
    let disposed=false,reading=false;let timer:ReturnType<typeof setTimeout>|undefined,request:AbortController|undefined;
    const read=async()=>{if(disposed||document.hidden||reading)return;reading=true;setLoading(true);request=new AbortController();const controller=request,deadline=setTimeout(()=>controller.abort(),12000);
      try{const [tasks,receipts]=await Promise.all([taskRequest<TaskSnapshot>('',undefined,'GET',controller.signal),fetchPublishReceipts(controller.signal)]);if(!disposed&&!controller.signal.aborted){setData({tasks,receipts,at:new Date().toLocaleTimeString('zh-CN',{hour12:false})});setError('');}}
      catch{if(!disposed)setError('任务汇总读取失败，保留上次快照；当前状态可能已变化。');}
      finally{clearTimeout(deadline);reading=false;if(!disposed){setLoading(false);if(!document.hidden)timer=setTimeout(()=>void read(),15000);}}};
    const visible=()=>{clearTimeout(timer);if(!document.hidden)void read();};document.addEventListener('visibilitychange',visible);void read();return()=>{disposed=true;request?.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
  },[revision]);
  const rows=[...(data?.tasks.goals||[]).map(goal=>({id:goal.id,source:'对话目标',title:goal.title,status:taskStatus[goal.status]||goal.status,state:['completed','cancelled'].includes(goal.status)?'done':['blocked','paused'].includes(goal.status)?'attention':'active',detail:goal.reason,open:()=>onChat?.(goal.sessionId)})),...(data?.tasks.plans||[]).map(plan=>({id:plan.id,source:'定时计划',title:plan.title,status:plan.enabled?'已启用':'已停用',state:plan.enabled?'active':'attention',detail:`最近触发：${taskStatus[plan.history?.at(-1)?.status || ''] || plan.history?.at(-1)?.status || '尚未记录'}；启用状态不代表上次执行成功。`,open:()=>onSchedules?.()})),...(data?.receipts||[]).map(receipt=>({id:receipt.receiptId,source:'发布',title:`${publishPlatformLabel(receipt.platform)} · ${receipt.title}`,status:publishReceiptStatus(receipt).label,state:receipt.outcome==='published'||receipt.outcome==='draft'?'done':receipt.outcome==='failed'||receipt.outcome==='unverified'||receipt.outcome==='submitted'?'attention':'active',detail:publishReceiptStatus(receipt).description,open:()=>onPublish?.()}))];
  const shown=rows.filter(row=>filter==='all'||row.state===filter);
  return <section className="task-overview" aria-label="跨来源任务">
    <header><div><h2>任务进展</h2><p className="hub-note">查看对话目标、定时计划和发布结果。</p></div>
      <Select aria-label="任务状态" value={filter} onChange={setFilter} options={[{value:'all',label:'全部状态'},{value:'active',label:'进行中 / 已启用'},{value:'attention',label:'需要处理'},{value:'done',label:'已结束'}]}/>
      <button type="button" className="btn btn-sm" disabled={loading} onClick={()=>setRevision(x=>x+1)}><IconRefresh size={15}/>{loading?'刷新中…':'刷新'}</button>
    </header>
    {error&&<p role="alert" className="hub-error">{error}</p>}
    <p className="hub-note">{data?`上次读取 ${data.at}`:'正在读取任务…'} · 定时计划已启用不代表执行成功。</p>
    <div className="task-overview-list">{shown.map(row=>{
      const Icon = row.source === '发布' ? IconPublish : row.source === '定时计划' ? IconCalendar : IconTarget;
      return <article key={`${row.source}:${row.id}`}>
        <span className="record-source-icon" aria-hidden="true"><Icon size={20}/></span>
        <div className="task-row-content"><h3>{row.title}</h3><small>{row.source}</small>{row.detail&&<p>{row.detail}</p>}</div>
        <span className={`record-state is-${row.state}`}>{row.status}</span>
        <button type="button" className="btn btn-sm" onClick={row.open}>打开{row.source==='发布'?'发布页':row.source==='定时计划'?'定时任务':'原对话'} <IconChevron size={14}/></button>
      </article>;
    })}{data&&!shown.length&&<div className="record-empty"><IconTarget size={27}/><h3>当前没有符合条件的任务</h3><p>切换状态筛选，或前往对话、定时任务与发布页创建任务。</p></div>}</div>
  </section>;
}
