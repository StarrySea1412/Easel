import { useState } from 'react';
import type { ChatSession, StreamState } from '../lib/store';
import UsagePanel from './UsagePanel';
import SkillAuditPanel from './SkillAuditPanel';
import '../styles/activity.css';

type Tab = 'usage' | 'audit';
export default function ActivityPage({ sessions, activeSessionId, streams, target }: {
 sessions:ChatSession[];activeSessionId:string|null;streams:Record<string,StreamState>;
 target?:{sessionId:string;turnId:string};
}) {
 const [tab,setTab]=useState<Tab>(target?'audit':'usage');
 const [selectedId,setSelectedId]=useState(target?.sessionId||activeSessionId||'');
 const [search,setSearch]=useState('');
 const [filter,setFilter]=useState<'all'|'running'|'archived'>('all');
 const session=sessions.find(s=>s.id===selectedId)||sessions.find(s=>s.id===activeSessionId)||sessions[0];
 const visible=sessions.filter(s=>s.title.toLowerCase().includes(search.trim().toLowerCase())&&(filter==='all'||filter==='running'&&!!streams[s.id]||filter==='archived'&&s.archived));
 const titles=Object.fromEntries(sessions.map(s=>[s.id,s.title]));
 return <div className="activity-page"><div className="activity-workspace"><header className="activity-heading"><div><p className="activity-kicker">ACTIVITY / 运行观测</p><h1>运行记录</h1><p>看清用量，回到调用证据，定位需要关注的运行。</p></div><span className="activity-live-count">{Object.keys(streams).length} 个会话正在运行</span></header><div className="activity-layout"><aside className="activity-session-list" aria-label="运行会话筛选"><div className="activity-list-heading"><h2>会话</h2><span>{sessions.length}</span></div><label className="activity-search">搜索会话<input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="按会话标题查找"/></label><div className="activity-filters" role="group" aria-label="会话状态">{(['all','running','archived'] as const).map(f=><button key={f} aria-pressed={filter===f} onClick={()=>setFilter(f)}>{{all:'全部',running:'运行中',archived:'已归档'}[f]}</button>)}</div><div className="activity-session-rows">{visible.map(s=><button key={s.id} className={session?.id===s.id?'selected':''} aria-pressed={session?.id===s.id} onClick={()=>setSelectedId(s.id)}><strong>{s.title}</strong><span>{streams[s.id]?'运行中':s.archived?'已归档':'已保存'} · {s.messages.filter(m=>m.role==='user').length} 轮对话</span></button>)}{!visible.length&&<p className="usage-empty">没有匹配会话，请调整筛选。</p>}</div></aside><main className="activity-detail"><div className="activity-detail-heading"><div><p className="activity-kicker">SELECTED SESSION</p><h2>{session?.title||'还没有会话记录'}</h2><p>模型用量与 Skill 执行证据分开核验。</p></div>{session&&<span className="activity-session-state">{streams[session.id]?'运行中':'历史记录'}</span>}</div><div className="activity-section-tabs" role="tablist" aria-label="运行记录分类" onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?'usage':e.key==='End'?'audit':tab==='usage'?'audit':'usage';setTab(next);document.getElementById(`activity-tab-${next}`)?.focus();}}>{(['usage','audit'] as const).map(t=><button role="tab" key={t} id={`activity-tab-${t}`} aria-selected={tab===t} tabIndex={tab===t?0:-1} aria-controls={`activity-panel-${t}`} onClick={()=>setTab(t)}>{t==='usage'?'用量与调用明细':'Skill 执行核验'}</button>)}</div><div id={`activity-panel-${tab}`} role="tabpanel" aria-labelledby={`activity-tab-${tab}`}>{session?tab==='usage'?<UsagePanel key={session.id} sessionId={session.id} refreshKey={session.messages.length} isStreaming={!!streams[session.id]} embedded sessionTitles={titles}/>:<SkillAuditPanel sessionId={session.id} refreshKey={session.messages.length} isStreaming={!!streams[session.id]} embedded targetTurnId={target?.sessionId===session.id?target.turnId:undefined}/>:<div className="activity-start"><h3>从第一轮对话开始</h3><p>完成对话后，这里会展示服务实际记录的 Token 与执行证据。未上报数据不会替换成 0。</p></div>}</div></main></div></div></div>;
}
