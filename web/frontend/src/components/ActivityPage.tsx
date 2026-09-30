import { useState } from 'react';
import type { ChatSession, StreamState } from '../lib/store';
import UsagePanel from './UsagePanel';
import SkillAuditPanel from './SkillAuditPanel';

type Tab = 'usage' | 'audit';
const TABS: { id: Tab; label: string }[] = [
  { id: 'usage', label: 'Token 用量' }, { id: 'audit', label: 'Skill 核验' },
];

export default function ActivityPage({ sessions, activeSessionId, streams }: {
  sessions: ChatSession[];
  activeSessionId: string | null;
  streams: Record<string, StreamState>;
}) {
  const [tab, setTab] = useState<Tab>('usage');
  const [selectedId, setSelectedId] = useState(activeSessionId || '');
  const session = sessions.find((item) => item.id === selectedId)
    || sessions.find((item) => item.id === activeSessionId) || sessions[0];
  const titles = Object.fromEntries(sessions.map((item) => [item.id, item.title]));

  return <div className="activity-page" style={{ padding: '28px clamp(16px, 3vw, 36px)', overflowY: 'auto', width: '100%', minWidth: 0 }}>
    <header>
      <h1 className="page-title">运行记录</h1>
      <p className="page-subtitle">按会话查看模型用量、Skill 调用证据和效果评估。</p>
    </header>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, margin: '24px 0 18px' }}>
      <div className="usage-tabs" role="tablist" aria-label="运行记录分类" onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'usage' : event.key === 'End' ? 'audit' : tab === 'usage' ? 'audit' : 'usage';
        setTab(next);
        document.getElementById(`activity-tab-${next}`)?.focus();
      }}>
        {TABS.map((item) => <button key={item.id} type="button" role="tab" id={`activity-tab-${item.id}`}
          aria-selected={tab === item.id} aria-controls={`activity-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
          onClick={() => setTab(item.id)}>{item.label}</button>)}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: '100%', fontSize: 13, color: 'var(--text-secondary)' }}>
        <span style={{ flexShrink: 0 }}>查看会话</span>
        <select className="persona-select" aria-label="运行记录会话" value={session?.id || ''} disabled={!sessions.length}
          style={{ margin: 0, maxWidth: 'min(360px, 65vw)' }} onChange={(event) => setSelectedId(event.target.value)}>
          {!sessions.length && <option value="">暂无会话</option>}
          {sessions.map((item) => <option key={item.id} value={item.id}>{item.title}{item.archived ? '（已归档）' : ''}</option>)}
        </select>
      </label>
    </div>
    <div id={`activity-panel-${tab}`} role="tabpanel" aria-labelledby={`activity-tab-${tab}`}>
      {session ? tab === 'usage'
        ? <UsagePanel key={session.id} sessionId={session.id} refreshKey={session.messages.length}
          isStreaming={!!streams[session.id]} embedded sessionTitles={titles} />
        : <SkillAuditPanel sessionId={session.id} refreshKey={session.messages.length}
          isStreaming={!!streams[session.id]} embedded />
        : <p className="usage-empty">暂无可查看的会话。开始对话后，可在这里查看运行记录。</p>}
    </div>
  </div>;
}
