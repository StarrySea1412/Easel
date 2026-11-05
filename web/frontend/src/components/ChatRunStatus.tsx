import { useEffect, useState } from 'react';
import { useChatRun } from '../hooks/useChatRun';
import { operationTitle } from '../lib/execution';
import { IconLoader, IconInfo } from './icons';

/** Elapsed time never proves model activity. Only this turn's receipts do. */
export default function ChatRunStatus({questions = 0}: {questions?: number}) {
  const run = useChatRun();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!run?.streaming) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.streaming]);
  if (!run?.streaming) return null;
  const operations = run.execution.current?.operations || [];
  const latest = [...operations].reverse()[0];
  const at = latest?.finishedAt || latest?.startedAt;
  const seconds = at && Number.isFinite(Date.parse(at)) ? Math.max(0, Math.floor((now - Date.parse(at)) / 1000)) : null;
  const pending = latest && (latest.status === 'running' || latest.status === 'unconfirmed');
  const asking = questions > 0 || pending && latest.name === 'ask_user';
  const quiet = seconds !== null && seconds >= 180;
  if (!latest && !questions && !run.execution.error) return null;
  const title = asking ? '等待你选择' : pending ? '工具操作尚未结束' : quiet ? '较长时间没有新操作回执' : latest ? '等待下一步执行回执' : '执行记录读取失败';
  const Icon = asking || quiet ? IconInfo : IconLoader;
  return <section className={`chat-run-status${asking ? ' is-question' : ''}`} aria-label="当前任务状态" role="status">
    <Icon size={15}/><div><strong>{title}</strong>
      <p>{asking ? questions > 0 ? '请在下方选项卡回答，任务收到答案后继续。' : '已观察到提问操作，但尚未收到可回答的选项卡。问答连接可能异常，请勿重复发送任务。' : latest ? `最后操作：${operationTitle(latest)}` : '操作记录暂时不可用，无法确认当前执行阶段。'}</p>
      {at && <small>最后回执 {new Date(at).toLocaleTimeString('zh-CN', {hour12:false})}{seconds !== null ? ` · ${seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`}前` : ''}{quiet ? ' · 计时增长不代表任务仍在推进' : ''}</small>}
      {run.execution.error && <p>操作记录读取中断：{run.execution.error}</p>}
    </div>
  </section>;
}
