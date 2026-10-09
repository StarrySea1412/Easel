import { NativeSelect as Select } from './ui/Select';
import { useEffect, useRef, useState } from 'react';
import type { ChatSession } from '../lib/store';
import type { PersonaItem } from '../lib/api';
import {
  IconChat,
  IconNewChat, IconEdit, IconArchive, IconUnarchive, IconTrash, IconChevron,
  IconDashboard, IconAgentOffice,
} from './icons';
import { IconGear, IconImage } from './settingsIcons';
import SidebarAccountPopover from './SidebarAccountPopover';
import SidebarMoreMenu from './SidebarMoreMenu';
import '../styles/sidebar-shell.css';

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
  onGenerateSessionTitle?: (id: string) => Promise<string>;
  onSessionArchive: (id: string, archived: boolean) => void;
  onNewChat: () => void;
  gatewayStatus: string;
}

const EXPANDED_KEY = 'easel:sidebar-conversations-open-v2';
const TOOLBAR_KEY = 'easel:sidebar-toolbar-expanded-v2';
function readToolbarExpanded() { try { return localStorage.getItem(TOOLBAR_KEY) === 'true'; } catch { return false; } }
function readExpanded(): boolean {
  try { return localStorage.getItem(EXPANDED_KEY) !== 'false'; }
  catch { return true; }
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
  onGenerateSessionTitle,
  onSessionArchive,
  onNewChat,
  gatewayStatus,
}: SidebarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [titleGenerating, setTitleGenerating] = useState(false);
  const [titleError, setTitleError] = useState('');
  const renameContext = useRef({ id: null as string | null, value: '' });
  const renameGeneration = useRef(0);
  const renameEditRevision = useRef(0);
  renameContext.current = { id: renamingId, value: renameValue };
  const [showArchived, setShowArchived] = useState(false);

  const [expanded, setExpanded] = useState(readExpanded);
  const [toolbarExpanded, setToolbarExpanded] = useState(readToolbarExpanded);
  const focusConversationToggle = useRef(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const collapseToggleRef = useRef<HTMLButtonElement>(null);
  const recentRef = useRef<HTMLDivElement>(null);

  const changeExpanded = (next: boolean) => {
    focusConversationToggle.current = true;
    setExpanded(next);
    try { localStorage.setItem(EXPANDED_KEY, String(next)); } catch { /* optional layout preference */ }
  };
  const closeSidebar = () => changeExpanded(false);
  useEffect(() => {
    // Only explicit toggles move focus; restoring the initial layout must not.
    if (!focusConversationToggle.current) return;
    (expanded ? collapseToggleRef : toggleRef).current?.focus({ preventScroll: true });
    focusConversationToggle.current = false;
  }, [expanded]);
  const toggleToolbar = () => { const next=!toolbarExpanded; setToolbarExpanded(next); try { localStorage.setItem(TOOLBAR_KEY,String(next)); } catch { /* optional preference */ } };
  const navigate = (page: Page) => {
    onPageChange(page);
    if (window.matchMedia('(max-width: 760px)').matches) setExpanded(false);
  };
  const selectSession = (id: string) => {
    onSessionSelect(id);
    if (window.matchMedia('(max-width: 760px)').matches) setExpanded(false);
  };
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('.sidebar-account-popover, .sidebar-more-menu, .easel-select-popup') && window.matchMedia('(max-width: 760px)').matches) {
        event.preventDefault(); closeSidebar();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [expanded]);

  const cancelRename = () => { renameGeneration.current++; setRenamingId(null); setTitleGenerating(false); setTitleError(''); };
  useEffect(() => { cancelRename(); }, [activeSessionId, currentPage]);
  const startRename = (s: ChatSession) => { renameGeneration.current++; setRenamingId(s.id); setRenameValue(s.title); setTitleGenerating(false); setTitleError(''); };
  const commitRename = () => {
    if (renamingId) onSessionRename(renamingId, renameValue);
    cancelRename();
  };
  const generateTitle = async (session: ChatSession) => {
    if (!onGenerateSessionTitle || titleGenerating) return;
    const before = { ...renameContext.current };
    const generation = renameGeneration.current;
    const editRevision = renameEditRevision.current;
    setTitleGenerating(true); setTitleError('');
    try {
      const suggestion = await onGenerateSessionTitle(session.id);
      if (renameGeneration.current === generation && renameEditRevision.current === editRevision && renameContext.current.id === before.id && renameContext.current.value === before.value) setRenameValue(suggestion);
    } catch (error) {
      if (renameGeneration.current === generation && renameContext.current.id === before.id) setTitleError(error instanceof Error ? error.message : '命名失败，原标题已保留。');
    } finally { if (renameGeneration.current === generation) setTitleGenerating(false); }
  };

  const active = sessions.filter((s) => !s.archived && (s.messages.length > 0 || s.id === activeSessionId));
  const archived = sessions.filter((s) => s.archived);

  const renderItem = (s: ChatSession, isArchived: boolean) => {
    if (renamingId === s.id) {
      return (
        <div key={s.id} className="session-item session-rename-form">
          <input
            className="session-rename-input"
            value={renameValue}
            autoFocus
            onChange={(e) => { renameEditRevision.current++; setRenameValue(e.target.value); }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              else if (e.key === 'Escape') cancelRename();
            }}
          />
          {onGenerateSessionTitle && !s.importedFromBackup && s.messages.length > 0 && <button type="button" className="session-title-agent"
            disabled={titleGenerating} onMouseDown={event => event.preventDefault()} onClick={() => void generateTitle(s)}
            title="调用已配置的缺省模型，可能产生费用；生成建议后按 Enter 保存，手工编辑优先保留。">
            {titleGenerating ? '命名中…' : 'Agent 命名建议'}
          </button>}
          <button type="button" className="session-title-save" onClick={commitRename}>保存标题</button>
          <button type="button" className="session-title-save" onClick={cancelRename}>取消</button>
          {titleError && <span role="alert" className="session-title-error">{titleError}</span>}
        </div>
      );
    }
    return (
      <div
        key={s.id}
        className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
        onClick={() => selectSession(s.id)}
      >
        <button className="session-item-title session-select" aria-current={currentPage === 'chat' && s.id === activeSessionId ? 'page' : undefined} onClick={(e) => { e.stopPropagation(); selectSession(s.id); }}>{s.title}</button>
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

  const railItem = (page: Page, label: string, icon: React.ReactNode) => <button type="button" className={`nav-item${currentPage===page?' active':''}`} title={label} aria-label={label} aria-current={currentPage===page?'page':undefined} onClick={()=>navigate(page)}><span className="nav-icon" aria-hidden="true">{icon}</span><span className="nav-item-label">{label}</span></button>;
  return (
    <div className={`sidebar-shell${expanded?' is-expanded':''}${toolbarExpanded?' is-toolbar-expanded':''}`}>
      {expanded&&<button type="button" className="sidebar-backdrop" aria-label="关闭侧边栏遮罩" onClick={closeSidebar} tabIndex={-1}/>}
      <aside className={`sidebar sidebar-rail${expanded?' is-expanded':' is-collapsed'}${toolbarExpanded?' is-toolbar-expanded':''}`} aria-label="工作空间导航">
        <div className="sidebar-toolbar">
          <div className="sidebar-toolbar-header">
            <button type="button" className="sidebar-toggle sidebar-tool-toggle" aria-label={toolbarExpanded?'收起工具栏':'展开工具栏'} title={toolbarExpanded?'收起工具栏':'展开工具栏'} aria-expanded={toolbarExpanded} onClick={toggleToolbar}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/><path d={toolbarExpanded?'m16 9-3 3 3 3':'m13 9 3 3-3 3'}/></svg><span className="nav-item-label">工具栏</span>
            </button>
            {!expanded&&<button ref={toggleRef} type="button" className="sidebar-toggle sidebar-conversations-toggle" aria-label="展开对话列表" title="展开对话列表" aria-expanded={false} onClick={()=>changeExpanded(true)}><IconNewChat size={19}/><span className="nav-item-label">对话列表</span></button>}
          </div>
          <nav className="sidebar-nav" aria-label="主导航">
            {railItem('dashboard','工作台',<IconDashboard size={19}/>)}
            {railItem('chat','对话',<IconChat size={19}/>)}
            {railItem('image','生图工坊',<IconImage size={19}/>)}
            <SidebarMoreMenu currentPage={currentPage} onNavigate={navigate}/>
            {railItem('agent-office','Agent 办公室',<IconAgentOffice size={19}/>)}
          </nav>
          <div className="sidebar-toolbar-bottom">
            <SidebarAccountPopover active={currentPage==='accounts'} onNavigate={()=>navigate('accounts')}/>
            {railItem('settings','设置',<IconGear size={19}/>)}
          </div>
        </div>
        {expanded&&<section className="sidebar-conversations" aria-label="对话列表">
          <header className="sidebar-header"><div className="sidebar-topline"><div className="sidebar-logo"><img className="sidebar-logo-icon" src="./static/easel-icon-transparent.png" alt=""/><h1>Easel</h1></div><button ref={collapseToggleRef} type="button" className="sidebar-toggle" aria-label="收起对话列表" title="收起对话列表" aria-expanded={true} onClick={closeSidebar}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16m7 5-3 3 3 3"/></svg></button></div>
            <button type="button" className="new-chat-btn sidebar-new-chat" onClick={()=>{onNewChat();if(window.matchMedia('(max-width:760px)').matches)setExpanded(false);}} title="新建对话"><IconNewChat size={16}/>新建对话</button>
            <Select className="persona-select" aria-label="创作画像" value={selectedPersona} onChange={e=>{if(e.target.value==='__new__'){onNewProfile();return;}onPersonaChange(e.target.value);}} disabled={activeSessionHasMessages} title={activeSessionHasMessages?'当前对话已绑定画像，请先新建对话再切换画像':'选择用户画像'}><option value="">通用模式</option>{personas.map(p=><option key={p.name} value={p.name}>{p.name}</option>)}<option value="__new__">+ 新建画像…</option></Select>
          </header>
          <div className="sidebar-scroll" ref={recentRef}><div className="sidebar-section"><div className="sidebar-section-header"><span className="sidebar-section-title">最近对话</span><span className="sidebar-session-count">{active.length}</span></div>
            {active.map(s=>renderItem(s,false))}
            {!active.length&&<p className="sidebar-empty">还没有最近对话。<br/>新建对话，开始今天的创作。</p>}
            {archived.length>0&&<><button className="archived-header" aria-expanded={showArchived} onClick={()=>setShowArchived(value=>!value)}><span className={`archived-chevron ${showArchived?'open':''}`}><IconChevron size={12}/></span>已归档 · {archived.length}</button>{showArchived&&archived.map(s=>renderItem(s,true))}</>}
          </div></div>
          <div className="sidebar-status" title={gatewayStatus==='connected'?'网关已连接':gatewayStatus==='disconnected'?'网关离线':'连接中…'}><span className={`status-dot ${gatewayStatus==='connected'?'':'offline'}`}/><span className="sidebar-status-label">{gatewayStatus==='connected'?'网关已连接':gatewayStatus==='disconnected'?'网关离线':'连接中…'}</span></div>
        </section>}
      </aside>
    </div>
  );
}
