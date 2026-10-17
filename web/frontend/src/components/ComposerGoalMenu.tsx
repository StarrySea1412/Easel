import {useLayoutEffect,useRef,useState,type RefObject} from 'react';
import {createPortal} from 'react-dom';

export interface ComposerCommandItem { id:string; label:string; hint:string; keys:string }
export default function ComposerGoalMenu({id,anchor,items,selected,onSelect,onChoose}:{id:string;anchor:RefObject<HTMLTextAreaElement|null>;items:ComposerCommandItem[];selected:number;onSelect:(index:number)=>void;onChoose:(id:string)=>void}) {
  const menu=useRef<HTMLDivElement>(null);
  const [position,setPosition]=useState({left:12,top:12,width:300});
  useLayoutEffect(()=>{
    let disposed=false,retries=0;
    // The composer can remount in the same commit that opens this menu (draft or
    // session updates), so anchor.current may still be null here; fall back to the
    // live textarea and retry over the next frames instead of parking at 12,12.
    const resolveAnchor=()=>{
      const current=anchor.current;
      if(current&&current.isConnected)return current;
      const active=document.activeElement;
      if(active instanceof HTMLTextAreaElement&&active.isConnected&&active.classList.contains('chat-input'))return active;
      return document.querySelector<HTMLTextAreaElement>('.chat-page textarea.chat-input');
    };
    const place=()=>{
      if(disposed)return;
      const ta=resolveAnchor();
      const a=ta?.closest('.chat-composer')?.getBoundingClientRect(),m=menu.current;
      if(!a||!m){if(retries<30){retries+=1;requestAnimationFrame(place);}return;}
      // Stay inside the conversation column: never overlap the sidebar or the
      // session list, match the composer width, and drop up when needed.
      const panel=ta?.closest('.chat-page')?.getBoundingClientRect();
      const minLeft=(panel?panel.left:0)+8, maxRight=(panel?panel.right:window.innerWidth)-8;
      const width=Math.min(a.width,Math.max(240,maxRight-minLeft));
      // Measure the height at the target width before positioning: the menu is
      // narrower than the composer on the first pass, and the reflow would
      // otherwise leave an oversized gap above the input.
      m.style.width=`${width}px`;
      const height=m.offsetHeight;
      setPosition({left:Math.max(minLeft,Math.min(a.left,maxRight-width)),top:Math.max(12,a.top-height-8),width});
    };
    place();
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{disposed=true;window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[anchor,items.length]);
  return createPortal(<div ref={menu} id={id} className="composer-command-menu" role="listbox" aria-label="对话命令" style={position}>
    <div className="composer-command-heading">对话命令</div>
    {items.map((item,index)=><button key={item.id} id={`${id}-${item.id}`} type="button" role="option" aria-selected={index===selected} onMouseEnter={()=>onSelect(index)} onMouseDown={e=>e.preventDefault()} onClick={()=>onChoose(item.id)}>
      <span className="goal-symbol" aria-hidden="true">◎</span><span><strong>{item.label}</strong><small>{item.hint}</small></span><kbd>{item.keys}</kbd>
    </button>)}
  </div>,document.body);
}
