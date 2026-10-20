import { useCallback, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from '../hooks/useModalFocus';
import Select from './ui/Select';
import '../styles/chat-message-settings.css';

export type MessageSettingsActions = {
  quote: (text: string, target: string) => void;
  targets: { value: string; label: string }[];
  goal: (text: string, mode: 'new' | 'append' | 'replace') => void;
  hasGoal: boolean;
  goalBlocked: boolean;
};

function SettingsDialog({ text, actions, onClose }: { text: string; actions: MessageSettingsActions; onClose: () => void }) {
  const ref = useModalFocus(true, onClose);
  const id = useId();
  const [target, setTarget] = useState('current');
  const quote = () => { actions.quote(text, target); onClose(); };
  const goal = (mode: 'new' | 'append' | 'replace') => { actions.goal(text, mode); onClose(); };
  return createPortal(<div className="overlay" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className="modal chat-message-settings" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
      <header><h2 id={id}>对话操作</h2><button type="button" className="icon-btn" aria-label="关闭对话操作" onClick={onClose}>×</button></header>
      <blockquote>{text}</blockquote>
      <section><h3>引用对话</h3><Select aria-label="引用到哪个对话" value={target} onChange={setTarget} options={[{ value: 'current', label: '当前对话' }, ...actions.targets]} />
        <button type="button" className="btn" onClick={quote}>引用到输入框</button></section>
      <section><h3>目标</h3><p>先放入目标编辑框，确认后再保存或开始。</p>
        <div className="modal-choice-row">{actions.hasGoal ? <><button type="button" className="btn" disabled={actions.goalBlocked} onClick={() => goal('append')}>追加到当前目标</button>
          <button type="button" className="btn" disabled={actions.goalBlocked} onClick={() => goal('replace')}>替换当前目标</button></>
          : <button type="button" className="btn" disabled={actions.goalBlocked} onClick={() => goal('new')}>新增目标</button>}</div>
        {actions.goalBlocked && <p role="status">请先暂停并等待当前执行结束，再编辑目标。</p>}</section>
    </div>
  </div>, document.body);
}

export default function ChatMessageSettings({ text, actions, onDismiss }: { text: string; actions: MessageSettingsActions; onDismiss?: () => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => { setOpen(false); onDismiss?.(); }, [onDismiss]);
  return <><button type="button" className="msg-action" aria-label="对话操作" title="引用到对话、追加或替换目标" onClick={() => setOpen(true)}>•••<span>设置</span></button>
    {open && <SettingsDialog text={text} actions={actions} onClose={close} />}</>;
}
