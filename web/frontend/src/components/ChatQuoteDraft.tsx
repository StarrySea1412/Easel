import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { removeChatDraftQuote } from '../lib/chatDrafts';
import InlineInfo from './InlineInfo';

export default function ChatQuoteDraft({ sessionId, quotes, comment }: { sessionId: string; quotes: string[]; comment: string }) {
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 12, top: 12, width: 360, maxHeight: 400 });
  const id = useId();
  const open = openFor === sessionId && quotes.length > 0;
  const close = useCallback((restoreFocus = false) => {
    setOpenFor(null);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => setOpenFor(null), [sessionId]);
  useEffect(() => { if (!quotes.length) setOpenFor(null); }, [quotes.length]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), content = panel.current;
      if (!anchor || !content) return;
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft || 0, y = viewport?.offsetTop || 0;
      const width = Math.max(0, Math.min(360, (viewport?.width || window.innerWidth) - 24));
      const bottom = y + (viewport?.height || window.innerHeight) - 12;
      const right = x + (viewport?.width || window.innerWidth) - 12;
      const above = Math.max(0, anchor.top - y - 20), below = Math.max(0, bottom - anchor.bottom - 8);
      const upwards = above >= below, available = upwards ? above : below;
      const maxHeight = Math.min(400, available >= 100 ? available : Math.max(0, bottom - y - 12));
      // Measure after wrapping at the final width, outside every scrolling ancestor.
      content.style.width = width + 'px'; content.style.maxHeight = maxHeight + 'px';
      const height = content.getBoundingClientRect().height;
      const next = { width, maxHeight,
        left: Math.max(x + 12, Math.min(anchor.left, right - width)),
        top: available < 100 ? y + 12 : Math.max(y + 12, Math.min(upwards ? anchor.top - height - 8 : anchor.bottom + 8, bottom - height)) };
      setPosition(previous => Object.keys(next).every(key => previous[key as keyof typeof previous] === next[key as keyof typeof next]) ? previous : next);
    };
    place();
    if (focusOnOpen.current) { panel.current?.focus({ preventScroll: true }); focusOnOpen.current = false; }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (trigger.current) observer?.observe(trigger.current);
    if (panel.current) observer?.observe(panel.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open, quotes, comment]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    };
    const navigate = () => close();
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    window.addEventListener('easel:page-navigation', navigate);
    return () => {
      document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape);
      window.removeEventListener('easel:page-navigation', navigate);
    };
  }, [open, close]);
  if (!quotes.length) return null;
  return <div className="composer-quote-row"><div className="composer-quote-details">
    <button ref={trigger} type="button" className="composer-quote-trigger" aria-label={'查看 ' + quotes.length + ' 条引用'} aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={event => {
        focusOnOpen.current = !open && event.detail === 0;
        setOpenFor(open ? null : sessionId);
      }} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); focusOnOpen.current = !open; setOpenFor(sessionId); if (open) panel.current?.focus({ preventScroll: true }); }
      }}>▤ {quotes.length} 条引用</button>
    {open && createPortal(<div ref={panel} id={id} className="composer-quote-panel" role="region" aria-label="引用内容与评论" tabIndex={-1} style={position}>
      <div className="composer-quote-title"><strong>引用内容</strong><button type="button" aria-label="关闭引用预览" onClick={() => close(true)}>×</button></div>
      <div className="composer-quote-body">
        {quotes.map((text, index) => <section key={index}><div className="composer-quote-heading"><span>{index + 1} · 所选文本</span><button type="button" aria-label={'移除引用 ' + (index + 1)} onClick={() => { removeChatDraftQuote(sessionId, index); if (quotes.length === 1) close(); }}>×</button></div><blockquote>{text}</blockquote></section>)}
        {comment.trim() && <div className="composer-quote-comment"><span>你的评论</span><p>{comment}</p></div>}
      </div>
    </div>, document.body)}
  </div><InlineInfo label="引用使用说明" hover onShow={() => close()}>在主输入框补充评论。发送时会携带引用原文与评论；添加引用不会自动发送。</InlineInfo></div>;
}
