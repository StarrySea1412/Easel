import { useEffect, useId, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { OFFICE_STATE_LABELS, type OfficeAgent, type OfficeEvent } from '../../lib/agentOffice';
import type { ChatSession, StreamState } from '../../lib/store';
import { selectOfficeProcess, selectOfficeEventSteps } from './officeProcessData';
import './office-process-panel.css';

export interface OfficeProcessPanelProps {
  agent: OfficeAgent;
  /** The complete event list from the same snapshot as turnId, before UI filtering. */
  events: OfficeEvent[];
  session?: ChatSession;
  /** The stream keyed by session.id; StreamState itself has no identity fields. */
  stream?: StreamState;
  turnId?: string | null;
  stale: boolean;
  onClose: () => void;
  onOpenChat?: () => void;
}

const STATUS_EXPLANATION: Record<OfficeAgent['state'], string> = {
  working: '该员工正在工作，下面会展示已经收到的过程记录。',
  thinking: '该员工已上报思考状态；具体内容以模型服务实际返回的记录为准。',
  waiting: '该员工正在等待任务或协作结果。',
  done: '该员工已上报完成，已收到的过程记录仍可查看。',
  error: '该员工已上报错误，请查看已有的错误或工具回执；未提供的原因无法确认。',
  stopped: '该员工已停止，已收到的思考和工作记录仍保留在这里。',
  unknown: '当前没有可确认的执行状态，以下仅展示已取得的记录。',
};

function timeLabel(event: OfficeEvent) {
  if (event.source === 'demo' && Number.isFinite(event.elapsedSeconds)) return `演示 ${Math.max(0, Math.floor(event.elapsedSeconds!))} 秒`;
  if (!event.at || !Number.isFinite(Date.parse(event.at))) return '时间未上报';
  return new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false });
}
function eventState(event: OfficeEvent, result?: OfficeEvent) {
  const reported = result || event;
  if (reported.status === 'failed') return { tone: 'error', text: '已报告失败' };
  if (reported.kind === 'result' && reported.status === 'returned') return { tone: 'done', text: '已收到回执' };
  if (event.kind === 'call') return { tone: 'working', text: '已调用 · 尚无匹配回执' };
  if (event.kind === 'spawn') return { tone: 'neutral', text: '已观察到委派' };
  return { tone: 'neutral', text: '已观察到' };
}

