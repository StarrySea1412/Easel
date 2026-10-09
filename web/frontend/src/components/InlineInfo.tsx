import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconInfo } from './icons';
import '../styles/inline-info.css';

export default function InlineInfo({ label, children, hover = false, onShow }: { label: string; children: React.ReactNode; hover?: boolean; onShow?: () => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const trigger = useRef<HTMLButtonElement>(null), tip = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!hover || !open) return;
    const place = () => {
      const anchor = trigger.current!.getBoundingClientRect(), height = tip.current?.offsetHeight || 90;
      const width = tip.current?.offsetWidth || 210;
      setPosition({left:Math.max(12,Math.min(anchor.left,window.innerWidth-width-12)),top:Math.max(12,Math.min(anchor.top-height-8,window.innerHeight-height-12))});
    };
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return () => {window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[hover,open]);
  const show = () => { onShow?.(); setOpen(true); };
  if (hover) return <span className="inline-info is-hover">
    <button ref={trigger} type="button" aria-label={label} aria-describedby={open ? id : undefined}
      onPointerEnter={event => {if(event.pointerType !== 'touch')show();}} onPointerLeave={() => setOpen(false)}
      onFocus={show} onBlur={() => setOpen(false)} onKeyDown={event => {if(event.key === 'Escape'){event.preventDefault();event.stopPropagation();setOpen(false);}}}><IconInfo size={13}/></button>
    {open && createPortal(<div ref={tip} id={id} className="inline-info-content inline-info-tooltip" role="tooltip" style={position}>{children}</div>,document.body)}
  </span>;
  return <details className="inline-info"><summary aria-label={label} title={label}><IconInfo size={13}/></summary>
    <div className="inline-info-content" role="note">{children}</div>
  </details>;
}
