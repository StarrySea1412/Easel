import { useCallback, useId } from 'react';
import { createRoot } from 'react-dom/client';
import { useModalFocus } from '../../hooks/useModalFocus';

type Options = { title?: string; confirmLabel?: string; cancelLabel?: string };
export function ConfirmModal({ message, title = '请确认', confirmLabel = '确定', cancelLabel = '取消', onResult }: Options & { message: string; onResult: (value: boolean) => void }) {
  const close = useCallback(() => onResult(false), [onResult]);
  const ref = useModalFocus(true, close);
  const id = useId();
  return <div className="overlay" onPointerDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} tabIndex={-1} style={{ width: 460 }}>
      <h2 id={`${id}-title`}>{title}</h2>
      <p id={`${id}-body`} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.7, marginTop: 12 }}>{message}</p>
      <div className="modal-actions"><button type="button" className="btn" data-modal-autofocus onClick={close}>{cancelLabel}</button>
        <button type="button" className="btn btn-primary" onClick={() => onResult(true)}>{confirmLabel}</button></div>
    </div>
  </div>;
}
let pending = Promise.resolve();
/** Serialize requests so keyboard focus stays inside one application dialog. */
export function confirmModal(message: string, options: Options = {}): Promise<boolean> {
  const result = pending.then(() => new Promise<boolean>(resolve => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      queueMicrotask(() => { root.unmount(); host.remove(); resolve(value); });
    };
    root.render(<ConfirmModal {...options} message={message} onResult={finish} />);
  }));
  pending = result.then(() => undefined, () => undefined);
  return result;
}
