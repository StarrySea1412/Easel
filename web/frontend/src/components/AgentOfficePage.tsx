import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSession, StreamState } from '../lib/store';
import { createDemoOfficeAgents, createDemoOfficeEvents, DEMO_DURATION_SECONDS, OFFICE_STATE_LABELS } from '../lib/agentOffice';
import type { OfficeAgent } from '../lib/agentOffice';
import { useAgentOffice } from '../hooks/useAgentOffice';
import AgentOfficeScene from './agent-office/AgentOfficeScene';
import '../styles/agent-office.css';

interface AgentOfficePageProps {
  sessions: ChatSession[];
  activeSessionId: string | null;
  streams: Record<string, StreamState>;
  onOpenChat: (sessionId: string) => void;
  onOpenActivity?: (sessionId: string) => void;
}

function clock(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function snapshotTime(value: string | null) {
  if (!value) return '尚无快照';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '快照时间未知' : date.toLocaleTimeString('zh-CN', { hour12: false });
}

function StateBadge({ state, stale = false }: { state: OfficeAgent['state']; stale?: boolean }) {
  return <span className={`office-state office-state-${state}`}><i aria-hidden="true" />{stale ? '快照 · ' : ''}{OFFICE_STATE_LABELS[state]}</span>;
}

export default function AgentOfficePage({ sessions, activeSessionId, streams, onOpenChat, onOpenActivity }: AgentOfficePageProps) {
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [sessionChoice, setSessionChoice] = useState<string | null>(activeSessionId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [eventFilter, setEventFilter] = useState<'selected' | 'all'>('selected');
  const elapsedRef = useRef(0);
  const availableSessions = useMemo(() => sessions.filter((session) => !session.importedFromBackup), [sessions]);
  const sessionId = availableSessions.find((session) => session.id === sessionChoice)?.id
    ?? availableSessions.find((session) => session.id === activeSessionId)?.id
    ?? availableSessions[0]?.id ?? null;
  const live = useAgentOffice(mode === 'live' ? sessionId : null, mode === 'live' && sessionId !== null);
  const agents = useMemo(() => mode === 'demo'
    ? createDemoOfficeAgents(elapsed)
    : live.agents.filter((agent) => agent.source === 'live'), [mode, elapsed, live.agents]);
  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0];
  const events = (mode === 'demo' ? createDemoOfficeEvents(elapsed) : live.events || [])
    .filter(event => event.source === mode && agents.some(agent => agent.id === event.agentId))
    .filter(event => eventFilter === 'all' || event.agentId === selected?.id).slice(-40).reverse();
  const parent = selected?.parentId ? agents.find((agent) => agent.id === selected.parentId) : undefined;
  const stale = mode === 'live' && Boolean(live.error);
  const running = agents.filter((agent) => agent.state === 'working' || agent.state === 'thinking').length;
  const waiting = agents.filter((agent) => agent.state === 'waiting').length;
  const done = agents.filter((agent) => agent.state === 'done').length;
  const failed = agents.filter((agent) => agent.state === 'error').length;

  useEffect(() => {
    if (mode !== 'demo' || paused) return;
    let frame = 0;
    let previous: number | null = null;
    let lastPaint = 0;
    const tick = (now: number) => {
      if (document.hidden) { previous = null; return; }
      if (previous !== null) elapsedRef.current = Math.min(DEMO_DURATION_SECONDS, elapsedRef.current + Math.max(0, now - previous) / 1000);
      previous = now;
      const ended = elapsedRef.current >= DEMO_DURATION_SECONDS;
      // Scene motion has its own render loop; task labels need only five updates a second.
      if (now - lastPaint >= 200 || ended) {
        setElapsed(elapsedRef.current);
        lastPaint = now;
      }
      if (ended) setPaused(true);
      else frame = window.requestAnimationFrame(tick);
    };
    const visibility = () => {
      window.cancelAnimationFrame(frame);
      previous = null;
      if (!document.hidden) frame = window.requestAnimationFrame(tick);
    };
    document.addEventListener('visibilitychange', visibility);
    visibility();
    return () => { window.cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', visibility); };
  }, [mode, paused]);

  const changeMode = (next: 'demo' | 'live') => {
    setMode(next);
    setSelectedId(null);
    setPaused(next === 'demo' && elapsedRef.current >= DEMO_DURATION_SECONDS);
  };
  const replay = () => {
    elapsedRef.current = 0;
    setElapsed(0);
    setSelectedId(null);
    setPaused(false);
    setResetKey((value) => value + 1);
  };
  const togglePlayback = () => {
    if (mode === 'demo' && paused && elapsedRef.current >= DEMO_DURATION_SECONDS) replay();
    else setPaused((value) => !value);
  };

  return (
    <div className="agent-office-page">
      <div className="office-workspace">
        <header className="office-page-heading">
          <div>
            <p className="office-eyebrow">EASEL / COLLABORATIVE STUDIO</p>
            <h1>Agent 办公室<span className="office-heading-mark" aria-hidden="true">✳</span></h1>
            <p className="office-description">走进协作现场，看见每个角色正在做什么。</p>
          </div>
          <div className="office-mode-controls" role="group" aria-label="办公室数据模式">
            <button type="button" aria-pressed={mode === 'demo'} onClick={() => changeMode('demo')}>演示模式</button>
            <button type="button" aria-pressed={mode === 'live'} onClick={() => changeMode('live')}>实时观测</button>
          </div>
        </header>

        <section className={`office-source-strip ${mode === 'demo' ? 'is-demo' : stale ? 'is-stale' : 'is-live'}`} aria-label="办公室数据来源">
          <div className="office-source-copy">
            <span className={`office-mode-badge ${mode}`}><i aria-hidden="true" />{mode === 'demo' ? '演示 · 模拟任务' : stale ? '更新中断 · 上次快照' : '实时观测 · 后台记录'}</span>
            <p>{mode === 'demo' ? '六个角色的协作演示，不代表真实 Agent 调用或执行结果。' : live.coverage || '仅展示当前会话可观察到的后台记录，不补全未上报的角色。'}</p>
          </div>
          {mode === 'live' && <label className="office-session-select">观察会话
            <select value={sessionId ?? ''} disabled={!availableSessions.length} onChange={(event) => { setSessionChoice(event.target.value); setSelectedId(null); }}>
              {!availableSessions.length && <option value="">暂无普通会话</option>}
              {availableSessions.map((session) => <option key={session.id} value={session.id}>{session.title || '未命名会话'}{streams[session.id] ? ' · 对话接收中' : ''}</option>)}
            </select>
          </label>}
        </section>

        {mode === 'live' && live.error && <div className="office-observation-error" role="alert">
          <div><strong>更新已中断{agents.length ? '，保留上次快照' : ''}</strong><p>{live.error}{agents.length ? '；下方状态并非当前实时执行状态。' : '；未填入模拟角色。'}</p></div>
          <button type="button" className="office-button" disabled={!sessionId || live.loading} onClick={live.refresh}>重新获取</button>
        </div>}

        <div className="office-layout">
          <section className="office-stage-card" aria-label="3D Agent 办公室">
            <div className="office-stage-toolbar">
              <div className="office-floor-label"><span aria-hidden="true">⌘</span><div><strong>协作工作室</strong><small>{mode === 'demo' ? 'DEMO FLOOR / 模拟协作' : 'OBSERVATION FLOOR / 记录快照'}</small></div></div>
              <div className="office-stage-actions">
                <button type="button" className="office-button" aria-pressed={paused || stale} disabled={stale} onClick={togglePlayback}><span aria-hidden="true">{paused && !stale ? '▶' : 'Ⅱ'}</span>{stale ? '快照已暂停' : paused ? '播放动画' : '暂停动画'}</button>
                {mode === 'demo' && <button type="button" className="office-button" onClick={replay}><span aria-hidden="true">↺</span>重播演示</button>}
                <button type="button" className="office-button office-view-reset" onClick={() => setResetKey((value) => value + 1)}><span aria-hidden="true">⌖</span>视角复位</button>
              </div>
            </div>
            <div className="office-stage-viewport">
              <AgentOfficeScene agents={agents} selectedId={selected?.id ?? null} onSelect={setSelectedId} paused={paused || stale} resetKey={resetKey} />
              <div className="office-stage-stamp" aria-hidden="true"><strong>E.</strong><span>{mode === 'demo' ? 'SIMULATION' : 'OBSERVATION'}</span></div>
              {mode === 'live' && !agents.length && <div className="office-scene-notice" role="status">
                <strong>{!sessionId ? '还没有可观察的会话' : live.loading ? '正在读取后台记录' : live.error ? '暂时无法读取协作记录' : '当前没有可观察的 Agent'}</strong>
                <p>{!sessionId ? '备份副本不连接后台。创建普通对话后，可以在这里选择会话。' : live.loading ? '角色只会在收到对应记录后出现。' : '后台尚未提供可核验的角色状态；空工位不会填入模拟任务。'}</p>
              </div>}
            </div>
            <div className="office-stage-footer">
              {mode === 'demo' ? <div className="office-demo-timeline">
                <div><span>{elapsed >= DEMO_DURATION_SECONDS ? '演示完成 · 可重播' : paused ? '演示已暂停' : '模拟协作进行中'}</span><time>{clock(elapsed)} / {clock(DEMO_DURATION_SECONDS)}</time></div>
                <progress aria-label="模拟任务演示进度" value={elapsed} max={DEMO_DURATION_SECONDS} />
                <p>任务分工<span>→</span>并行协作<span>→</span>检查与审阅<span>→</span>完成</p>
              </div> : <div className="office-live-footer"><div><span>{stale ? '上次快照' : live.loading ? '正在更新快照' : '最近观测'}</span><strong>{snapshotTime(live.observedAt)}</strong><small>{stale ? '更新中断时冻结画面，保留上次观察到的状态。' : '暂停仅影响画面动画，后台观测仍会更新。'}</small></div><button type="button" className="office-button" disabled={!sessionId || live.loading} onClick={live.refresh}>{live.loading ? '更新中…' : '刷新记录'}</button></div>}
            </div>
          </section>

          <aside className="office-inspector" aria-label="Agent 任务详情">
            <div className="office-inspector-heading"><div><p className="office-eyebrow">TEAM / 协作成员</p><h2>{agents.length} 个角色<span>{mode === 'demo' ? '模拟' : stale ? '上次快照' : '已观测'}</span></h2></div><span className="office-inspector-symbol" aria-hidden="true">↗</span></div>
            <dl className="office-stats" aria-label={stale ? '上次快照统计' : '角色状态统计'}><div><dt>运行</dt><dd>{running}</dd></div><div><dt>等待</dt><dd>{waiting}</dd></div><div><dt>完成</dt><dd>{done}</dd></div></dl>
            {failed > 0 && <p className="office-failure-count">{failed} 个角色{stale ? '在上次快照中' : ''}记录了错误</p>}
            {selected ? <section className="office-agent-detail" aria-label="选中成员当前任务">
              <div className="office-selected-person"><div className="office-mini-person" aria-hidden="true"><i /><span /></div><div><span className="office-seat-label">工位 {String(agents.indexOf(selected) + 1).padStart(2, '0')}</span><h3>{selected.name || '未命名 Agent'}</h3></div><StateBadge state={selected.state} stale={stale} /></div>
              <div className="office-current-task"><span>{stale ? '快照中的任务' : '当前任务'}</span><p>{selected.task || '当前记录未提供任务描述。'}</p></div>
              <dl className="office-agent-meta"><div><dt>角色</dt><dd>{selected.role || '未提供'}</dd></div><div><dt>协作上级</dt><dd>{parent?.name || (selected.parentId ? '未包含在当前记录中' : '未提供')}</dd></div><div><dt>记录来源</dt><dd>{selected.source === 'demo' ? '模拟任务脚本' : '后台观察记录'}</dd></div></dl>
            </section> : <div className="office-no-selection"><span aria-hidden="true">○</span><p>等待可观察的成员</p><small>任务与状态将在这里显示。</small></div>}
            <section className="office-call-history" aria-label="Agent 调用记录">
              <div className="office-calls-heading"><h3>调用记录 <small>{mode === 'demo' ? '模拟' : stale ? '上次快照' : '已观察'}</small></h3>
                <div role="group" aria-label="调用记录范围"><button type="button" aria-pressed={eventFilter === 'selected'} onClick={() => setEventFilter('selected')}>当前 Agent</button><button type="button" aria-pressed={eventFilter === 'all'} onClick={() => setEventFilter('all')}>全部</button></div>
              </div>
              <ol className="office-event-list">{events.map(event => <li key={event.id} className={`office-event-${event.status}`}>
                <div><span>{agents.find(agent => agent.id === event.agentId)?.name}</span><time>{event.source === 'demo' ? `演示 ${clock(event.elapsedSeconds || 0)}` : event.at ? snapshotTime(event.at) : '时间未上报'}</time></div>
                <p>{event.title}</p><small>{{ called: '已调用', returned: '已返回', failed: '返回错误', observed: '已观察' }[event.status]}</small>
              </li>)}</ol>
              {!events.length && <p className="office-no-events">{mode === 'demo' ? '该角色的模拟调用尚未开始。' : '尚未观察到该 Agent 的调用记录。子 Agent 内部工具记录暂不可见。'}</p>}
              <p className="office-calls-note">{mode === 'demo' ? '调用与时间均为演示脚本。' : '仅列出有记录的调用与回执；已返回不代表执行成功。'}</p>
            </section>
            <div className="office-members-heading"><h3>所有工位</h3><span>点击查看任务</span></div>
            <ul className="office-member-list" aria-label="办公室成员">
              {agents.map((agent, index) => <li key={agent.id}><button type="button" aria-pressed={selected?.id === agent.id} onClick={() => setSelectedId(agent.id)}>
                <span className="office-member-number">{String(index + 1).padStart(2, '0')}</span><span className="office-member-name"><strong>{agent.name}</strong><small>{agent.role || '角色未提供'}</small></span><StateBadge state={agent.state} stale={stale} />
              </button></li>)}
            </ul>
            <div className="office-inspector-footer">{mode === 'demo' ? <p><span aria-hidden="true">◇</span>演示中的角色、任务和状态均为模拟。</p> : <><button type="button" className="office-open-chat" disabled={!sessionId} onClick={() => { if (sessionId) onOpenChat(sessionId); }}>查看所选会话<span aria-hidden="true">↗</span></button>{onOpenActivity && <button type="button" className="office-open-chat" disabled={!sessionId} onClick={() => { if (sessionId) onOpenActivity(sessionId); }}>查看运行记录<span aria-hidden="true">↗</span></button>}</>}</div>
          </aside>
        </div>
        <footer className="office-page-footnote"><span>EASEL OFFICE · 一起把想法变成作品</span><span>{mode === 'demo' ? '当前为演示空间，不触发模型任务' : '观测已有任务，不在此创建或分派后台任务'}</span></footer>
      </div>
    </div>
  );
}
