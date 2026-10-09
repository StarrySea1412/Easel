import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { displayName } from '../lib/skillDisplayNames';
import { MAX_SKILL_REQUIREMENT_LENGTH } from '../lib/selectedSkills';
import SkillGuidePreview from './SkillGuidePreview';
import '../styles/skill-picker.css';

export default function SelectedSkillChip({skillName,requirement='',requirementScope='conversation',onSaveRequirement,onRemove}:{
  skillName:string;requirement?:string;requirementScope?:'conversation'|'creation';onSaveRequirement:(text:string)=>boolean|void;onRemove:()=>void;
}) {
  const requirementLabel=requirementScope==='creation'?'本次创作补充要求':'本会话补充要求';
  const requirementDescription=requirementScope==='creation'?'随本次创作带入新会话，后续可在会话中继续调整；不修改全局 SKILL.md。':'仅用于此技能在本会话之后发送的消息，不修改全局 SKILL.md。';
  const [open,setOpen]=useState(false),[editing,setEditing]=useState(false),[draft,setDraft]=useState(requirement),[error,setError]=useState('');
  const [position,setPosition]=useState({left:12,top:12,width:420,maxHeight:600});
  const chip=useRef<HTMLSpanElement>(null),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),suppressFocus=useRef(false);
  const id=useId(),label=displayName(skillName);
  const clearTimer=()=>{clearTimeout(timer.current);};
  const close=(restore=false)=>{clearTimer();setOpen(false);setEditing(false);setError('');if(restore){suppressFocus.current=true;trigger.current?.focus({preventScroll:true});suppressFocus.current=false;}};
  const reveal=()=>{clearTimer();if(!suppressFocus.current)setOpen(true);};
  const leave=()=>{clearTimer();if(editing)return;timer.current=setTimeout(()=>{if(!panel.current?.contains(document.activeElement)&&!chip.current?.contains(document.activeElement))setOpen(false);},180);};
  const edit=()=>{clearTimer();if(!editing){setDraft(requirement);setError('');}setOpen(true);setEditing(true);};
  const save=(text:string)=>{
    if(text.length>MAX_SKILL_REQUIREMENT_LENGTH){setError(`补充要求最多 ${MAX_SKILL_REQUIREMENT_LENGTH} 字。`);return;}
    try {if(onSaveRequirement(text.trim())===false){setError('补充要求尚未完成保存，请查看创作框的提示后重试。');return;}close(true);}
    catch(cause){setError(cause instanceof Error?cause.message:'补充要求未保存，请重试。');}
  };
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{const rect=chip.current?.getBoundingClientRect();if(!rect)return;const width=Math.min(440,window.innerWidth-24),height=Math.min(panel.current?.getBoundingClientRect().height||480,window.innerHeight-24);const below=window.innerHeight-rect.bottom-10;setPosition({left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),top:Math.max(12,below>=height?rect.bottom+8:rect.top-height-8),width,maxHeight:window.innerHeight-24});};
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    const observer=typeof window.ResizeObserver==='function'?new window.ResizeObserver(place):null;if(panel.current)observer?.observe(panel.current);
    return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);observer?.disconnect();};
  },[open,editing]);
  useEffect(()=>{if(open&&editing)input.current?.focus({preventScroll:true});},[open,editing]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!panel.current?.contains(event.target as Node)&&!chip.current?.contains(event.target as Node))close();};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[open]);
  return <><span ref={chip} className="composer-skill-chip" data-skill={skillName} onMouseLeave={leave} onBlur={event=>{if(event.relatedTarget&&!chip.current?.contains(event.relatedTarget as Node)&&!panel.current?.contains(event.relatedTarget as Node))close();}}>
    <button type="button" ref={trigger} className="composer-skill-detail-trigger" aria-label={`${label}技能详情与补充要求`} title={`查看技能详情，点击编辑${requirementLabel}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open?id:undefined} onMouseEnter={reveal} onMouseLeave={leave} onFocus={reveal} onClick={edit} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();edit();}}} onBlur={event=>{if(event.relatedTarget&&!chip.current?.contains(event.relatedTarget as Node)&&!panel.current?.contains(event.relatedTarget as Node))close();}}><span>{label}</span>{requirement&&<i className="composer-skill-requirement-dot" title={`已添加${requirementLabel}`} aria-label={`已添加${requirementLabel}`}/>}</button>
    <button type="button" aria-label={`移除技能 ${label}`} onMouseEnter={()=>close()} onFocus={()=>close()} onClick={()=>{close();onRemove();}}>×</button>
  </span>{open&&createPortal(<div ref={panel} id={id} className="selected-skill-popover" role="dialog" aria-label={`${label}技能详情与补充要求`} style={position} onMouseEnter={clearTimer} onMouseLeave={leave} onBlur={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget as Node)&&!chip.current?.contains(event.relatedTarget as Node))close();}}>
    <header><strong>{label}</strong><button type="button" className="icon-btn" aria-label="关闭技能详情" onClick={()=>close(true)}>×</button></header>
    {!editing?<><div className="selected-skill-guide"><SkillGuidePreview skillName={skillName}/></div><section className="selected-skill-requirement"><h4>{requirementLabel}</h4><p>{requirement||'尚未添加补充要求。'}</p><button type="button" className="btn btn-sm" onClick={edit}>编辑补充要求</button></section></>:<section className="selected-skill-requirement selected-skill-requirement-editor"><label htmlFor={`${id}-requirement`}>{requirementLabel}</label><p className="selected-skill-scope">{requirementDescription}</p><textarea ref={input} id={`${id}-requirement`} rows={6} value={draft} maxLength={MAX_SKILL_REQUIREMENT_LENGTH} onChange={event=>{setDraft(event.target.value);setError('');}} placeholder="例如：先列出依据，再给出建议；保持简洁。"/><p className="selected-skill-count">{draft.length} / {MAX_SKILL_REQUIREMENT_LENGTH}</p>{error&&<p className="selected-skill-error" role="alert">{error}</p>}<div className="selected-skill-requirement-actions"><button type="button" className="btn btn-sm" onClick={()=>save('')}>清除补充要求</button><button type="button" className="btn btn-sm" onClick={()=>close(true)}>取消</button><button type="button" className="btn btn-primary btn-sm" disabled={draft.length>MAX_SKILL_REQUIREMENT_LENGTH} onClick={()=>save(draft)}>保存补充要求</button></div></section>}
  </div>,document.body)}</>;
}
