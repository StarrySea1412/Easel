import { useEffect, useId, useRef, useState } from 'react';
import type { OfficeAgent, OfficeEvent } from '../lib/agentOffice';
import { OFFICE_STATE_LABELS } from '../lib/agentOffice';
import { decodeExecution, type ExecutionSnapshot } from '../lib/execution';
import { decodeObservedModel, type OfficeObservedModel } from '../lib/modelProviders';
import { ModelIdentityLabel } from './AgentIdentity';
import ExecutionOperation from './ExecutionOperation';
import { IconAgentOffice, IconChevron } from './icons';
import '../styles/chat-execution.css';

type Detail = ExecutionSnapshot & { observedModel?: OfficeObservedModel };

function ChildOperations({sessionId, turnId, agent, events, stale}: {
  sessionId: string; turnId: string; agent: OfficeAgent; events: OfficeEvent[]; stale: boolean;
}) {
  const [current, setCurrent] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const active = agent.state === 'working' || agent.state === 'thinking' || agent.state === 'waiting';
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (disposed || document.hidden || request) return;
      const controller = new AbortController(); request = controller;
      let timedOut = false;
      deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 12_000);
      setLoading(true);
      try {
        const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
        const response = await fetch(`${base}/api/agent-office/child-activity?${new URLSearchParams({sessionId, turnId, agentId: agent.id})}`, {signal: controller.signal, cache: 'no-store'});
        if (!response.ok) throw new Error(`子任务操作暂不可读（HTTP ${response.status}）。`);
        const raw = await response.json();
        const data = decodeExecution(raw);
        if (!data || data.sessionId !== sessionId || data.turnId !== turnId || raw.agentId !== agent.id) throw new Error('子任务操作不属于当前对话、轮次或智能体。');
        if (!disposed && !controller.signal.aborted) {
          setCurrent({...data, observedModel: decodeObservedModel(raw.observedModel)});
          setError('');
        }
      } catch (cause) {
        if (!disposed && (timedOut || !controller.signal.aborted)) setError(timedOut ? '读取子任务超时，请重试。' : cause instanceof Error ? cause.message : '子任务读取失败，请重试。');
      } finally {
        clearTimeout(deadline); request = undefined;
        if (!disposed) {
          setLoading(false);
          if (active && !document.hidden) timer = setTimeout(() => void read(), 2000);
        }
      }
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void read(); };
    document.addEventListener('visibilitychange', visibility);
    void read();
    return () => { disposed = true; clearTimeout(timer); clearTimeout(deadline); request?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [sessionId, turnId, agent.id, active, revision]);
  const ownEvents = events.filter(event => event.agentId === agent.id);
  const identity = current?.observedModel?.source === 'observed' ? current.observedModel : agent.observedModel;
  return <div className="chat-subagent-body">
    <div className="chat-subagent-detail-meta"><span>{OFFICE_STATE_LABELS[agent.state]}{stale ? ' · 上次快照' : ''}</span><ModelIdentityLabel identity={identity}/><button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>{loading ? '正在读取…' : '重新读取'}</button></div>
    <p className="chat-subagent-task">{agent.task || '任务说明未上报'}</p>
    {error && <p className="chat-execution-note" role="status">{error}{current ? ' 已保留上次读取的操作。' : ''}</p>}
    {current?.warnings.map((warning, index) => <p className="execution-note" key={index}>{warning}</p>)}
    {!!current?.progress?.length && <section className="chat-subagent-progress" aria-label="子任务进度与回复">{current.progress.map((text, index) => <p key={index}>{text}</p>)}</section>}
    {!!current?.operations.length && <section className="chat-execution" aria-label="子智能体实际操作">{current.operations.map(row => <ExecutionOperation row={row} key={row.id} running={false}/>)}</section>}
    {!current?.operations.length && <p className="execution-note">{loading && !current ? '正在读取这个子任务的操作…' : '尚无可展示的子任务工具操作。'}</p>}
    {!current?.progress?.length && agent.latestReply && <section className="chat-subagent-progress" aria-label="父任务收到的子任务回复"><small>父任务收到的最近回复{agent.latestReply.truncated ? ' · 已截断' : ''}</small><p>{agent.latestReply.text}</p></section>}
    {!!ownEvents.length && <details className="chat-subagent-receipts"><summary>任务状态记录 · {ownEvents.length}</summary>{ownEvents.map(event => <p key={event.id}>{event.at && <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString('zh-CN', {hour12: false})} · </time>}{event.title}</p>)}</details>}
  </div>;
}

export default function ChatSubagentActivity(props: {sessionId: string; turnId: string; agent: OfficeAgent; events: OfficeEvent[]; stale: boolean}) {
  const {agent, stale} = props;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  return <div className={`chat-subagent-row${open ? ' is-open' : ''}`} data-agent-id={agent.id} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus(); }
  }}>
    <button ref={button} type="button" className="chat-subagent-trigger" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)} title={`${agent.name} · ${agent.task}`}>
      <IconAgentOffice size={15}/><span className="chat-subagent-kind">子智能体</span><strong>{agent.name}</strong><span className="chat-subagent-divider" aria-hidden="true">·</span><span className="chat-subagent-summary">{agent.task || '任务说明未上报'}</span><small className={`chat-subagent-state is-${agent.state}`}>{stale ? '快照 · ' : ''}{OFFICE_STATE_LABELS[agent.state]}</small><span className="chat-subagent-chevron" aria-hidden="true"><IconChevron size={12}/></span>
    </button>
    <div id={id} hidden={!open}>{open && <ChildOperations {...props}/>}</div>
  </div>;
}
