import { useId, useState } from 'react';
import { IconCheck, IconInfo } from './icons';
import { fetchSkillRecords, skillState, type LiveSkillAudit } from '../lib/skillEvidence';
import '../styles/skill-audit.css';
export default function ChatSkillEvidence({record,selectedSkills=[],streaming,onOpen,error,sessionId,turnId}: {record?:LiveSkillAudit;selectedSkills?:string[];streaming:boolean;onOpen?:()=>void;error?:string;sessionId:string;turnId:string}) {
 const [loaded,setLoaded]=useState(false),[loading,setLoading]=useState(false),[ownRecord,setOwnRecord]=useState<LiveSkillAudit>(),[loadError,setLoadError]=useState('');
 const [expanded,setExpanded]=useState(false);
 const tooltipId=useId();
 const current=record||ownRecord;
 const items=current?.invocation||[];
 const visible=[...items,...selectedSkills.filter(name=>!items.some(item=>item.skill===name)).map(skill=>({skill,status:current?'not_observed':'not_loaded',evidence:[]}))];
 const load=async()=>{if(loading)return;setLoading(true);setLoadError('');try{const records=await fetchSkillRecords(sessionId,turnId);setOwnRecord(records[0]);setLoaded(true);}catch(e){setLoadError(e instanceof Error?e.message:'本轮核验读取失败');}finally{setLoading(false);}};
 if(!visible.length&&!streaming&&current)return null;
 const states=visible.map(item=>skillState(item));
 const tone=(error||loadError||states.some(state=>state.tone==='error'))?'error':states.length&&states.every(state=>state.tone==='success')?'success':streaming?'pending':'unknown';
 const label=error||loadError||states.map((state,index)=>`${visible[index].skill}：${state.label}`).join('；')||'尚无执行证据';
 return <div className="chat-skill-compact"><button type="button" className={`chat-skill-status-icon ${tone}`} aria-label={`Skill核验：${label}`} aria-describedby={tooltipId} aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{tone==='success'?<IconCheck size={15}/>:<IconInfo size={15}/>}<span id={tooltipId} className="chat-skill-tooltip" role="tooltip">Skill核验：{label}</span></button>{expanded&&<section className="chat-skill-evidence" aria-label="本轮 Skill 核验"><div className="chat-skill-heading"><strong>Skill 核验</strong><span>{streaming?'执行中 · 持续核对证据':'本轮执行记录'}</span>{onOpen&&<button className="link-btn" onClick={onOpen}>查看运行记录 →</button>}</div>{(error||loadError)&&<p className="skill-audit-error">{loadError||error}；已有证据保留。</p>}{!current&&<p className="skill-audit-note">{loaded?'未找到本轮持久核验记录，无法确认执行情况。':streaming?'正在等待本轮核验记录，尚未取得证据。':'本轮核验尚未加载；近期列表没有包含它，不代表没有执行。'} <button className="link-btn" disabled={loading} onClick={()=>void load()}>{loading?'读取中…':loaded?'重新读取':'加载本轮核验'}</button></p>}{current&&!visible.length&&<p className="skill-audit-note">本轮记录中尚未观察到 Skill 调用证据。</p>}{visible.map((item,i)=>{const state=item.status==='not_loaded'?{label:loaded?'记录未找到 · 待核实':'证据尚未加载',tone:'unknown'}:skillState(item);return <details key={`${item.skill}-${i}`} className="chat-skill-row"><summary><span>{item.skill}</span><span className={`skill-state ${state.tone}`}>{state.label}</span></summary>{item.evidence?.length?<ul>{item.evidence.map((e,j)=><li key={j}>{e.summary}</li>)}</ul>:<p className="skill-audit-note">{current?'本轮已读取记录尚无对应工具证据。选择 Skill 或读取说明不等于执行成功。':'尚无可确认的本轮记录，先加载核验后再判断。'}</p>}</details>;})}</section>}</div>;
}
