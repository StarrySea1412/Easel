import { useEffect, useId, useRef, useState } from 'react';
import type { ChatTurnNode } from '../lib/chatNavigation';

interface ChatTurnNavigationProps {
  nodes: ChatTurnNode[];
  current: number;
  following: boolean;
  onJump: (index: number) => void;
  onLatest: () => void;
}

export default function ChatTurnNavigation({ nodes, current, onJump }: ChatTurnNavigationProps) {
  const [preview, setPreview] = useState<number|null>(null);
  const [previewTop, setPreviewTop] = useState(0);
  const navigation = useRef<HTMLElement>(null);
  const previewId = useId();
  const ticks = useRef<HTMLButtonElement[]>([]);
  const tickRail = useRef<HTMLDivElement>(null);

  const revealTick = (index:number) => {
    const button=ticks.current[index];const rail=tickRail.current;
    if(!button||!rail)return;
    const top=button.getBoundingClientRect().top-rail.getBoundingClientRect().top+rail.scrollTop;
    if(top<rail.scrollTop)rail.scrollTop=top;
    else if(top+button.offsetHeight>rail.scrollTop+rail.clientHeight)rail.scrollTop=top+button.offsetHeight-rail.clientHeight;
  };

  const showPreview = (index:number) => {
    revealTick(index);
    const button=ticks.current[index];
    const bounds=navigation.current?.getBoundingClientRect();
    const area=navigation.current?.parentElement?.getBoundingClientRect();
    if(button&&bounds&&area){
      const min=area.top-bounds.top+8,max=Math.max(min,area.bottom-bounds.top-136);
      setPreviewTop(Math.min(Math.max(min,button.getBoundingClientRect().top-bounds.top-24),max));
    }
    setPreview(index);
  };

  // Streaming updates replace node data, but must keep the hovered preview open.
  const nodeIdentity=nodes.map(node=>node.messageIndex).join(',');
  useEffect(()=>{setPreview(null);},[nodeIdentity]);
  useEffect(()=>{revealTick(current);},[current]);

  const choose = (action: () => void) => {
    action();
    setPreview(null);
  };

  return (
    <nav ref={navigation} className="chat-turn-navigation" aria-label="对话轮次导航">
      <div ref={tickRail} className="chat-turn-ticks" role="group" aria-label="对话轮次刻度" onPointerLeave={()=>{if(!tickRail.current?.contains(document.activeElement))setPreview(null);}} onScroll={()=>setPreview(null)}>
        {nodes.map((node,index)=><button key={node.messageIndex} ref={button=>{if(button)ticks.current[index]=button;}} type="button" className={index===current?'chat-turn-tick is-current':'chat-turn-tick'}
          tabIndex={index===Math.max(0,current)?0:-1} aria-current={index===current?'step':undefined} aria-label={`定位第 ${node.number} 轮：${node.label}`} aria-describedby={preview===index?previewId:undefined}
          onPointerEnter={()=>showPreview(index)} onFocus={()=>showPreview(index)} onBlur={event=>{if(!event.relatedTarget||!navigation.current?.contains(event.relatedTarget as Node))setPreview(null);}}
          onClick={()=>choose(()=>onJump(index))} onKeyDown={event=>{
            let next:number|undefined;
            if(event.key==='ArrowUp'||event.key==='ArrowLeft')next=Math.max(0,index-1);
            if(event.key==='ArrowDown'||event.key==='ArrowRight')next=Math.min(nodes.length-1,index+1);
            if(event.key==='Home')next=0;
            if(event.key==='End')next=nodes.length-1;
            if(event.key==='Escape'){event.preventDefault();setPreview(null);}
            if(next!==undefined){event.preventDefault();ticks.current[next]?.focus({preventScroll:true});showPreview(next);}
          }}><span aria-hidden="true"/></button>)}
      </div>
      {preview!==null&&nodes[preview]&&<div id={previewId} role="tooltip" className="chat-turn-preview" style={{top:previewTop}}><strong>{nodes[preview].label}</strong><p>{nodes[preview].reply || '本轮暂无回复'}</p></div>}

    </nav>
  );
}
