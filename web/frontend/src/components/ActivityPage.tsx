import FailureRecords from './FailureRecords';
import TaskOverview from './TaskOverview';
import { useEffect, useState } from 'react';
import Select from './ui/Select';
import type { ChatSession, StreamState } from '../lib/store';
import { selectActivitySessions, type ActivityFilter, type ActivityTarget } from '../lib/activitySelection';
import UsagePanel from './UsagePanel';
import SkillAuditPanel from './SkillAuditPanel';
import { IconHistory, IconChat, IconTarget, IconWarn, IconCoins, IconFile, IconSkills, IconChart, IconAgentOffice } from './icons';
import { formatChatElapsed } from '../lib/chatTiming';
import { chatErrorTitle } from '../lib/chatErrors';
import '../styles/activity.css';

const RECORD_TABS = [{ id: 'usage', label: '用量概览', icon: IconCoins }, { id: 'requests', label: '调用明细', icon: IconFile }, { id: 'audit', label: '技能核验', icon: IconSkills }] as const;
type Tab = typeof RECORD_TABS[number]['id'];

interface ActivityPageProps {
  sessions: ChatSession[];
  activeSessionId: string | null;
  streams: Record<string, StreamState>;
  target?: ActivityTarget;
  onOpenOffice?: (sessionId: string) => void;
  onOpenChat?: (sessionId:string)=>void;
  onOpenSchedules?: ()=>void;
  onOpenPublish?: ()=>void;
}

const FILTER_LABELS: Record<ActivityFilter, string> = {
  all: '全部',
  running: '运行中',
  archived: '已归档',
};

export default function ActivityPage(props: ActivityPageProps) {
  const [view,setView]=useState<'usage'|'sessions'|'tasks'|'failures'>(props.target ? 'sessions' : 'usage');
  const [localTarget, setLocalTarget] = useState<ActivityTarget>();
  const effectiveTarget = localTarget || props.target;
  const titles = Object.fromEntries(props.sessions.map(s => [s.id, s.title]));
  // A new external turn target starts a fresh view even when the parent keeps
  // this page mounted; old filters must not hide the requested session.
  const targetKey = props.target
    ? JSON.stringify([props.target.sessionId, props.target.turnId])
    : 'default';
  useEffect(()=>{setLocalTarget(undefined);if(targetKey!=='default')setView('sessions');},[targetKey]);
  return <div className="activity-hub">
    <header className="activity-hub-heading"><span className="activity-heading-icon" aria-hidden="true"><IconHistory size={23} /></span><div><h1>运行记录</h1><p>查看 AI 用量、任务进展，或查找失败原因。</p></div><span className="activity-live-count">{Object.keys(props.streams).filter(id => !props.sessions.find(s => s.id === id)?.importedFromBackup).length} 个会话正在运行</span></header>
    <nav className="activity-hub-nav" aria-label="记录入口">{([
      { id: 'usage', label: '全部用量', hint: '项目累计与渠道统计', icon: IconChart },
      { id: 'sessions', label: '会话记录', hint: '按对话查看调用细节', icon: IconChat },
      { id: 'tasks', label: '任务', hint: '目标、定时任务与发布', icon: IconTarget },
      { id: 'failures', label: '问题记录', hint: '失败原因与诊断信息', icon: IconWarn },
    ] as const).map(item => <button key={item.id} type="button" aria-pressed={view === item.id} onClick={() => setView(item.id)}>
      <span className="activity-nav-icon" aria-hidden="true"><item.icon size={20} /></span><span>{item.label}<small>{item.hint}</small></span>
    </button>)}</nav>
    {view === 'usage' ? <section className="activity-project-usage" aria-label="全项目用量"><div className="activity-project-heading"><h2>全部已记录用量</h2><p>汇总当前项目的模型调用；未上报的数据保留未知。</p></div><UsagePanel sessionId="" embedded activityView="project" sessionTitles={titles} isStreaming={Object.keys(props.streams).some(id => !props.sessions.find(s => s.id === id)?.importedFromBackup)} onInspectSession={id => {setLocalTarget({sessionId:id,turnId:''});setView('sessions');}} /></section> : view === 'sessions' ? <ActivityWorkspace key={JSON.stringify(effectiveTarget || 'default')} {...props} target={effectiveTarget} /> : view === 'tasks' ? <TaskOverview onChat={props.onOpenChat} onSchedules={props.onOpenSchedules} onPublish={props.onOpenPublish} /> : <FailureRecords />}
  </div>;
}

