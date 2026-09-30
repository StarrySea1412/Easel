import { useState } from 'react';
import type { ChatSession, StreamState } from '../lib/store';
import { selectActivitySessions, type ActivityFilter, type ActivityTarget } from '../lib/activitySelection';
import UsagePanel from './UsagePanel';
import SkillAuditPanel from './SkillAuditPanel';
import '../styles/activity.css';

type Tab = 'usage' | 'audit';

interface ActivityPageProps {
  sessions: ChatSession[];
  activeSessionId: string | null;
  streams: Record<string, StreamState>;
  target?: ActivityTarget;
}

const FILTER_LABELS: Record<ActivityFilter, string> = {
  all: '全部',
  running: '运行中',
  archived: '已归档',
};

export default function ActivityPage(props: ActivityPageProps) {
  // A new external turn target starts a fresh view even when the parent keeps
  // this page mounted; old filters must not hide the requested session.
  const targetKey = props.target
    ? JSON.stringify([props.target.sessionId, props.target.turnId])
    : 'default';
  return <ActivityWorkspace key={targetKey} {...props} />;
}

function ActivityWorkspace({ sessions, activeSessionId, streams, target }: ActivityPageProps) {
  const [tab, setTab] = useState<Tab>(target ? 'audit' : 'usage');
  const [selectedId, setSelectedId] = useState(target?.sessionId || activeSessionId || '');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const importedIds = new Set(sessions.filter((item) => item.importedFromBackup).map((item) => item.id));
  const liveStreams = Object.fromEntries(Object.entries(streams).filter(([id]) => !importedIds.has(id)));
  const { visible, session, missingTarget, targetTurnId } = selectActivitySessions(sessions, liveStreams, {
    search, filter, selectedId, activeSessionId, target,
  });
  const titles = Object.fromEntries(sessions.map((item) => [item.id, item.title]));
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
        <header className="activity-heading">
          <div>
            <p className="activity-kicker">ACTIVITY / 运行观测</p>
            <h1>运行记录</h1>
            <p>看清用量，回到调用证据，定位需要关注的运行。</p>
          </div>
          <span className="activity-live-count">{Object.keys(liveStreams).length} 个会话正在运行</span>
        </header>

        <div className="activity-layout">
          <aside className="activity-session-list" aria-label="运行会话筛选">
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
            <div className="activity-session-rows">
              {visible.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={session?.id === item.id ? 'selected' : ''}
                  aria-pressed={session?.id === item.id}
                  onClick={() => setSelectedId(item.id)}
                >
                  <strong>{item.title}</strong>
                  <span>
                    {item.importedFromBackup ? '备份副本' : liveStreams[item.id] ? '运行中' : item.archived ? '已归档' : '已保存'}
                    {' · '}{item.messages.filter((message) => message.role === 'user').length} 轮对话
                  </span>
                </button>
              ))}
              {!visible.length && (
                <p className="usage-empty">{sessions.length ? '没有匹配会话，请调整筛选。' : '还没有会话记录。'}</p>
              )}
            </div>
          </aside>

          <main className="activity-detail">
            <div className="activity-detail-heading">
              <div>
                <p className="activity-kicker">SELECTED SESSION</p>
                <h2>{session?.title || emptyTitle}</h2>
                {session && <p>{session.importedFromBackup ? '备份内容仅供阅读，不作为执行证据。' : '模型用量与 Skill 执行证据分开核验。'}</p>}
              </div>
              {session && (
                <span className="activity-session-state">{session.importedFromBackup ? '备份副本' : liveStreams[session.id] ? '运行中' : '历史记录'}</span>
              )}
            </div>

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
                    const next = event.key === 'Home' ? 'usage' : event.key === 'End' ? 'audit' : tab === 'usage' ? 'audit' : 'usage';
                    setTab(next);
                    document.getElementById(`activity-tab-${next}`)?.focus();
                  }}
                >
                  {(['usage', 'audit'] as const).map((value) => (
                    <button
                      type="button"
                      role="tab"
                      key={value}
                      id={`activity-tab-${value}`}
                      aria-selected={tab === value}
                      tabIndex={tab === value ? 0 : -1}
                      aria-controls={`activity-panel-${value}`}
                      onClick={() => setTab(value)}
                    >
                      {value === 'usage' ? '用量与调用明细' : 'Skill 执行核验'}
                    </button>
                  ))}
                </div>
                <div id={`activity-panel-${tab}`} role="tabpanel" aria-labelledby={`activity-tab-${tab}`}>
                  {tab === 'usage' ? (
                    <UsagePanel
                      key={session.id}
                      sessionId={session.id}
                      refreshKey={session.messages.length}
                      isStreaming={Boolean(liveStreams[session.id])}
                      embedded
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
                    ? '该会话已删除或不在当前记录中。请从左侧选择其他会话。'
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
