import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatSession } from '../lib/store';
import { IconEdit, IconArchive, IconUnarchive, IconTrash } from './icons';

export function SessionPinIcon({ unpin = false }: { unpin?: boolean }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m16 3 5 5-4 2-3 5-5-5 5-3 2-4ZM9 15l-6 6" />
    {unpin && <path d="m3 3 18 18" />}
  </svg>;
}

interface Props {
  session: ChatSession;
  onPin: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

export default function SessionActionsMenu({ session, onPin, onRename, onArchive, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 176 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (restore = false) => {
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(176, window.innerWidth - 24);
      const height = panel.current?.getBoundingClientRect().height || 164;
      const below = rect.bottom + 4;
      setPosition({ width, left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(below + height <= window.innerHeight - 12 ? below : rect.top - height - 4, window.innerHeight - height - 12)) });
    };
    place();
    panel.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const action = (callback: () => void) => { close(true); callback(); };
  return <>
    <button ref={trigger} type="button" className="session-menu-trigger" aria-label={`对话操作：${session.title}`} title="对话操作"
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={event => { event.stopPropagation(); setOpen(value => !value); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
    </button>
    {open && createPortal(<div ref={panel} id={id} role="menu" aria-label={`对话操作：${session.title}`} className="session-menu" style={position}
      onClick={event => event.stopPropagation()} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) close(); }}
      onKeyDown={event => {
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') || []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === 'Tab') close(true);
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
      {!session.archived && <button type="button" role="menuitem" onClick={() => action(onPin)}><SessionPinIcon unpin={!!session.pinnedAt}/><span>{session.pinnedAt ? '取消置顶' : '置顶'}</span></button>}
      <button type="button" role="menuitem" onClick={() => action(onRename)}><IconEdit size={14}/><span>重命名</span></button>
      <button type="button" role="menuitem" onClick={() => action(onArchive)}>{session.archived ? <IconUnarchive size={14}/> : <IconArchive size={14}/>}<span>{session.archived ? '取消归档' : '归档'}</span></button>
      <div className="session-menu-divider" role="separator"/>
      <button type="button" role="menuitem" className="danger" onClick={() => action(onDelete)}><IconTrash size={14}/><span>删除</span></button>
    </div>, document.body)}
  </>;
}