function ActivityWorkspace({ sessions, activeSessionId, streams, target, onOpenOffice, onOpenChat }: ActivityPageProps) {
  const [tab, setTab] = useState<Tab>(target?.turnId ? 'audit' : 'usage');
  const [selectedId, setSelectedId] = useState(target?.sessionId || activeSessionId || '');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const importedIds = new Set(sessions.filter((item) => item.importedFromBackup).map((item) => item.id));
  const liveStreams = Object.fromEntries(Object.entries(streams).filter(([id]) => !importedIds.has(id)));
  const { visible, session, missingTarget, targetTurnId } = selectActivitySessions(sessions, liveStreams, {
    search, filter, selectedId, activeSessionId, target,
  });
  const titles = Object.fromEntries(sessions.map((item) => [item.id, item.title]));
  const latestReply = session?.messages.findLast(message => message.role === 'assistant');
  const receiving = Boolean(session && liveStreams[session.id]);
  const latestError = !receiving && !session?.importedFromBackup ? latestReply?.error : undefined;
  const emptyTitle = missingTarget
    ? '指定会话不可用'
    : sessions.length ? '没有匹配会话' : '还没有会话记录';

  function clearFilters() {
    setSearch('');
    setFilter('all');
  }

  return (
    <div className="activity-page">
      <div className="activity-workspace">

        <div className="activity-layout">
          <section className="activity-session-list" aria-label="运行会话筛选">
            <details className="activity-filter-details" open={Boolean(search || filter !== 'all') || undefined}>
            <summary>筛选会话 · {visible.length} / {sessions.length}</summary>
            <div className="activity-session-toolbar">
            <div className="activity-list-heading">
              <h2>会话</h2>
              <span aria-label={`匹配 ${visible.length} 个，共 ${sessions.length} 个会话`}>
                {visible.length} / {sessions.length}
              </span>
            </div>
            <label className="activity-search">
              搜索会话
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="按会话标题查找"
              />
            </label>
            <div className="activity-filters" role="group" aria-label="会话状态">
              {(Object.keys(FILTER_LABELS) as ActivityFilter[]).map((value) => (
                <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                  {FILTER_LABELS[value]}
                </button>
              ))}
            </div>
            </div>
            </details>
            <div className="activity-session-picker">
              <Select aria-label="运行会话" value={session?.id || ''} disabled={!visible.length}
                onChange={setSelectedId} placeholder="选择会话"
                options={visible.map(item=>({ value:item.id, label:item.title,
                  description:`${item.importedFromBackup ? '备份副本' : liveStreams[item.id] ? '运行中' : item.archived ? '已归档' : '已保存'} · ${item.messages.filter(message=>message.role==='user').length} 轮对话` }))} />
              {!visible.length && <p className="usage-empty">{sessions.length ? '没有匹配会话，请调整筛选。' : '还没有会话记录。'}</p>}
            </div>
          </section>

          <main className="activity-detail">
            <div className="activity-detail-heading">
              <div>
                {!session && <h2>{emptyTitle}</h2>}
                {session?.importedFromBackup && <p>备份内容仅供阅读，不作为执行证据。</p>}
              </div>
              <div className="activity-detail-actions">
              {session && onOpenChat && <button type="button" className="btn btn-sm" onClick={() => onOpenChat(session.id)}><IconChat size={15} />打开原对话</button>}
              {session && !session.importedFromBackup && onOpenOffice && <button type="button" className="btn btn-sm" onClick={() => onOpenOffice(session.id)}><IconAgentOffice size={15} />查看办公室</button>}
              {session && (
                  <span className={`activity-session-state${latestError ? ' is-error' : ''}`}><span aria-hidden="true">{latestError ? <IconWarn size={14} /> : <IconHistory size={14} />}</span>{session.importedFromBackup ? '备份副本' : receiving ? '运行中' : latestError ? chatErrorTitle(latestError) : '历史记录'}</span>
              )}
              </div>
            </div>

            {session && <p className="activity-turn-summary">{session.messages.filter(message=>message.role==='user').length} 轮对话
              {!receiving && latestReply?.elapsedMs !== undefined && <> · 最近一轮 {formatChatElapsed(latestReply.elapsedMs)}</>}
            </p>}
            {latestError && <div className="activity-error-summary" role="status">
              <strong><IconWarn size={16} />最近一轮：{chatErrorTitle(latestError)}</strong><p>{latestError.message}</p>
              {(latestError.detail || latestError.stage || latestError.channel || latestError.modelRef) && <details><summary>查看失败详情</summary>
                {latestError.stage && <p>失败阶段：{latestError.stage}</p>}
                {latestError.channel && <p>渠道：{latestError.channel}</p>}
                {latestError.modelRef && <p>模型：{latestError.modelRef}</p>}
                {latestError.detail && <pre>{latestError.detail}</pre>}
              </details>}
            </div>}

            {session?.importedFromBackup ? (
              <div className="activity-start" role="status">
                <h3>备份记录不包含真实后台用量或 Skill 证据</h3>
                <p>这里不会查询原会话的后台记录，也不会将导入内容当作真实调用、Token 用量或 Skill 执行结果。</p>
                {session.backupIncomplete && <p>这是一份未完成的对话快照，不表示任务仍在执行。</p>}
              </div>
            ) : session ? (
              <>
                <div
                  className="activity-section-tabs"
                  role="tablist"
                  aria-label="运行记录分类"
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const index = RECORD_TABS.findIndex(item => item.id === tab);
                    const next = RECORD_TABS[event.key === 'Home' ? 0 : event.key === 'End' ? RECORD_TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + RECORD_TABS.length) % RECORD_TABS.length].id;
                    setTab(next);
                    document.getElementById(`activity-tab-${next}`)?.focus();
                  }}
                >
                  {RECORD_TABS.map(({ id, label, icon: Icon }) => (
                    <button type="button" role="tab" key={id} id={`activity-tab-${id}`}
                      aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
                      aria-controls={`activity-panel-${id === 'audit' ? 'audit' : 'usage'}`} onClick={() => setTab(id)}>
                      <span aria-hidden="true"><Icon size={15} /></span>{label}
                    </button>
                  ))}
                </div>
                <div id={`activity-panel-${tab === 'audit' ? 'audit' : 'usage'}`}  role="tabpanel" aria-labelledby={`activity-tab-${tab}`}>
                  {tab !== 'audit' ? (
                    <UsagePanel
                      key={`${session.id}:${tab}`}
                      sessionId={session.id}
                      refreshKey={session.messages.length}
                      isStreaming={Boolean(liveStreams[session.id])}
                      embedded
                      activityView={tab === 'usage' ? 'overview' : tab}
                      sessionTitles={titles}
                    />
                  ) : (
                    <SkillAuditPanel
                      sessionId={session.id}
                      refreshKey={session.messages.length}
                      isStreaming={Boolean(liveStreams[session.id])}
                      embedded
                      targetTurnId={targetTurnId}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="activity-start" role="status">
                <h3>{missingTarget ? '无法打开指定会话的运行记录' : sessions.length ? '请调整会话筛选' : '从第一轮对话开始'}</h3>
                <p>
                  {missingTarget
                    ? '该会话已删除或不在当前记录中。请从顶部选择其他会话。'
                    : sessions.length
                      ? '当前搜索或状态筛选没有匹配项，请清除筛选后重试。'
                      : '完成对话后，这里会展示服务实际记录的 Token 与执行证据。未上报数据不会替换成 0。'}
                </p>
                {sessions.length > 0 && (
                  <button type="button" className="btn" onClick={() => {
                    clearFilters();
                    if (missingTarget) setSelectedId('');
                  }}>
                    {missingTarget ? '查看全部会话' : '清除筛选'}
                  </button>
                )}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
