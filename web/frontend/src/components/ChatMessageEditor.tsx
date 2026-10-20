import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import '../styles/chat-editing.css';

export default function ChatMessageEditor({ text, disabled, onCancel, onSend }: {
  text: string; disabled: boolean; onCancel: () => void;
  onSend: (text: string, signal: AbortSignal) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(text);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const request = useRef<AbortController | null>(null);
  const cancel = () => { request.current?.abort(); onCancel(); };
  useEffect(() => {
    input.current?.focus();
    return () => { request.current?.abort(); };
  }, []);
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    const resize = () => { field.style.height = '0px'; field.style.height = `${field.scrollHeight}px`; };
    resize();
    let width = field.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = field.getBoundingClientRect().width;
      if (nextWidth !== width) { width = nextWidth; resize(); }
    });
    observer.observe(field);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [draft]);
  const send = async () => {
    if (!draft.trim() || disabled || request.current) return;
    const controller = new AbortController();
    request.current = controller; setPending(true); setError('');
    try {
      const accepted = await onSend(draft, controller.signal);
      if (!controller.signal.aborted && !accepted) setError('本次未发送，请重试。');
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '编辑发送失败，请重试。');
    } finally {
      if (!controller.signal.aborted) { request.current = null; setPending(false); }
    }
  };
  return <div className="chat-message-editor" role="group" aria-label="编辑消息" aria-busy={pending}>
    <div className="chat-message-edit-heading">编辑消息</div>
    <textarea ref={input} aria-label="重新编辑消息" aria-describedby={hintId} title="Enter 发送，Shift + Enter 换行，Esc 取消" rows={3} value={draft} disabled={pending}
      onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); cancel(); }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
      }} />
    <div className="chat-message-edit-footer">
      <p id={hintId} className="chat-message-edit-hint">发送后创建分支，原对话保留。</p>
      <div className="chat-message-edit-actions">
      <button type="button" className="btn btn-sm" onClick={cancel}>取消</button>
      <button type="button" className="btn btn-sm chat-message-edit-send" disabled={pending || disabled || !draft.trim()} onClick={() => void send()}>{pending ? '发送中…' : '发送'}</button>
      </div>
    </div>
    {disabled && <p className="chat-message-edit-hint" role="status">请等待当前生成和停止处理结束。</p>}
    {error && <p className="chat-message-edit-error" role="alert">{error}</p>}
  </div>;
}
