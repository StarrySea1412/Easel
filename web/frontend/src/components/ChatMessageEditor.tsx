import { useEffect, useRef, useState } from 'react';

export default function ChatMessageEditor({ text, disabled, onCancel, onSend }: {
  text: string; disabled: boolean; onCancel: () => void;
  onSend: (text: string, signal: AbortSignal) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(text);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const request = useRef<AbortController | null>(null);
  const cancel = () => { request.current?.abort(); onCancel(); };
  useEffect(() => {
    input.current?.focus();
    return () => { request.current?.abort(); };
  }, []);
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
  return <div className="chat-message-editor">
    <textarea ref={input} aria-label="重新编辑消息" value={draft} disabled={pending}
      onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); cancel(); }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
      }} />
    <div className="chat-message-edit-actions">
      <button type="button" className="btn btn-sm" onClick={cancel}>取消</button>
      <button type="button" className="btn btn-sm chat-message-edit-send" disabled={pending || disabled || !draft.trim()} onClick={() => void send()}>{pending ? '发送中…' : '发送'}</button>
    </div>
    <p className="chat-message-edit-hint">发送后从这里创建编辑分支，保留原对话。此前可见消息作为上下文；Shift + Enter 换行。</p>
    {disabled && <p className="chat-message-edit-hint" role="status">请等待当前生成和停止处理结束。</p>}
    {error && <p className="chat-message-edit-error" role="alert">{error}</p>}
  </div>;
}
