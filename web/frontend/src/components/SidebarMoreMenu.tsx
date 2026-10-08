import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Page } from './Sidebar';
import { IconSkills, IconOutputs, IconChart, IconHistory, IconProfile } from './icons';
import '../styles/sidebar-more-menu.css';

const ITEMS = [
  {page:'skills',label:'技能库',Icon:IconSkills},
  {page:'outputs',label:'内容库',Icon:IconOutputs},
  {page:'analysis',label:'内容分析',Icon:IconChart},
  {page:'activity',label:'运行记录',Icon:IconHistory},
  {page:'profile',label:'画像',Icon:IconProfile},
] as const;

export default function SidebarMoreMenu({currentPage,onNavigate}:{currentPage:Page;onNavigate:(page:Page)=>void}) {
  const [open,setOpen]=useState(false);
  const [position,setPosition]=useState({top:0,left:60,width:220});
  const trigger=useRef<HTMLButtonElement>(null);
  const panel=useRef<HTMLDivElement>(null);
  const id=useId();
  const close=(restore=false)=>{setOpen(false);if(restore)trigger.current?.focus({preventScroll:true});};
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{const rect=trigger.current?.getBoundingClientRect();if(!rect)return;const width=Math.min(220,window.innerWidth-24);const height=panel.current?.getBoundingClientRect().height||250;setPosition({left:Math.max(12,Math.min(rect.right+10,window.innerWidth-width-12)),top:Math.max(12,Math.min(rect.top,window.innerHeight-height-12)),width});};
    place();panel.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[open]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!panel.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))close();};
    document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  const active=ITEMS.some(item=>item.page===currentPage);
  return <>
    <button type="button" ref={trigger} className={`nav-item sidebar-more-trigger${active?' active':''}`} aria-label="更多" title="更多" aria-haspopup="menu" aria-expanded={open} aria-controls={open?id:undefined} onClick={()=>setOpen(value=>!value)} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowRight'){event.preventDefault();setOpen(true);}}}>
      <span className="nav-icon" aria-hidden="true"><svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></span><span className="nav-item-label">更多</span>
    </button>
    {open&&createPortal(<div ref={panel} id={id} role="menu" aria-label="更多工作区" className="sidebar-more-menu" style={position} onBlur={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget as Node)&&event.relatedTarget!==trigger.current)close();}} onKeyDown={event=>{
      const buttons=Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]')||[]);
      const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}
      else if(event.key==='Tab'){close(true);}
      else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();}
    }}>
      <p>更多工作区</p>{ITEMS.map(({page,label,Icon})=><button key={page} type="button" role="menuitem" className={currentPage===page?'active':''} aria-current={currentPage===page?'page':undefined} onClick={()=>{close(true);onNavigate(page);}}><Icon size={17}/><span>{label}</span></button>)}
    </div>,document.body)}
  </>;
}
