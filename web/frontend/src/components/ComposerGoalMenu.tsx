import {useLayoutEffect,useRef,useState,type RefObject} from 'react';
import {createPortal} from 'react-dom';

export interface ComposerCommandItem { id:string; label:string; hint:string; keys:string }
export default function ComposerGoalMenu({id,anchor,items,selected,onSelect,onChoose}:{id:string;anchor:RefObject<HTMLTextAreaElement|null>;items:ComposerCommandItem[];selected:number;onSelect:(index:number)=>void;onChoose:(id:string)=>void}) {
  const menu=useRef<HTMLDivElement>(null);
  const [position,setPosition]=useState({left:12,top:12,width:300});
  useLayoutEffect(()=>{
    const place=()=>{const a=anchor.current?.closest('.chat-composer')?.getBoundingClientRect(),m=menu.current;if(!a||!m)return;
      const width=Math.min(a.width,window.innerWidth-24);
      setPosition({left:Math.max(12,Math.min(a.left,window.innerWidth-width-12)),top:Math.max(12,a.top-m.offsetHeight-8),width});};
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[anchor,items.length]);
  return createPortal(<div ref={menu} id={id} className="composer-command-menu" role="listbox" aria-label="对话命令" style={position}>
    <div className="composer-command-heading">对话命令</div>
    {items.map((item,index)=><button key={item.id} id={`${id}-${item.id}`} type="button" role="option" aria-selected={index===selected} onMouseEnter={()=>onSelect(index)} onMouseDown={e=>e.preventDefault()} onClick={()=>onChoose(item.id)}>
      <span className="goal-symbol" aria-hidden="true">◎</span><span><strong>{item.label}</strong><small>{item.hint}</small></span><kbd>{item.keys}</kbd>
    </button>)}
  </div>,document.body);
}