export default function OfficeProcessPanel(props: OfficeProcessPanelProps) {
  const { agent, events, session, stream, turnId, stale, onClose, onOpenChat } = props;
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const current = useRef({ onClose });
  current.current = { onClose };
  const titleId = useId();
  const descriptionId = useId();
  const process = useMemo(() => selectOfficeProcess({ agent, session, stream, turnId }), [agent, session, stream, turnId]);
  const steps = useMemo(() => selectOfficeEventSteps(agent, events, turnId), [agent, events, turnId]);
  const displayName = agent.appearance?.id === 'generic' ? agent.name : agent.appearance?.name || agent.name;
  const visibleState = stale ? `快照 · ${OFFICE_STATE_LABELS[agent.state]}` : OFFICE_STATE_LABELS[agent.state];

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const focusable = () => Array.from(panel.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ) || []).filter(element => !element.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden');
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); current.current.onClose(); return; }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0], last = elements.at(-1);
      if (!first) { event.preventDefault(); panel.current?.focus(); return; }
      const focused = document.activeElement;
      if (event.shiftKey && (focused === first || !panel.current?.contains(focused))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (focused === last || !panel.current?.contains(focused))) { event.preventDefault(); first.focus(); }
    };
    const focusin = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) closeButton.current?.focus();
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focusin);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(<div className="office-process-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="office-process-panel" ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
      <header className="office-process-header">
        <div><span className="office-process-eyebrow">{agent.source === 'demo' ? '模拟协作过程' : '员工工作过程'}</span><h2 id={titleId}>{displayName} · 思考与工作过程</h2><p id={descriptionId}>查看该员工已经上报的思考、活动与工具回执。</p></div>
        <button ref={closeButton} type="button" className="office-process-close" aria-label="关闭员工过程" onClick={onClose}>×</button>
      </header>
      <div className="office-process-body" tabIndex={0} role="region" aria-label="员工过程内容">
        <div className={`office-process-status office-process-status--${agent.state}`}>
          <span className="office-process-badge">{visibleState}</span>
          <p>{agent.source === 'demo' ? '这是模拟员工的演示状态。' : STATUS_EXPLANATION[agent.state]}</p>
        </div>
        {stale && agent.source === 'live' && <p className="office-process-warning" role="status">观测更新已中断。员工状态和调用记录可能不是最新，已取得的内容继续保留。</p>}
        <dl className="office-process-identity">
          <div><dt>真实身份</dt><dd>{agent.source === 'demo' ? '演示身份' : agent.name}<code>{agent.id}</code></dd></div>
          <div><dt>轮次</dt><dd>{agent.source === 'demo' ? '预设模拟轮次' : turnId || '未提供轮次标识'}</dd></div>
          <div><dt>当前任务</dt><dd>{agent.task || '尚未上报任务说明'}</dd></div>
        </dl>
        {process.error && <section className="office-process-error" aria-label="本轮错误"><strong>本轮已记录错误</strong><p>{process.error.message}</p>{process.error.code && <code>{process.error.code}</code>}</section>}
        <section className="office-process-section" aria-labelledby={`${titleId}-thinking`}>
          <div className="office-process-section-heading"><h3 id={`${titleId}-thinking`}>{agent.source === 'demo' ? '模拟过程摘要' : '模型返回的思考'}</h3><span>{process.origin === 'stream' ? '本轮实时返回' : process.origin === 'history' ? '本轮已保存' : agent.source === 'demo' ? '模拟数据' : '未提供'}</span></div>
          <p className="office-process-note">{process.explanation}</p>
          {agent.source === 'demo' ? <div className="office-process-text office-process-text--demo">{process.activity}</div>
            : process.thinking ? <div className="office-process-text" data-testid="office-thinking">{process.thinking}</div>
              : process.origin !== 'unavailable' && <p className="office-process-empty">模型服务没有返回可展示的本轮思考或摘要。工作状态不代表思考正文已经可用。</p>}
        </section>
        {agent.source === 'live' && process.activity && <section className="office-process-section" aria-labelledby={`${titleId}-activity`}>
          <div className="office-process-section-heading"><h3 id={`${titleId}-activity`}>{process.origin === 'stream' ? '当前活动' : '本轮工作步骤'}</h3><span>{process.origin === 'stream' ? '来自本轮会话流' : '来自本轮已保存记录'}</span></div>
          <div className="office-process-text" data-testid="office-activity">{process.activity}</div>
        </section>}
        <section className="office-process-section" aria-labelledby={`${titleId}-tools`}>
          <div className="office-process-section-heading"><h3 id={`${titleId}-tools`}>调用与回执</h3><span>{steps.length} 条{agent.source === 'demo' ? '模拟记录' : '可见记录'}</span></div>
          <p className="office-process-note">{agent.source === 'demo' ? '以下记录来自预设演示。' : '仅展示当前快照提供的工具名称、过程摘要与回执状态；未上报的工具输出正文不可见。'}</p>
          {steps.length ? <ol className="office-process-timeline">{steps.map(({ event, result }) => {
            const state = eventState(event, result);
            return <li className={`office-process-step office-process-step--${state.tone}`} key={event.id}>
              <div className="office-process-step-meta"><span>{timeLabel(event)}</span><span>{state.text}</span></div>
              {event.toolName && <code className="office-process-tool">{event.toolName}</code>}
              <p>{event.title}</p>
              {result && <div className="office-process-result"><span>{timeLabel(result)} · {result.status === 'failed' ? '失败回执' : '工具回执'}</span><p>{result.title}</p></div>}
            </li>;
          })}</ol> : <p className="office-process-empty">{agent.source === 'live' && !turnId ? '当前快照没有轮次标识，调用过程暂时无法归属到本轮。' : '尚未收到属于该员工、本轮的调用或回执记录。这不代表它没有工作。'}</p>}
        </section>
      </div>
      <footer className="office-process-footer"><span>{agent.source === 'demo' ? '演示内容与真实会话数据分开显示' : '仅显示已经取得的记录，不补写未提供的过程'}</span>{onOpenChat && agent.source === 'live' && <button type="button" className="office-process-open-chat" onClick={() => { onClose(); onOpenChat(); }}>在对话中查看</button>}</footer>
    </section>
  </div>, document.body);
}
