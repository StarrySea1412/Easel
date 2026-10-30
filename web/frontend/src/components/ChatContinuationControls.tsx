import { useId, useState } from 'react';
import { readChatAutoContinue, saveChatAutoContinue } from '../lib/chatContinuation';
import Switch from './ui/Switch';
import { IconPlay } from './icons';

export default function ChatContinuationControls({sessionId, busy, canContinue, onContinue}: {
  sessionId: string; busy: boolean; canContinue: boolean; onContinue: () => void;
}) {
  const [enabled, setEnabled] = useState(() => readChatAutoContinue(sessionId));
  const [error, setError] = useState('');
  const id = useId();
  return <div className="chat-continuation-controls">
    <div className="chat-continuation-toggle" title="发送时生效，最多自动继续 2 次；等待确认或手动停止时暂停。">
      <Switch id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-limit`} checked={enabled} disabled={busy} onChange={next => {
        if (saveChatAutoContinue(sessionId, next)) { setEnabled(next); setError(''); }
        else setError('自动继续设置未能保存，请检查浏览器存储。');
      }}/><label id={`${id}-label`} htmlFor={id}>自动继续</label><span id={`${id}-limit`} className="chat-continuation-limit">最多 2 次</span>
    </div>
    {canContinue && <button type="button" className="chat-continuation-action" aria-label="继续未完成任务" disabled={busy} onClick={onContinue}><IconPlay size={12}/>继续任务</button>}
    {error && <span className="chat-continuation-error" role="alert">{error}</span>}
  </div>;
}
