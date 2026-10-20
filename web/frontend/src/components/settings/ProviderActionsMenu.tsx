import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPanel } from '../../hooks/useAnchoredPanel';
import { IconTrash } from '../icons';

export default function ProviderActionsMenu({ title, disabled, onDelete }: { title: string; disabled?: boolean; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const id = useId(), visible = open && !disabled;
  const close = useCallback(() => setOpen(false), []);
  const position = useAnchoredPanel(visible, close, trigger, panel, 'above', 180);
  useEffect(() => { if (visible) panel.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus(); }, [visible]);
  return <>
    <button ref={trigger} type="button" className="adv-btn provider-more-trigger" disabled={disabled}
      aria-label={`供应商更多操作：${title}`} title="更多操作" aria-haspopup="menu" aria-expanded={visible} aria-controls={visible ? id : undefined}
      onClick={() => setOpen(value => !value)} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
      }}><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>
    {visible && createPortal(<div ref={panel} id={id} role="menu" tabIndex={-1} aria-label={`供应商操作：${title}`} className="provider-actions-menu" style={position}
      onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); panel.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus(); }
        if (event.key === 'Tab') close();
      }}>
      <button type="button" role="menuitem" onClick={() => {
        const list = trigger.current?.closest('.provider-list');
        const index = [...(list?.querySelectorAll('.provider-more-trigger') || [])].indexOf(trigger.current!);
        close(); onDelete();
        window.requestAnimationFrame(() => {
          const remaining = list?.querySelectorAll<HTMLButtonElement>('.provider-more-trigger');
          (remaining?.[Math.min(index, remaining.length - 1)] || document.querySelector<HTMLButtonElement>('.model-add-provider'))?.focus();
        });
      }}><IconTrash size={15}/><span>删除供应商<small>保存后生效</small></span></button>
    </div>, document.body)}
  </>;
}
