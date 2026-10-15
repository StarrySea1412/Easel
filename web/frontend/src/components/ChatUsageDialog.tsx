import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import UsagePanel from './UsagePanel';
import '../styles/event-notifications.css';

export default function ChatUsageDialog({ sessionId, refreshKey, streaming, engine = 'openclaw', open: controlledOpen, onOpenChange, returnFocusRef }: {
  sessionId: string; refreshKey: number; streaming: boolean; engine?: 'openclaw' | 'codex';
  open?: boolean; onOpenChange?: (value: boolean) => void; returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback((value: boolean) => { if (onOpenChange) onOpenChange(value); else setInternalOpen(value); }, [onOpenChange]);
  const dialog = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const scopeId = useId();
  useEffect(() => setOpen(false), [sessionId, engine, setOpen]);
  useEffect(() => {
    if (!open) return;
    const trigger = returnFocusRef?.current || button.current;
    dialog.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setOpen(false); }
      if (event.key !== 'Tab') return;
      const candidates = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]');
      const nodes = Array.from(candidates || []).filter(node => {
        if (node.closest('[hidden],[inert]') || node.tabIndex < 0) return false;
        // Controls inside a collapsed details element are not keyboard targets.
        for (let parent = node.parentElement; parent && parent !== dialog.current; parent = parent.parentElement) {
          if (parent.tagName === 'DETAILS' && !parent.hasAttribute('open')) {
            const summary = parent.querySelector(':scope > summary');
            if (!summary?.contains(node)) return false;
          }
        }
        return true;
      });
      const first = nodes[0], last = nodes.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); trigger?.focus(); };
  }, [open, returnFocusRef, setOpen]);
  return <>{controlledOpen === undefined && <button ref={button} type="button" className="chat-new-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>消耗细则</button>}
    {open && createPortal(<div className="drawer-overlay" onClick={() => setOpen(false)}><div ref={dialog} className="drawer chat-usage-dialog"
      role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={scopeId} tabIndex={-1} onClick={event => event.stopPropagation()}>
      <header className="drawer-header"><div><strong id={titleId}>消耗与费用明细</strong><p className="usage-dialog-subtitle">累计调用、缓存、推理和费用 · 与当前上下文容量分别统计</p></div><button type="button" className="icon-btn" aria-label="关闭消耗细则" onClick={() => setOpen(false)}>×</button></header>
      <div className="drawer-body">
        <p id={scopeId} className="chat-usage-scope">{engine === 'codex'
          ? 'Codex 引擎尚未接入此用量账本，当前无法显示其 Token 和费用。未提供数据不代表没有消耗。'
          : '仅统计本项目 OpenClaw 对话已上报的用量。未上报字段保持未知；记录费用和渠道估算均不代表服务商账单。'}</p>
        {engine === 'openclaw' && <UsagePanel sessionId={sessionId} refreshKey={refreshKey} isStreaming={streaming} embedded />}
      </div>
    </div></div>, document.body)}
  </>;
}
