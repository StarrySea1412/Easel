import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '../styles/activity-hub.css';
import { IconWarn, IconCopy, IconRefresh, IconInfo } from './icons';

type Failure={id:string;at:string;source?:string;route?:string;status?:number;operation?:string;stage?:string;code?:string;relatedEventId?:string;platform?:string;owner?:string;slug?:string;version?:string;revision?:string;locations?:string[]};
const base=()=>window.location.pathname.replace(/\/index\.html$/,'').replace(/\/$/,'');
export function FailureEventLink({id}:{id:string}) {return <button type="button" className="failure-event-link" onClick={()=>window.dispatchEvent(new CustomEvent('easel:failure-detail',{detail:id}))}>查看问题 {id.slice(0,8)}</button>;}
export function FailureMessage({text}:{text:string}) {const ids=[...text.matchAll(/错误编号[：:]\s*([0-9a-f]{32})/g)].map(match=>match[1]);return <>{text}{[...new Set(ids)].map(id=><FailureEventLink key={id} id={id}/>)}</>;}
export default function FailureRecords({eventId}:{eventId?:string}) {
  const [rows,setRows]=useState<Failure[]>([]),[selected,setSelected]=useState(eventId||''),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0),[copy,setCopy]=useState('');
  useEffect(()=>{
    const controller=new AbortController();let disposed=false;const deadline=setTimeout(()=>controller.abort(),12000);setLoading(true);setError('');
    const read=async()=>{try{
      const r=await fetch(`${base()}/api/diagnostics/failures?limit=100`,{signal:controller.signal,cache:'no-store'});if(!r.ok)throw Error();
      const data=await r.json();if(!Array.isArray(data.events))throw Error();let values=data.events.filter((v:Failure)=>v&&/^[0-9a-f]{32}$/.test(v.id)&&typeof v.at==='string');
      if(eventId&&!values.some((v:Failure)=>v.id===eventId)) {const exact=await fetch(`${base()}/api/diagnostics/failures?eventId=${encodeURIComponent(eventId)}`,{signal:controller.signal,cache:'no-store'});if(!exact.ok)throw Error();const body=await exact.json();values=[...(Array.isArray(body.events)?body.events.filter((v:Failure)=>v.id===eventId):[]),...values];}
      if(!controller.signal.aborted)setRows(values);
    }catch{if(!disposed)setError('问题记录读取失败，已有记录保留。');}finally{clearTimeout(deadline);if(!disposed)setLoading(false);}};
    void read();return()=>{disposed=true;clearTimeout(deadline);controller.abort();};
  },[eventId,revision]);
  const current=rows.find(row=>row.id===selected), related=current?rows.filter(row=>row.id===current.id||row.relatedEventId===current.id||row.id===current.relatedEventId):[];
  const safeSummary=current?{id:current.id,at:current.at,operation:current.operation,stage:current.stage,code:current.code,route:current.route,status:current.status,platform:current.platform,owner:current.owner,slug:current.slug,version:current.version,revision:current.revision,locations:current.locations,relatedEventId:current.relatedEventId}:null;
  const operationLabel = (row: Failure) => ({clawhub:'技能导入',publish:'内容发布',accounts:'账号连接',browser:'辅助浏览器',chat:'AI 对话'} as Record<string,string>)[row.operation || ''] || row.operation || '请求失败';
  const stageLabel = (row: Failure) => ({download:'下载技能',preflight:'提交前检查',submit:'提交内容',import:'导入技能',search:'搜索技能',catalog:'读取技能列表',request:'发送请求',response:'接收响应',login_required:'需要重新登录'} as Record<string,string>)[row.stage || row.code || ''] || row.stage || row.code || '阶段未记录';
  const timeLabel = (value: string) => Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString('zh-CN', {hour12:false});
  return <section className="failure-records" aria-label="问题记录">
    <header><div><h2>问题排查</h2><p className="hub-note">遇到失败时，查看发生在哪一步，复制诊断信息以便排查。</p></div>
      <button type="button" className="btn btn-sm" disabled={loading} onClick={()=>setRevision(x=>x+1)}><IconRefresh size={15}/>{loading?'读取中…':'刷新'}</button>
    </header>
    <p className="hub-note">最近 100 条记录 · 更早记录可能已轮转；这里不保存完整正文或凭据。</p>
    {error&&<p role="alert" className="hub-error">{error}</p>}
    <div className="failure-record-layout"><div className="failure-list" aria-label="最近失败事件">
      {loading&&!rows.length&&<p role="status">正在读取问题记录…</p>}
      {!rows.length&&!loading&&!error&&<div className="record-empty"><IconInfo size={25}/><p>{eventId?'未找到该编号，可能已轮转。':'当前没有记录到问题。'}</p></div>}
      {rows.map(row=><button type="button" key={row.id} aria-pressed={row.id===selected} onClick={()=>{setSelected(row.id);setCopy('');}}>
        <span className="failure-row-icon" aria-hidden="true"><IconWarn size={17}/></span><span><strong>{operationLabel(row)}</strong><span>{stageLabel(row)}</span><small>{timeLabel(row.at)} · {row.id.slice(0,8)}</small></span>
      </button>)}
    </div>
    <div className="failure-detail" aria-label="问题详情">{current?<>
      <span className="record-state is-attention"><IconWarn size={14}/>已记录失败 · 修复状态未确认</span>
      <h3>{operationLabel(current)}</h3><p className="hub-note">发生时间：{timeLabel(current.at)}<br/>失败阶段：{stageLabel(current)}</p>
      <button type="button" className="btn btn-sm" onClick={()=>void navigator.clipboard.writeText(JSON.stringify(safeSummary,null,2)).then(()=>setCopy('已复制诊断摘要')).catch(()=>setCopy('复制失败，请手动选择详情'))}><IconCopy size={15}/>复制诊断摘要</button>
      {copy&&<p role="status">{copy}</p>}
      <details className="failure-technical"><summary>技术详情 <small>错误编号、接口与运行版本</small></summary>
        <dl>{Object.entries(safeSummary||{}).filter(([,value])=>value!==undefined).map(([key,value])=><div key={key}><dt>{({id:'错误编号',at:'发生时间',stage:'失败阶段',code:'错误代码',route:'请求入口',status:'HTTP状态',operation:'操作',platform:'平台',owner:'技能作者',slug:'技能名称',version:'产品版本',revision:'运行构建',locations:'源码位置',relatedEventId:'关联编号'} as Record<string,string>)[key]||key}</dt><dd>{typeof value==='object'?JSON.stringify(value):String(value)}</dd></div>)}</dl>
      </details>
      <h4>关联事件时间线</h4><ol>{related.slice().reverse().map(row=><li key={row.id}>{timeLabel(row.at)} · {row.source||'来源未记录'} · {stageLabel(row)}</li>)}</ol>
      <p className="hub-note">按已保存的关联编号展示；错误记录保留不代表问题仍未修复。</p>
    </>:<div className="record-empty"><IconInfo size={27}/><h3>选择一条问题</h3><p>{eventId&&!loading?'该编号未在当前记录中找到。':'点击左侧记录，查看失败阶段和诊断信息。'}</p></div>}</div></div>
  </section>;
}
export function FailureRecordDialog() {
  const [id,setId]=useState('');const previous=useRef<HTMLElement|null>(null),dialog=useRef<HTMLDivElement>(null);
  const close=()=>{setId('');previous.current?.focus();};
  useEffect(()=>{const show=(event:Event)=>{const value=(event as CustomEvent).detail;if(typeof value==='string'&&/^[0-9a-f]{32}$/.test(value)){previous.current=document.activeElement as HTMLElement;setId(value);}};window.addEventListener('easel:failure-detail',show);return()=>window.removeEventListener('easel:failure-detail',show);},[]);
  useEffect(()=>{if(id)dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();},[id]);
  return id?createPortal(<div className="failure-overlay" onClick={event=>{if(event.target===event.currentTarget)close();}}><div role="dialog" aria-modal="true" aria-label="失败事件诊断" ref={dialog} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();close();}if(event.key==='Tab'){const nodes=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button,a,input,[tabindex="0"]')].filter(el=>!el.disabled);if(!nodes.length)return;const first=nodes[0],last=nodes.at(-1)!;if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}}><button type="button" onClick={close} aria-label="关闭问题详情">关闭</button><FailureRecords key={id} eventId={id}/></div></div>,document.body):null;
}
