import { useState } from 'react';
import { readChatAutoContinue, saveChatAutoContinue } from '../lib/chatContinuation';

export default function ChatContinuationControls({sessionId, busy, canContinue, onContinue}: {
  sessionId: string; busy: boolean; canContinue: boolean; onContinue: () => void;
}) {
  const [enabled, setEnabled] = useState(() => readChatAutoContinue(sessionId));
  const [error, setError] = useState('');
  return <div className="chat-continuation-controls">
    <label title="发送时生效。确认原轮次结束后，从已有进度自动继续，最多2次；等待确认、手动停止或连接状态不明时暂停。">
      <input type="checkbox" checked={enabled} disabled={busy} onChange={event => {
        const next = event.currentTarget.checked;
        if (saveChatAutoContinue(sessionId, next)) { setEnabled(next); setError(''); }
        else setError('自动继续设置未能保存，请检查浏览器存储。');
      }}/>自动继续<span>最多 2 次</span>
    </label>
    {canContinue && <button type="button" className="btn btn-sm" disabled={busy} onClick={onContinue}>继续未完成任务</button>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
