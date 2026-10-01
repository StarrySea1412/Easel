import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatSession, StreamState } from '../lib/store';
import { DEMO_DURATION_SECONDS, OFFICE_STATE_LABELS } from '../lib/agentOffice';
import { createTeamDemoOfficeAgents, createTeamDemoOfficeEvents, demoOfficeCardId, demoOfficeNameSuffix, officeZoneForAgent, searchOfficeTeam, OFFICE_DEMO_TEAM_SIZES, OFFICE_ZONE_CAPACITY, type OfficeDemoTeamSize } from '../lib/officeTeams';
import type { OfficeAgent } from '../lib/agentOffice';
import { useAgentOffice } from '../hooks/useAgentOffice';
import AgentOfficeScene from './agent-office/AgentOfficeScene';
import OfficeProcessPanel from './agent-office/OfficeProcessPanel';
import OfficeOutputMonitor from './agent-office/OfficeOutputMonitor';
import OfficeAgentControls from './agent-office/OfficeAgentControls';
import OfficeWorkPreview from './agent-office/OfficeWorkPreview';
import OfficeAppearanceEditor from './agent-office/OfficeAppearanceEditor';
import { describeOfficeAction } from '../lib/officeActions';
import { useEmployeeAppearances, useEmployeeAssignments, assignEmployeeAppearance, readEmployeeAppearances, saveEmployeeAppearances, type EmployeeAppearance, type EmployeeAppearanceId } from '../lib/employeeAppearance';
import '../styles/agent-office.css';

const CharacterStudy = lazy(() => import('./agent-office/character-study/CharacterStudy'));

// These entry points follow the simulated task script: writing joins design at
// 18s, and review joins checking at 28s. They never dispatch a real task.
const DEMO_PHASES = [
  { seconds: 0, label: '任务分工' },
  { seconds: 18, label: '并行协作' },
  { seconds: 28, label: '检查与审阅' },
  { seconds: DEMO_DURATION_SECONDS, label: '完成' },
];

