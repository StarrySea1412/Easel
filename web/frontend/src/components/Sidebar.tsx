import { useState } from 'react';
import type { ChatSession } from '../lib/store';
import type { PersonaItem } from '../lib/api';
import type { ComponentType } from 'react';
import {
  IconChat, IconSkills, IconOutputs, IconAccounts, IconProfile,
  IconNewChat, IconEdit, IconArchive, IconUnarchive, IconTrash, IconChevron,
  IconDashboard, IconChart,
} from './icons';
import { IconGear, IconImage } from './settingsIcons';

export type Page = 'image' | 'dashboard' | 'chat' | 'trends' | 'ideas' | 'calendar' | 'publish' | 'breakdown' | 'skills' | 'outputs' | 'activity' | 'accounts' | 'analysis' | 'profile' | 'settings';

interface SidebarProps {
  currentPage: Page;
  onPageChange: (page: Page) => void;
  personas: PersonaItem[];
  selectedPersona: string;
  onPersonaChange: (persona: string) => void;
  onNewProfile: () => void;
  sessions: ChatSession[];
  activeSessionId: string | null;
  activeSessionHasMessages: boolean;
  onSessionSelect: (id: string) => void;
  onSessionDelete: (id: string) => void;
  onSessionRename: (id: string, title: string) => void;
  onSessionArchive: (id: string, archived: boolean) => void;
  onNewChat: () => void;
  gatewayStatus: string;
}

// 主导航（精简）；热点雷达/选题库/内容日历/发布中心 收进「工作台」，不占侧栏
const NAV: { page: Page; Icon: ComponentType<{ size?: number }>; label: string }[] = [
  { page: 'dashboard', Icon: IconDashboard, label: '工作台' },
  { page: 'chat', Icon: IconChat, label: '对话' },
  { page: 'image', Icon: IconImage, label: '生图工坊' },
  { page: 'skills', Icon: IconSkills, label: '技能库' },
  { page: 'outputs', Icon: IconOutputs, label: '内容库' },
  { page: 'analysis', Icon: IconChart, label: '内容分析' },
  { page: 'activity', Icon: IconChart, label: '运行记录' },
  { page: 'accounts', Icon: IconAccounts, label: '账号' },
  { page: 'profile', Icon: IconProfile, label: '画像' },
  { page: 'settings', Icon: IconGear, label: '设置' },
];

export default function Sidebar({
  currentPage,
  onPageChange,
  personas,
  selectedPersona,
  onPersonaChange,
  onNewProfile,
  sessions,
  activeSessionId,
  activeSessionHasMessages,
  onSessionSelect,
  onSessionDelete,
  onSessionRename,
  onSessionArchive,
  onNewChat,
  gatewayStatus,
}: SidebarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const startRename = (s: ChatSession) => { setRenamingId(s.id); setRenameValue(s.title); };
  const commitRename = () => {
    if (renamingId) onSessionRename(renamingId, renameValue);
    setRenamingId(null);
  };

  const active = sessions.filter((s) => !s.archived && (s.messages.length > 0 || s.id === activeSessionId));
  const archived = sessions.filter((s) => s.archived);

  const renderItem = (s: ChatSession, isArchived: boolean) => {
    if (renamingId === s.id) {
      return (
        <div key={s.id} className="session-item">
          <input
            className="session-rename-input"
            value={renameValue}
            autoFocus
            onChange={(e) => setRenameValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              else if (e.key === 'Escape') setRenamingId(null);
            }}
            onBlur={commitRename}
          />
        </div>
      );
    }
    return (
      <div
        key={s.id}
        className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
        onClick={() => onSessionSelect(s.id)}
      >
        <button className="session-item-title session-select" aria-current={currentPage === 'chat' && s.id === activeSessionId ? 'page' : undefined} onClick={(e) => { e.stopPropagation(); onSessionSelect(s.id); }}>{s.title}</button>
        <div className="session-actions">
          <button className="session-act" title="重命名"
            onClick={(e) => { e.stopPropagation(); startRename(s); }}><IconEdit size={14} /></button>
          <button className="session-act" title={isArchived ? '取消归档' : '归档'}
            onClick={(e) => { e.stopPropagation(); onSessionArchive(s.id, !isArchived); }}>
            {isArchived ? <IconUnarchive size={14} /> : <IconArchive size={14} />}
          </button>
          <button className="session-act danger" title="删除"
            onClick={(e) => { e.stopPropagation(); onSessionDelete(s.id); }}><IconTrash size={14} /></button>
        </div>
      </div>
    );
  };

  return (
    <aside className="sidebar" aria-label="工作空间导航">
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <img className="sidebar-logo-icon" src="./static/easel-icon-transparent.png" alt="" />
          <h1>Easel</h1>
          <span className="sidebar-edition">STUDIO</span>
        </div>
        <select
          className="persona-select"
          aria-label="创作画像"
          value={selectedPersona}
          onChange={(e) => {
            if (e.target.value === '__new__') { onNewProfile(); return; }
            onPersonaChange(e.target.value);
          }}
          disabled={activeSessionHasMessages}
          title={activeSessionHasMessages ? '当前对话已绑定画像，请先新建对话再切换画像' : '选择用户画像'}
        >
          <option value="">通用模式</option>
          {personas.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
          <option value="__new__">+ 新建画像…</option>
        </select>
      </div>

      <nav className="sidebar-nav" aria-label="主导航">
        {NAV.map(({ page, Icon, label }) => (
          <button
            key={page}
            className={`nav-item ${currentPage === page ? 'active' : ''}`}
            aria-current={currentPage === page ? 'page' : undefined}
            onClick={() => onPageChange(page)}
          >
            <span className="nav-icon"><Icon size={18} /></span>
            {label}
          </button>
        ))}
      </nav>

      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-title">最近对话</span>
          <button className="new-chat-btn" onClick={onNewChat} title="新建对话">
            <IconNewChat size={13} /> 新对话
          </button>
        </div>
        {active.map((s) => renderItem(s, false))}
        {active.length === 0 && <p className="sidebar-empty">想法从一段对话开始。<br />新建对话，开启今天的创作。</p>}

        {archived.length > 0 && (
          <>
            <button className="archived-header" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
              <span className={`archived-chevron ${showArchived ? 'open' : ''}`}><IconChevron size={12} /></span>
              已归档 · {archived.length}
            </button>
            {showArchived && archived.map((s) => renderItem(s, true))}
          </>
        )}
      </div>

      <div className="sidebar-status">
        <span className={`status-dot ${gatewayStatus === 'connected' ? '' : 'offline'}`} />
        {gatewayStatus === 'connected'
          ? '网关已连接'
          : gatewayStatus === 'disconnected'
            ? '网关离线'
            : '连接中…'}
      </div>
    </aside>
  );
}
