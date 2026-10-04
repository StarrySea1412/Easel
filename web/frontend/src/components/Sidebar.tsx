import { useState } from 'react';
import type { ChatSession } from '../lib/store';
import type { PersonaItem } from '../lib/api';
import type { ComponentType } from 'react';
import {
  IconChat, IconSkills, IconOutputs, IconAccounts, IconProfile,
  IconNewChat, IconEdit, IconArchive, IconUnarchive, IconTrash, IconChevron,
  IconDashboard, IconChart, IconHistory, IconAgentOffice,
} from './icons';
import { IconGear, IconImage } from './settingsIcons';

export type Page = 'image' | 'dashboard' | 'chat' | 'trends' | 'ideas' | 'calendar' | 'publish' | 'breakdown' | 'skills' | 'outputs' | 'activity' | 'agent-office' | 'accounts' | 'analysis' | 'profile' | 'settings';

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

// 主导航按使用动线分组：创作放最上，对话永远第一眼可见；工具/观测/配置可折叠。
// 热点雷达、选题库、内容日历、发布中心、拆爆款仍收进「工作台」，不占侧栏。
type NavGroupKey = 'create' | 'tools' | 'observe' | 'config';
const NAV_GROUPS: { key: NavGroupKey; label: string; items: { page: Page; Icon: ComponentType<{ size?: number }>; label: string }[] }[] = [
  {
    key: 'create', label: '创作',
    items: [
      { page: 'dashboard', Icon: IconDashboard, label: '工作台' },
      { page: 'chat', Icon: IconChat, label: '对话' },
      { page: 'image', Icon: IconImage, label: '生图工坊' },
    ],
  },
  {
    key: 'tools', label: '工具',
    items: [
      { page: 'skills', Icon: IconSkills, label: '技能库' },
      { page: 'outputs', Icon: IconOutputs, label: '内容库' },
      { page: 'analysis', Icon: IconChart, label: '内容分析' },
    ],
  },
  {
    key: 'observe', label: '观测',
    items: [
      { page: 'activity', Icon: IconHistory, label: '运行记录' },
      { page: 'agent-office', Icon: IconAgentOffice, label: 'Agent 办公室' },
    ],
  },
  {
    key: 'config', label: '配置',
    items: [
      { page: 'accounts', Icon: IconAccounts, label: '账号' },
      { page: 'profile', Icon: IconProfile, label: '画像' },
      { page: 'settings', Icon: IconGear, label: '设置' },
    ],
  },
];
const COLLAPSE_KEY = 'easel_nav_collapsed';
const DEFAULT_COLLAPSED: NavGroupKey[] = ['config'];

function readCollapsed(): Set<NavGroupKey> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(COLLAPSE_KEY) || 'null');
    if (Array.isArray(raw) && raw.every(k => NAV_GROUPS.some(g => g.key === k))) return new Set(raw);
  } catch { /* invalid stored state falls back to defaults */ }
  return new Set(DEFAULT_COLLAPSED);
}

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
  const [collapsed, setCollapsed] = useState<Set<NavGroupKey>>(readCollapsed);

  // The group containing the current page never hides its items.
  const activeGroup = NAV_GROUPS.find(group => group.items.some(item => item.page === currentPage))?.key;
  const isCollapsed = (key: NavGroupKey) => collapsed.has(key) && key !== activeGroup;
  const toggleGroup = (key: NavGroupKey) => {
    if (key === activeGroup) return;
    setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { sessionStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next])); } catch { /* optional persistence */ }
      return next;
    });
  };

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
        {NAV_GROUPS.map(group => (
          <div key={group.key} className="nav-group">
            <button
              type="button"
              className="nav-group-toggle"
              aria-expanded={!isCollapsed(group.key)}
              onClick={() => toggleGroup(group.key)}
            >
              <span className="nav-group-label">{group.label}</span>
              <span className={`nav-group-chevron ${isCollapsed(group.key) ? 'is-collapsed' : ''}`} aria-hidden="true"><IconChevron size={12} /></span>
            </button>
            {!isCollapsed(group.key) && group.items.map(({ page, Icon, label }) => (
              <button
                key={page}
                type="button"
                className={`nav-item ${currentPage === page ? 'active' : ''}`}
                title={label}
                aria-label={label}
                aria-current={currentPage === page ? 'page' : undefined}
                onClick={() => onPageChange(page)}
              >
                <span className="nav-icon" aria-hidden="true"><Icon size={18} /></span>
                {label}
              </button>
            ))}
          </div>
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
