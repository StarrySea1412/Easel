import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatSession } from '../lib/store';
import { fetchSkillRecords, skillState, type LiveSkillAudit } from '../lib/skillEvidence';
import { displayName } from '../lib/skillDisplayNames';

export default function SessionHoverCard({ session, anchor }: { session: ChatSession; anchor: HTMLElement }) {
  const [records, setRecords] = useState<LiveSkillAudit[]>([]), [status, setStatus] = useState('读取技能记录…');
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const card = useRef<HTMLDivElement>(null), id = useId();
  const selected = [...new Set(session.messages.flatMap(message => message.selectedSkills || []))];
  // Records arrive newest first. Keep the most recent evidence for each skill.
  const invocations = records.flatMap(record => Array.isArray(record.invocation) ? record.invocation : [])
    .filter(item => item && typeof item.skill === 'string' && typeof item.status === 'string');
  const invoked = invocations.filter((item, index) => invocations.findIndex(value => value.skill === item.skill) === index);
  const selectedOnly = selected.filter(skill => !invoked.some(item => item.skill === skill));
  useEffect(() => {
    const controller = new AbortController(); setRecords([]); setStatus('读取技能记录…');
    if (session.importedFromBackup) { setStatus('备份未包含技能执行记录'); return; }
    let timeout: ReturnType<typeof setTimeout>;
    const timer = setTimeout(() => {
      timeout = setTimeout(() => { setStatus('技能记录读取超时'); controller.abort(); }, 10000);
      fetchSkillRecords(session.id, undefined, controller.signal).then(value => { if (!controller.signal.aborted) { setRecords(value); setStatus(value.some(record => Array.isArray(record.invocation) && record.invocation.length) ? '' : '暂无技能执行记录'); } })
        .catch(() => { if (!controller.signal.aborted) setStatus('技能执行记录暂不可读'); })
        .finally(() => clearTimeout(timeout));
    }, 180);
    return () => { clearTimeout(timer); clearTimeout(timeout); controller.abort(); };
  }, [session.id, session.importedFromBackup]);
  useLayoutEffect(() => {
    const place = () => {
      const rect=(anchor.closest('.session-item') || anchor).getBoundingClientRect(), width=card.current?.offsetWidth || 300, height=card.current?.offsetHeight || 110;
      const right=rect.right+10;
      const fitsBeside=right+width<=window.innerWidth-12;
      // In a narrow viewport, put the preview below the row so it cannot cover
      // that row's pin or actions buttons.
      const top=fitsBeside?rect.top:(rect.bottom+height+8<=window.innerHeight-12?rect.bottom+8:rect.top-height-8);
      setPosition({left:Math.max(12,Math.min(right,window.innerWidth-width-12)),top:Math.max(12,Math.min(top,window.innerHeight-height-12))});
    };
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return ()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  }, [anchor, records, status]);
  useEffect(()=>{anchor.setAttribute('aria-describedby',id);return()=>anchor.removeAttribute('aria-describedby');},[anchor,id]);
  return createPortal(<div ref={card} id={id} role="tooltip" className="session-hover-card" style={position}>
    <div className="session-hover-heading"><strong>{session.title}</strong><time>{new Date(session.created).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'})}</time></div>
    {invoked.length>0 && <div className="session-hover-skills"><span>最近技能记录</span>{invoked.slice(0,4).map(item=><span key={item.skill} className="session-hover-skill" data-state={skillState(item).tone}>{displayName(item.skill)}<small>{skillState(item).label}</small></span>)}{invoked.length>4&&<small>另 {invoked.length-4} 项</small>}</div>}
    {selectedOnly.length>0 && <div className="session-hover-skills"><span>已选择</span>{selectedOnly.slice(0,4).map(skill=><span key={skill} className="session-hover-skill">{displayName(skill)}</span>)}{selectedOnly.length>4&&<small>另 {selectedOnly.length-4} 项</small>}</div>}
    {status && <p>{status}</p>}
    <p>{session.pinnedAt?'已置顶':'未置顶'} · {session.messages.filter(message=>message.role==='user').length} 轮对话</p>
  </div>,document.body);
}
