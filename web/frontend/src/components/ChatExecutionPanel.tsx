import { useEffect, useState } from 'react';
import { fetchChatExecution, type ChatExecution } from '../lib/api';
import '../styles/chat-execution.css';

const labels = { running: '执行中', returned: '已返回', failed: '失败', unconfirmed: '结果未确认' };
export default function ChatExecutionPanel({ sessionId, turnId, streaming, onOpen }: { sessionId: string; turnId: string; streaming: boolean; onOpen?: () => void }) {
  const [snapshot, setSnapshot] = useState<ChatExecution | null>(null), [expanded, setExpanded] = useState(false);
  const [readError, setReadError] = useState<{ sessionId: string; turnId: string; message: string } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => { setExpanded(false); }, [sessionId, turnId]);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try { const value = await fetchChatExecution(sessionId, turnId, controller.signal); if (!controller.signal.aborted) { setSnapshot(value); setReadError(null); } }
      catch { if (!controller.signal.aborted) setReadError({ sessionId, turnId, message: '执行记录暂不可读，已有回执保留。' }); }
      finally { if (streaming && !controller.signal.aborted) timer = setTimeout(() => void read(), 3000); }
    };
    void read(); return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [sessionId, turnId, streaming, revision]);
  const current = snapshot?.sessionId === sessionId && snapshot.turnId === turnId ? snapshot : null;
  const rows = current?.operations ?? [];
  const error = readError?.sessionId === sessionId && readError.turnId === turnId ? readError.message : '';
  const note = [error, ...(current?.warnings ?? [])].filter(Boolean).join(' ');
  const notice = note ? <div className="chat-execution-note" role="status"><span>{note}</span> <button type="button" onClick={() => setRevision(value => value + 1)}>重新读取</button></div> : null;
  if (!rows.length) return notice ? <section className="chat-execution" aria-label="本轮执行记录提示">{notice}{onOpen && <button type="button" onClick={onOpen}>运行记录 ↗</button>}</section> : null;
  const files = new Set(rows.filter(row => row.diff && row.path).map(row => row.path));
  return <section className="chat-execution" aria-label="本轮工具执行">
    <div className="chat-execution-heading"><span>工具执行 · {rows.length}{files.size > 0 && ` · ${files.size} 个文件有修改回执`}</span>{onOpen && <button type="button" onClick={onOpen}>运行记录 ↗</button>}</div>
    {(expanded ? rows : rows.slice(-3)).map(row => <details key={row.id} className="chat-execution-row">
      <summary><span className={`chat-execution-state is-${row.status}`}>{labels[row.status]}</span><span className="chat-execution-title" title={row.command || row.path || row.name}>{row.command || row.path || row.name}</span>
        {row.elapsedSeconds !== undefined && <small>{row.elapsedSeconds.toFixed(1)} 秒</small>}{row.diff && <small className="chat-execution-diff-count">+{row.added} −{row.removed}</small>}
      </summary>
      <div className="chat-execution-detail"><small>{row.name}</small>{row.command && <pre>{row.command}</pre>}{row.path && <p>{row.path}</p>}
        {row.diff ? <pre className="chat-execution-diff">{row.diff}</pre> : row.output ? <pre>{row.output}</pre> : <p>尚未收到可展示的工具结果。</p>}
      </div>
    </details>)}
    {rows.length > 3 && <button type="button" className="chat-execution-more" onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : `查看全部 ${rows.length} 项`}</button>}
    {notice}
  </section>;
}
