import { useState, useSyncExternalStore } from 'react';
import { getChatQueue, subscribeChatQueue, removeQueuedMessage, updateQueuedMessage, moveQueuedMessage, resumeChatQueue, pauseChatQueue, attachQueuedFiles } from '../lib/chatQueue';
import { uploadFiles } from '../lib/api';

export default function ChatQueueTray({ sessionId }: { sessionId: string }) {
  const queue = useSyncExternalStore(subscribeChatQueue, () => getChatQueue(sessionId));
  const [editing, setEditing] = useState<string | null>(null), [text, setText] = useState(''), [error, setError] = useState('');
  const [uploading, setUploading] = useState<string | null>(null);
  const commit = (accepted: boolean) => { setError(accepted ? '' : '更改未保存，请检查浏览器存储或输入内容。'); return accepted; };
  if (!queue.items.length && !queue.error) return null;
  return <section className="chat-queue" aria-label="待发送消息">
    <div className="chat-queue-header"><span>待发送 · {queue.items.length}</span>
      <button type="button" onClick={() => queue.paused ? commit(resumeChatQueue(sessionId)) : pauseChatQueue(sessionId)}
        disabled={queue.paused && queue.items.some(item => item.missingAttachments.length)}>{queue.paused ? '继续发送' : '暂停队列'}</button>
      <span className="chat-queue-info" tabIndex={0} title="当前版本暂不支持将新指令注入正在运行的轮次。队列在本轮完成后逐条发送；失败或停止会暂停，刷新后需确认继续。" aria-label="队列与当前轮次引导说明">ⓘ</span>
    </div>
    <ol>{queue.items.map((item, index) => <li key={item.id}>
      <span className="chat-queue-index">{index + 1}</span>
      {editing === item.id ? <form onSubmit={event => { event.preventDefault(); if (commit(updateQueuedMessage(sessionId, item.id, text))) setEditing(null); }}>
        <textarea aria-label="编辑待发送消息" value={text} onChange={event => setText(event.target.value)} maxLength={20000} />
        <button type="submit">保存</button><button type="button" onClick={() => setEditing(null)}>取消</button>
      </form> : <button type="button" className="chat-queue-text" title={item.text || '素材消息'} onClick={() => { pauseChatQueue(sessionId); setEditing(item.id); setText(item.text); }}>{item.text || '素材消息'}{(item.attachments.length > 0 || item.missingAttachments.length > 0) && <small> · {item.attachments.length + item.missingAttachments.length} 份素材{item.missingAttachments.length > 0 ? '需重新添加' : ''}</small>}</button>}
      <div className="chat-queue-actions">
        {item.missingAttachments.length > 0 && <label className="chat-queue-reattach">{uploading === item.id ? '添加中…' : '补素材'}<input type="file" multiple hidden disabled={Boolean(uploading)} onChange={async event => {
          const files = Array.from(event.target.files || []); event.target.value = ''; if (!files.length) return;
          setUploading(item.id); pauseChatQueue(sessionId);
          try { commit(attachQueuedFiles(sessionId, item.id, await uploadFiles(files, sessionId))); }
          catch (cause) { setError(cause instanceof Error ? cause.message : '素材添加失败'); }
          finally { setUploading(null); }
        }} /></label>}
        <button type="button" disabled={!index} aria-label={`上移第 ${index + 1} 条消息`} onClick={() => commit(moveQueuedMessage(sessionId, item.id, -1))}>↑</button>
        <button type="button" disabled={index === queue.items.length - 1} aria-label={`下移第 ${index + 1} 条消息`} onClick={() => commit(moveQueuedMessage(sessionId, item.id, 1))}>↓</button>
        <button type="button" aria-label={`删除第 ${index + 1} 条消息`} onClick={() => commit(removeQueuedMessage(sessionId, item.id))}>×</button>
      </div>
    </li>)}</ol>
    {(error || queue.error) && <p role="status">{error || queue.error}</p>}
  </section>;
}