interface AgentOfficePageProps {
  sessions: ChatSession[];
  activeSessionId: string | null;
  streams: Record<string, StreamState>;
  onOpenChat: (sessionId: string) => void;
  onOpenActivity?: (sessionId: string) => void;
  onOpenSettings?: () => void;
  onOpenModels?: () => void;
  onOpenOutputs?: () => void;
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

export default function AgentOfficePage({ sessions, activeSessionId, streams, onOpenChat, onOpenActivity, onOpenModels, onOpenOutputs }: AgentOfficePageProps) {
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [showStudy, setShowStudy] = useState(false);
  const [sessionChoice, setSessionChoice] = useState<string | null>(activeSessionId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [demoTeamSize, setDemoTeamSize] = useState<OfficeDemoTeamSize>(6);
  const [memberQuery, setMemberQuery] = useState('');
  const [paused, setPaused] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [demoRunKey, setDemoRunKey] = useState(0);
  const [demoSeek, setDemoSeek] = useState({ seconds: 0, revision: 0 });
  const [elapsed, setElapsed] = useState(0);
  const [eventFilter, setEventFilter] = useState<'selected' | 'all'>('selected');
  const [processTarget, setProcessTarget] = useState<{ id: string; scope: string } | null>(null);
  const [bindingNotice, setBindingNotice] = useState('');
  const [appearanceEdit, setAppearanceEdit] = useState<{ agentId: string; agentName: string; live: boolean; original: EmployeeAppearance; draft: EmployeeAppearance } | null>(null);
  const pageElement = useRef<HTMLDivElement>(null);
  const previewElement = useRef<HTMLDivElement>(null);
  const scrollBeforeEdit = useRef<number | null>(null);
  const appearanceEditorOpen = Boolean(appearanceEdit);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ scope: string; message: string } | null>(null);
  const previousStates = useRef<{ scope: string; states: Map<string, OfficeAgent['state']> } | null>(null);
  const appearances = useEmployeeAppearances();
  const assignments = useEmployeeAssignments();
  const elapsedRef = useRef(0);
  const availableSessions = useMemo(() => sessions.filter((session) => !session.importedFromBackup), [sessions]);
  const sessionId = availableSessions.find((session) => session.id === sessionChoice)?.id
    ?? availableSessions.find((session) => session.id === activeSessionId)?.id
    ?? availableSessions[0]?.id ?? null;
  const live = useAgentOffice(mode === 'live' && !showStudy ? sessionId : null, mode === 'live' && sessionId !== null && !showStudy);
  const rawAgents = useMemo(() => mode === 'demo'
    ? createTeamDemoOfficeAgents(elapsed, demoTeamSize)
    : live.agents.filter((agent) => agent.source === 'live'), [mode, elapsed, demoTeamSize, live.agents]);
  const allEvents = useMemo(() => mode === 'demo' ? createTeamDemoOfficeEvents(elapsed, rawAgents) : live.events || [], [mode, elapsed, rawAgents, live.events]);
  const agents = useMemo(() => rawAgents.map(agent => {
    const cardId = assignments[agent.id] || (agent.source === 'demo' ? demoOfficeCardId(agent.id) : 'generic');
    const savedAppearance = appearances.find(card => card.id === cardId) || appearances[6];
    const appearance = appearanceEdit?.agentId === agent.id ? appearanceEdit.draft : savedAppearance;
    const suffix = agent.source === 'demo' ? demoOfficeNameSuffix(agent.id) : '';
    const action = describeOfficeAction(agent.source === 'demo' ? { ...agent, id: demoOfficeCardId(agent.id) } : agent, allEvents);
    return { ...agent, appearance: suffix ? { ...appearance, name: appearance.name + suffix } : appearance, action };
  }), [rawAgents, appearances, assignments, allEvents, appearanceEdit]);
  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0];
  const memberPositions = useMemo(() => new Map(agents.map((agent, index) => [agent.id, index])), [agents]);
  // The selected identity determines the zone so selection, focus and editing
  // cannot drift apart when the live roster grows or is reordered.
  const zone = officeZoneForAgent(agents, selected?.id ?? null);
  const filteredMembers = useMemo(() => searchOfficeTeam(agents, memberQuery), [agents, memberQuery]);
  const scope = `${mode}:${mode === 'live' ? sessionId : ''}:${mode === 'live' ? live.turnId || '' : demoRunKey}`;
  const processAgent = processTarget?.scope === scope ? agents.find(agent => agent.id === processTarget.id) : undefined;
  const selectAgent = (id: string, locate = false) => {
    if (!agents.some(agent => agent.id === id)) return;
    setSelectedId(id);
    if (focusId || locate) setFocusId(id);
    if (locate && pageElement.current && previewElement.current) {
      const page = pageElement.current;
      page.scrollTop = Math.max(0, page.scrollTop + previewElement.current.getBoundingClientRect().top - page.getBoundingClientRect().top - 12);
    }
  };
  const changeZone = (index: number) => {
    const first = agents[index * OFFICE_ZONE_CAPACITY];
    if (first) selectAgent(first.id);
  };
  const openProcess = (id: string) => { selectAgent(id); setProcessTarget({ id, scope }); };
  const displayName = (agent: OfficeAgent) => agent.source === 'demo' || assignments[agent.id] ? agent.appearance?.name || agent.name : agent.name;
  const events = allEvents
    .filter(event => event.source === mode && agents.some(agent => agent.id === event.agentId))
    .filter(event => eventFilter === 'all' || event.agentId === selected?.id).slice(-40).reverse();
  const parent = selected?.parentId ? agents.find((agent) => agent.id === selected.parentId) : undefined;
  const stale = mode === 'live' && Boolean(live.error);
  const running = agents.filter((agent) => agent.state === 'working' || agent.state === 'thinking').length;
  const waiting = agents.filter((agent) => agent.state === 'waiting').length;
  const done = agents.filter((agent) => agent.state === 'done').length;
  const failed = agents.filter((agent) => agent.state === 'error').length;
  const demoPhase = DEMO_PHASES.findLast(phase => elapsed >= phase.seconds) ?? DEMO_PHASES[0];

  useLayoutEffect(() => {
    const page = pageElement.current;
    if (!page) return;
    if (appearanceEditorOpen && previewElement.current) {
      // Align the existing renderer after the editor layout is applied. No camera
      // reset or remount: scrolling and the renderer's normal resize are enough.
      const pageTop = page.getBoundingClientRect().top;
      page.style.setProperty('--office-preview-offset', `${Math.max(0, pageTop) + 36}px`);
      page.scrollTop = Math.max(0, page.scrollTop + previewElement.current.getBoundingClientRect().top - pageTop - 12);
    } else if (scrollBeforeEdit.current !== null) {
      page.style.removeProperty('--office-preview-offset');
      page.scrollTop = scrollBeforeEdit.current;
      scrollBeforeEdit.current = null;
    }
  }, [appearanceEditorOpen]);

