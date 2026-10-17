import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconCheck, IconInfo } from './icons';
import { fetchSkillRecords, skillState, type LiveSkillAudit, type SkillInvocation } from '../lib/skillEvidence';
import { useAnchoredPanel } from '../hooks/useAnchoredPanel';
import '../styles/skill-audit.css';

const invokedTones = new Set(['success', 'error', 'pending']);

/** Hover/focus panel: what was actually invoked this turn, with the evidence behind it. */
export default function ChatSkillEvidence({record,selectedSkills=[],streaming,onOpen,error,sessionId,turnId}: {record?:LiveSkillAudit;selectedSkills?:string[];streaming:boolean;onOpen?:()=>void;error?:string;sessionId:string;turnId:string}) {
 const [open,setOpen]=useState(false),[pinned,setPinned]=useState(false);
 const [loaded,setLoaded]=useState(false),[loading,setLoading]=useState(false),[ownRecord,setOwnRecord]=useState<LiveSkillAudit>(),[loadError,setLoadError]=useState('');
 const button=useRef<HTMLButtonElement>(null),panel=useRef<HTMLElement>(null);
 const closeTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),autoLoaded=useRef(false);
 const id=useId();
 const current=record||ownRecord;
 const items=current?.invocation||[];
 const visible:SkillInvocation[]=[...items,...selectedSkills.filter(name=>!items.some(item=>item.skill===name)).map(skill=>({skill,status:current?'not_observed':'not_loaded',evidence:[]}))];
 const load=useCallback(async()=>{if(loading)return;setLoading(true);setLoadError('');try{const records=await fetchSkillRecords(sessionId,turnId);setOwnRecord(records[0]);setLoaded(true);}catch(e){setLoadError(e instanceof Error?e.message:'本轮核验读取失败');}finally{setLoading(false);}},[loading,sessionId,turnId]);
 const dismiss=useCallback(()=>{setOpen(false);setPinned(false);},[]);
 const position=useAnchoredPanel(open,dismiss,button,panel,'above',360);
 const keep=()=>{if(closeTimer.current!==undefined){clearTimeout(closeTimer.current);closeTimer.current=undefined;}setOpen(true);};
 const scheduleClose=()=>{if(pinned)return;if(closeTimer.current!==undefined)clearTimeout(closeTimer.current);closeTimer.current=setTimeout(()=>setOpen(false),220);};
 useEffect(()=>()=>{if(closeTimer.current!==undefined)clearTimeout(closeTimer.current);},[]);
 // The invocation verdict loads itself on first open; a failure offers a retry instead of looping requests.
 useEffect(()=>{if(open&&!current&&!autoLoaded.current){autoLoaded.current=true;void load();}},[open,current,load]);
 if(!visible.length&&!streaming&&current)return null;
 const states=visible.map(item=>skillState(item));
 const tone=(error||loadError||states.some(state=>state.tone==='error'))?'error':states.length&&states.every(state=>state.tone==='success')?'success':streaming?'pending':'unknown';
 const label=error||loadError||states.map((state,index)=>`${visible[index].skill}：${state.label}`).join('；')||'尚无执行证据';
 const invoked=visible.filter((_,index)=>invokedTones.has(states[index].tone));
 const ordered=[...visible.keys()].sort((a,b)=>(invokedTones.has(states[a].tone)?0:1)-(invokedTones.has(states[b].tone)?0:1)||a-b);
 const verdict=current
   ? invoked.length?`本轮已调用：${invoked.map(item=>item.skill).join('、')}`:'本轮未观察到 Skill 调用证据'
   :error||loadError?null:loading||!loaded?'正在读取本轮核验记录…':'未找到本轮持久核验记录，无法确认执行情况；近期列表没有包含它，不代表没有执行。';
 return <div className="chat-skill-compact"><button ref={button} type="button" className={`chat-skill-status-icon ${tone}`} aria-label={`Skill核验：${label}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open?id:undefined}
    onPointerEnter={event=>{if(event.pointerType!=='touch')keep();}} onPointerLeave={scheduleClose}
    onFocus={keep} onBlur={event=>{if(!panel.current?.contains(event.relatedTarget as Node))scheduleClose();}}
    onKeyDown={event=>{if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();dismiss();button.current?.focus();}}}
    onClick={()=>{if(pinned)dismiss();else{setPinned(true);setOpen(true);}}}>{tone==='success'?<IconCheck size={15}/>:<IconInfo size={15}/>}</button>
  {open&&createPortal(<section ref={panel} id={id} className="chat-skill-evidence is-floating" role="dialog" aria-label="本轮 Skill 核验" style={position} onPointerEnter={keep} onPointerLeave={scheduleClose}>
    <div className="chat-skill-heading"><strong>Skill 核验</strong><span>{streaming?'执行中 · 持续核对证据':'本轮执行记录'}</span>{onOpen&&<button type="button" className="link-btn" onClick={()=>{dismiss();onOpen();}}>查看运行记录 →</button>}</div>
    {verdict&&<p className={`chat-skill-verdict${invoked.length?' is-called':''}`}>{verdict}</p>}
    {(error||loadError)&&<p className="skill-audit-error">{loadError||error}；已有证据保留。{!current&&<button type="button" className="link-btn" disabled={loading} onClick={()=>void load()}>{loading?'读取中…':'重新读取'}</button>}</p>}
    {!current&&!error&&!loadError&&<p className="skill-audit-note">{streaming?'正在等待本轮核验记录，尚未取得证据。':''}<button className="link-btn" disabled={loading} onClick={()=>void load()}>{loading?'读取中…':'重新读取'}</button></p>}
    {ordered.map(i=>{const item=visible[i];const state=item.status==='not_loaded'?{label:loaded?'记录未找到 · 待核实':'证据尚未加载',tone:'unknown'}:skillState(item);return <div key={`${item.skill}-${i}`} className="chat-skill-row"><div className="chat-skill-row-head"><span>{item.skill}</span><span className={`skill-state ${state.tone}`}>{state.label}</span></div>{item.evidence?.length?<ul>{item.evidence.map((e,j)=><li key={j}>{e.summary}</li>)}</ul>:<p className="skill-audit-note">{current?'本轮已读取记录尚无对应工具证据。选择 Skill 或读取说明不等于执行成功。':'尚无可确认的本轮记录，先加载核验后再判断。'}</p>}</div>;})}
  </section>,document.body)}
 </div>;
}
