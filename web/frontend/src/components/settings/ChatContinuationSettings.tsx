import { useId, useState } from 'react';
import { readChatAutoContinue, saveChatAutoContinue } from '../../lib/chatContinuation';
import Switch from '../ui/Switch';

export default function ChatContinuationSettings({ session }: {
  session?: { id: string; title: string; busy: boolean; unavailableReason?: string };
}) {
  const id = useId();
  const [enabled, setEnabled] = useState(() => session ? readChatAutoContinue(session.id) : false);
  const [error, setError] = useState('');
  const disabledReason = session?.unavailableReason || (session?.busy ? '当前对话正在运行，结束或停止后可修改。' : '');
  return <section className="chat-continuation-settings" aria-labelledby={`${id}-title`}>
    <header><h3 id={`${id}-title`}>对话</h3>
      <p>{session ? <>当前对话：<strong>{session.title || '未命名对话'}</strong> · 仅对当前对话生效</> : '先打开一个对话，再设置它的自动继续偏好。'}</p>
    </header>
    {session && <>
      <div className="chat-continuation-setting-row">
        <div><label id={`${id}-label`} htmlFor={`${id}-switch`}>自动继续</label>
          <p id={`${id}-help`}>任务未完成时最多自动继续 2 次；等待确认或手动停止时暂停。</p></div>
        <div className="chat-continuation-setting-control"><span aria-hidden="true">{enabled ? '已开启' : '已关闭'}</span>
          <Switch id={`${id}-switch`} checked={enabled} disabled={Boolean(disabledReason)}
            aria-labelledby={`${id}-label`} aria-describedby={`${id}-help ${id}-status`} onChange={next => {
              if (saveChatAutoContinue(session.id, next)) { setEnabled(next); setError(''); }
              else setError('自动继续设置未能保存，请检查浏览器存储后重试。');
            }} /></div>
      </div>
      <p id={`${id}-status`} className="chat-continuation-setting-status" role="status">{disabledReason || '更改后保存到当前浏览器，下次发送时生效。'}</p>
      {error && <p className="save-note err" role="alert">{error}</p>}
    </>}
  </section>;
}