  useEffect(() => {
    if (focusId && !agents.some(agent => agent.id === focusId)) setFocusId(null);
  }, [agents, focusId]);

  useEffect(() => {
    if (appearanceEdit && !rawAgents.some(agent => agent.id === appearanceEdit.agentId)) setAppearanceEdit(null);
  }, [rawAgents, appearanceEdit]);

  useEffect(() => {
    if (stale) return;
    const previous = previousStates.current;
    if (previous?.scope === scope) {
      const changes = agents.filter(agent => previous.states.has(agent.id) && previous.states.get(agent.id) !== agent.state
        && ['done', 'error', 'stopped'].includes(agent.state));
      if (changes.length) setFeedback({ scope, message: changes.map(agent => `${agent.name}：${OFFICE_STATE_LABELS[agent.state]}`).join('；') });
    }
    previousStates.current = { scope, states: new Map(agents.map(agent => [agent.id, agent.state])) };
  }, [agents, scope, stale]);

  useEffect(() => {
    if (mode !== 'demo' || paused || showStudy) return;
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
  }, [mode, paused, showStudy]);

  const changeMode = (next: 'demo' | 'live') => {
    setMode(next);
    setSelectedId(null);
    setMemberQuery('');
    setProcessTarget(null);
    setFocusId(null);
    setPaused(next === 'demo' && elapsedRef.current >= DEMO_DURATION_SECONDS);
    if (next === 'demo') setDemoSeek(value => ({ seconds: elapsedRef.current, revision: value.revision + 1 }));
  };
  const replay = () => {
    elapsedRef.current = 0;
    setElapsed(0);
    setPaused(false);
    setDemoRunKey((value) => value + 1);
    setDemoSeek(value => ({ seconds: 0, revision: value.revision + 1 }));
    previousStates.current = null;
    setFeedback(null);
  };
  const seekDemo = (seconds: number) => {
    if (mode !== 'demo' || !Number.isFinite(seconds)) return;
    const next = Math.min(DEMO_DURATION_SECONDS, Math.max(0, seconds));
    elapsedRef.current = next;
    setElapsed(next);
    setPaused(true);
    setDemoSeek(value => ({ seconds: next, revision: value.revision + 1 }));
    // Seeking backward must not retain a future completion/error announcement.
    previousStates.current = null;
    setFeedback(null);
  };
  const togglePlayback = () => {
    if (mode === 'demo' && paused && elapsedRef.current >= DEMO_DURATION_SECONDS) replay();
    else setPaused((value) => !value);
  };

  if (showStudy) return <div className="agent-office-page"><div className="office-workspace"><Suspense fallback={<p role="status">正在打开角色与工位样板…</p>}><CharacterStudy onClose={() => { setShowStudy(false); setDemoSeek(value => ({ seconds: elapsedRef.current, revision: value.revision + 1 })); }} /></Suspense></div></div>;

  return (
    <div className={`agent-office-page${appearanceEditorOpen ? ' is-editing-appearance' : ''}`} ref={pageElement}>
      <div className="office-workspace" inert={appearanceEdit ? true : undefined}>
        <header className="office-page-heading">
          <div>
            <p className="office-eyebrow">EASEL / COLLABORATIVE STUDIO</p>
            <h1>Agent 办公室<span className="office-heading-mark" aria-hidden="true">✳</span></h1>
            <p className="office-description">小动物同事的协作现场，任务、屏幕与工作过程一目了然。</p>
          </div>
          <div className="office-mode-controls" role="group" aria-label="办公室数据模式">
            <button type="button" onClick={() => setShowStudy(true)}>角色与工位样板 ↗</button>
            <button type="button" aria-pressed={mode === 'demo'} onClick={() => changeMode('demo')}>演示模式</button>
            <button type="button" aria-pressed={mode === 'live'} onClick={() => changeMode('live')}>实时观测</button>
          </div>
        </header>

        <section className={`office-source-strip ${mode === 'demo' ? 'is-demo' : stale ? 'is-stale' : 'is-live'}`} aria-label="办公室数据来源">
          <div className="office-source-copy">
            <span className={`office-mode-badge ${mode}`}><i aria-hidden="true" />{mode === 'demo' ? '演示 · 模拟任务' : stale ? '更新中断 · 上次快照' : '实时观测 · 后台记录'}</span>
            <p>{mode === 'demo' ? `${demoTeamSize} 个角色的协作演示，不代表真实 Agent 调用或执行结果。` : live.coverage || '仅展示当前会话可观察到的后台记录，不补全未上报的角色。'}</p>
          </div>
          {mode === 'demo' && <label className="office-demo-team-select">模拟团队人数
            <select value={demoTeamSize} onChange={event => {
              const size = Number(event.target.value) as OfficeDemoTeamSize;
              if (!OFFICE_DEMO_TEAM_SIZES.includes(size)) return;
              setDemoTeamSize(size); setSelectedId(null); setFocusId(null); setProcessTarget(null); setMemberQuery('');
              setDemoSeek(value => ({ seconds: elapsedRef.current, revision: value.revision + 1 }));
            }}>{OFFICE_DEMO_TEAM_SIZES.map(size => <option key={size} value={size}>{size} 人 · 模拟</option>)}</select>
          </label>}
          {mode === 'live' && <label className="office-session-select">观察会话
            <select value={sessionId ?? ''} disabled={!availableSessions.length} onChange={(event) => { setSessionChoice(event.target.value); setSelectedId(null); setFocusId(null); setMemberQuery(''); }}>
              {!availableSessions.length && <option value="">暂无普通会话</option>}
              {availableSessions.map((session) => <option key={session.id} value={session.id}>{session.title || '未命名会话'}{streams[session.id] ? ' · 对话接收中' : ''}</option>)}
            </select>
          </label>}
        </section>

        <nav className="office-zone-navigation" aria-label="办公室分区">
          <div className="office-zone-summary"><strong>{mode === 'demo' ? `模拟团队共 ${agents.length} 人` : `${stale ? '上次快照' : '已观测'} ${agents.length} 人`}</strong><span>{agents.length ? `第 ${zone.index + 1} / ${zone.count} 区 · 工位 ${zone.start + 1}–${zone.start + zone.agents.length}` : '暂无成员'}</span><small>每区最多 {OFFICE_ZONE_CAPACITY} 人，完整名单可跨区搜索与定位</small></div>
          <div className="office-zone-controls">
            <button type="button" className="office-button" disabled={!agents.length || zone.index === 0} onClick={() => changeZone(zone.index - 1)}>上一分区</button>
            <label>当前分区<select aria-label="切换办公室分区" disabled={!agents.length} value={zone.index} onChange={event => changeZone(Number(event.target.value))}>{Array.from({ length: zone.count }, (_, index) => <option key={index} value={index}>第 {index + 1} 区{agents.length ? ` · ${index * OFFICE_ZONE_CAPACITY + 1}–${Math.min(agents.length, (index + 1) * OFFICE_ZONE_CAPACITY)} 号` : ''}</option>)}</select></label>
            <button type="button" className="office-button" disabled={!agents.length || zone.index + 1 === zone.count} onClick={() => changeZone(zone.index + 1)}>下一分区</button>
          </div>
        </nav>
        {mode === 'live' && live.identityScanLimited && <p className="office-coverage-note" role="status">记录扫描达到范围限制：这里的 {agents.length} 人是本次已观测名单，实际参与人数可能更多。</p>}

        <div className="office-feedback" role="status" aria-live="polite" aria-atomic="true">{feedback?.scope === scope ? `${mode === 'demo' ? '演示反馈' : '最新记录'} · ${feedback.message}` : '点击员工上方状态，查看对应的思考与工作过程。'}</div>

        {mode === 'live' && live.error && <div className="office-observation-error" role="alert">
          <div><strong>更新已中断{agents.length ? '，保留上次快照' : ''}</strong><p>{live.error}{agents.length ? '；下方状态并非当前实时执行状态。' : '；未填入模拟角色。'}</p></div>
          <button type="button" className="office-button" disabled={!sessionId || live.loading} onClick={live.refresh}>重新获取</button>
        </div>}

        <div className="office-layout">
          <section className="office-stage-card" aria-label="3D Agent 办公室">
            <div className="office-stage-toolbar">
              <div className="office-floor-label"><span aria-hidden="true">⌘</span><div><strong>协作工作室{zone.count > 1 ? ` · 第 ${zone.index + 1} 区` : ''}</strong><small>{mode === 'demo' ? 'DEMO FLOOR / 模拟协作' : 'OBSERVATION FLOOR / 记录快照'}</small></div></div>
              <div className="office-stage-actions">
                <button type="button" className="office-button" disabled={!selected} aria-pressed={Boolean(focusId)} onClick={() => setFocusId(focusId ? null : selected?.id || null)}>{focusId ? zone.count > 1 ? '查看当前分区' : '查看全办公室' : '近看选中员工'}</button>
                <button type="button" className="office-button" aria-pressed={paused || stale} disabled={stale} onClick={togglePlayback}><span aria-hidden="true">{paused && !stale ? '▶' : 'Ⅱ'}</span>{stale ? '快照已暂停' : paused ? '播放动画' : '暂停动画'}</button>
                {mode === 'demo' && <button type="button" className="office-button" onClick={replay}><span aria-hidden="true">↺</span>重播演示</button>}
                <button type="button" className="office-button office-view-reset" onClick={() => { setFocusId(null); setResetKey((value) => value + 1); }}><span aria-hidden="true">⌖</span>视角复位</button>
              </div>
            </div>
            <div className="office-demo-navigation" hidden={mode !== 'demo'}>
              {mode === 'demo' && <div className="office-demo-timeline">
                <div className="office-demo-time"><span>{elapsed >= DEMO_DURATION_SECONDS ? '演示完成 · 可重播' : paused ? '演示已暂停' : '模拟协作进行中'}</span><time>{clock(elapsed)} / {clock(DEMO_DURATION_SECONDS)}</time></div>
                <input className="office-demo-seek" type="range" aria-label="模拟任务演示进度" aria-valuetext={`${clock(elapsed)}，${demoPhase.label}${paused ? '，已暂停' : ''}`} min={0} max={DEMO_DURATION_SECONDS} step={0.1} value={elapsed} onChange={event => seekDemo(event.currentTarget.valueAsNumber)} />
                <div className="office-demo-phases" role="group" aria-label="定位演示阶段">{DEMO_PHASES.map(phase => <button key={phase.seconds} type="button" aria-current={demoPhase === phase ? 'step' : undefined} title={`定位到 ${clock(phase.seconds)} 并暂停`} onClick={() => seekDemo(phase.seconds)}>{phase.label}</button>)}</div>
                <p className="office-demo-seek-hint">拖动时间或选择阶段即可暂停查看，点击播放继续。</p>
              </div>}
            </div>
            <div className="office-stage-viewport" ref={previewElement}>
              <AgentOfficeScene agents={zone.agents} selectedId={selected?.id ?? null} onSelect={selectAgent} onOpenProcess={openProcess} focusId={zone.agents.some(agent => agent.id === focusId) ? focusId : null} paused={paused || stale} resetKey={resetKey} demoSeek={mode === 'demo' ? demoSeek : undefined} stale={stale} observedAt={live.observedAt} />
              <div className="office-stage-stamp" aria-hidden="true"><strong>E.</strong><span>{mode === 'demo' ? 'SIMULATION' : 'OBSERVATION'}</span></div>
              {mode === 'live' && !agents.length && <div className="office-scene-notice" role="status">
                <strong>{!sessionId ? '还没有可观察的会话' : live.loading ? '正在读取后台记录' : live.error ? '暂时无法读取协作记录' : '当前没有可观察的 Agent'}</strong>
                <p>{!sessionId ? '备份副本不连接后台。创建普通对话后，可以在这里选择会话。' : live.loading ? '角色只会在收到对应记录后出现。' : '后台尚未提供可核验的角色状态；空工位不会填入模拟任务。'}</p>
              </div>}
            </div>
            {selected && <OfficeWorkPreview agent={selected} stale={stale} observedAt={live.observedAt} onOpen={() => openProcess(selected.id)} />}
            <div className="office-stage-footer" hidden={mode !== 'live'}>
              {mode === 'live' && <div className="office-live-footer"><div><span>{stale ? '上次快照' : live.loading ? '正在更新快照' : '最近观测'}</span><strong>{snapshotTime(live.observedAt)}</strong><small>{stale ? '更新中断时冻结画面，保留上次观察到的状态。' : '暂停仅影响画面动画，后台观测仍会更新。'}</small></div><button type="button" className="office-button" disabled={!sessionId || live.loading} onClick={live.refresh}>{live.loading ? '更新中…' : '刷新记录'}</button></div>}
            </div>
          </section>

          <OfficeOutputMonitor mode={mode} onOpenOutputs={onOpenOutputs} />
          <aside className="office-inspector" aria-label="Agent 任务详情">
            <div className="office-inspector-heading"><div><p className="office-eyebrow">TEAM / 协作成员</p><h2>{agents.length} 个角色<span>{mode === 'demo' ? '模拟' : stale ? '上次快照' : '已观测'}</span></h2></div><span className="office-inspector-symbol" aria-hidden="true">↗</span></div>
            <dl className="office-stats" aria-label={stale ? '上次快照统计' : '角色状态统计'}><div><dt>运行</dt><dd>{running}</dd></div><div><dt>等待</dt><dd>{waiting}</dd></div><div><dt>完成</dt><dd>{done}</dd></div></dl>
            {failed > 0 && <p className="office-failure-count">{failed} 个角色{stale ? '在上次快照中' : ''}记录了错误</p>}
            {selected ? <section className="office-agent-detail" aria-label="选中成员当前任务">
              <div className="office-selected-person"><div className="office-mini-person" aria-hidden="true"><i style={{ background: selected.appearance?.skinColor }} /><span style={{ background: selected.appearance?.shirtColor }} /></div><div><span className="office-seat-label">工位 {String(agents.indexOf(selected) + 1).padStart(2, '0')}</span><h3>{displayName(selected) || '未命名 Agent'}</h3></div><button type="button" className="office-status-button" onClick={() => openProcess(selected.id)} aria-label={`查看${displayName(selected)}的思考与工作过程`}><StateBadge state={selected.state} stale={stale} /><span>查看过程 ↗</span></button></div>
              <p className="office-action-summary" aria-live="polite">{stale ? '上次记录：' : ''}{selected.action?.label}<small>{selected.action?.evidence === 'demo' ? '模拟动作' : stale ? '依据上次快照' : selected.action?.evidence === 'observed' ? '依据后台记录' : '等待具体操作记录'}</small></p>
              <div className="office-current-task"><span>{stale ? '快照中的任务' : '当前任务'}</span><p>{selected.task || '当前记录未提供任务描述。'}</p></div>
              <dl className="office-agent-meta"><div><dt>角色</dt><dd>{selected.role || '未提供'}</dd></div><div><dt>协作上级</dt><dd>{parent?.name || (selected.parentId ? '未包含在当前记录中' : '未提供')}</dd></div><div><dt>记录来源</dt><dd>{selected.source === 'demo' ? '模拟任务脚本' : '后台观察记录'}</dd></div></dl>
              <div className="office-appearance-binding"><label>员工角色卡<select value={selected.appearance?.id || 'generic'} onChange={event => {
                try { const saved = assignEmployeeAppearance(selected.id, event.target.value as EmployeeAppearanceId); setBindingNotice(saved ? '员工角色卡已保存。' : '已在当前窗口应用，但尚未保存到本地。'); }
                catch (error) { setBindingNotice(error instanceof Error ? error.message : '员工绑定未保存。'); }
              }}>{appearances.map(card => <option value={card.id} key={card.id}>{card.name} · {card.role}</option>)}</select></label>
                <button type="button" className="office-button" onClick={() => {
                  if (!selected.appearance) return;
                  scrollBeforeEdit.current = pageElement.current?.scrollTop ?? null;
                  setProcessTarget(null);
                  setBindingNotice('');
                  const original = appearances.find(card => card.id === selected.appearance?.id) || selected.appearance;
                  setAppearanceEdit({ agentId: selected.id, agentName: selected.name, live: selected.source === 'live', original: { ...original }, draft: { ...original } });
                }}>编辑角色卡</button>
                <small>角色卡修改外观与显示名；真实 Agent 身份：{selected.name}（{selected.id}）</small>
                {bindingNotice && <p role="status">{bindingNotice}</p>}
              </div>
              <OfficeAgentControls agent={selected} sessionId={mode === 'live' ? sessionId : null} turnId={mode === 'live' ? live.turnId : null} stale={stale} onChanged={live.refresh} onOpenModelSettings={onOpenModels} />
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
            <div className="office-members-heading"><div><h3>{mode === 'demo' ? '全部模拟成员' : '全部已观测成员'}</h3><span>{filteredMembers.length} / {agents.length} 人 · 点击跨区定位</span></div><label className="office-member-search">搜索完整名单<input type="search" value={memberQuery} onChange={event => setMemberQuery(event.target.value)} placeholder="姓名、ID、任务或状态" /></label>{memberQuery && <button type="button" className="office-button" onClick={() => setMemberQuery('')}>清空搜索</button>}</div>
            <ul className="office-member-list" aria-label="办公室成员">
              {filteredMembers.map(agent => <li key={agent.id}><button type="button" aria-pressed={selected?.id === agent.id} onClick={() => selectAgent(agent.id, true)}>
                <span className="office-member-number" style={{ borderColor: agent.appearance?.shirtColor }}>{String((memberPositions.get(agent.id) ?? 0) + 1).padStart(2, '0')}</span><span className="office-member-name"><strong>{displayName(agent)}</strong><small>第 {Math.floor((memberPositions.get(agent.id) ?? 0) / OFFICE_ZONE_CAPACITY) + 1} 区 · {agent.action?.label || agent.role || '角色未提供'}</small></span><StateBadge state={agent.state} stale={stale} />
              </button></li>)}
              {!filteredMembers.length && <li className="office-member-empty">{agents.length ? '没有匹配成员；可尝试姓名、Agent ID 或任务关键词。' : '收到后台身份记录后，成员会显示在这里。'}</li>}
            </ul>
            <div className="office-inspector-footer">{mode === 'demo' ? <p><span aria-hidden="true">◇</span>演示中的角色、任务和状态均为模拟。</p> : <><button type="button" className="office-open-chat" disabled={!sessionId} onClick={() => { if (sessionId) onOpenChat(sessionId); }}>查看所选会话<span aria-hidden="true">↗</span></button>{onOpenActivity && <button type="button" className="office-open-chat" disabled={!sessionId} onClick={() => { if (sessionId) onOpenActivity(sessionId); }}>查看运行记录<span aria-hidden="true">↗</span></button>}</>}</div>
          </aside>
        </div>
        <footer className="office-page-footnote"><span>EASEL OFFICE · 一起把想法变成作品</span><span>{mode === 'demo' ? '当前为演示空间，不触发模型任务' : '观测已有任务，不在此创建或分派后台任务'}</span></footer>
      </div>
      {appearanceEdit && <OfficeAppearanceEditor draft={appearanceEdit.draft} original={appearanceEdit.original} agentName={appearanceEdit.agentName} agentId={appearanceEdit.agentId} live={appearanceEdit.live}
        sharedCount={agents.filter(agent => agent.appearance?.id === appearanceEdit.original.id).length}
        onChange={draft => setAppearanceEdit(current => current ? { ...current, draft } : current)}
        onCancel={() => setAppearanceEdit(null)}
        onSave={draft => {
          // Merge only this card into the latest store so other edits are retained.
          const saved = saveEmployeeAppearances(readEmployeeAppearances().map(card => card.id === draft.id ? draft : card), { requirePersistence: true });
          if (!saved) throw new Error('尚未保存到本机，草稿仍保留在这里。请检查浏览器存储后再次保存；取消会恢复原来的角色卡。');
          setAppearanceEdit(null);
          setBindingNotice('角色卡已保存，选中员工和机位保持不变。');
        }} />}
      {processAgent && <OfficeProcessPanel agent={processAgent} events={allEvents} session={mode === 'live' ? availableSessions.find(item => item.id === sessionId) : undefined} stream={mode === 'live' && sessionId ? streams[sessionId] : undefined} turnId={mode === 'live' ? live.turnId : null} stale={stale} onClose={() => setProcessTarget(null)} onOpenChat={mode === 'live' && sessionId ? () => onOpenChat(sessionId) : undefined} />}
    </div>
  );
}
