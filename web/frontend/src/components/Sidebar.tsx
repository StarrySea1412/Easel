import { NativeSelect as Select } from './ui/Select';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatSession } from '../lib/store';
import type { PersonaItem } from '../lib/api';
import {
  IconChat,
  IconNewChat, IconChevron,
  IconDashboard, IconAgentOffice,
} from './icons';
import { IconGear, IconImage } from './settingsIcons';
import SidebarAccountPopover from './SidebarAccountPopover';
import SidebarMoreMenu from './SidebarMoreMenu';
import SessionActionsMenu, { SessionPinIcon } from './SessionActionsMenu';
import SessionHoverCard from './SessionHoverCard';
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
  onSessionPin: (id: string, pinned: boolean) => void;
  onNewChat: () => void;
  gatewayStatus: string;
  runningSessions?: string[];
  stoppingSessions?: string[];
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
  onSessionPin,
  onNewChat,
  gatewayStatus,
  runningSessions = [],
  stoppingSessions = [],
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
  const [hoveredSession, setHoveredSession] = useState<{ session: ChatSession; anchor: HTMLElement } | null>(null);

  // Layout starts compact on every mount; old saved expansion must not reopen it.
  const [expanded, setExpanded] = useState(false);
  const previousPage = useRef(currentPage);
  const [toolbarExpanded, setToolbarExpanded] = useState(false);
  const focusConversationToggle = useRef(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const collapseToggleRef = useRef<HTMLButtonElement>(null);
  const recentRef = useRef<HTMLDivElement>(null);
  const conversationsRef = useRef<HTMLElement>(null);
  const pinFocusId = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!pinFocusId.current) return;
    const row = Array.from(conversationsRef.current?.querySelectorAll<HTMLElement>('[data-session-id]') || [])
      .find(item => item.dataset.sessionId === pinFocusId.current);
    row?.querySelector<HTMLButtonElement>('.session-menu-trigger')?.focus({ preventScroll: true });
    pinFocusId.current = null;
  }, [sessions]);

  const changeExpanded = useCallback((next: boolean) => {
    setHoveredSession(null);
    focusConversationToggle.current = true;
    setExpanded(next);
  }, []);
  const closeSidebar = useCallback(() => changeExpanded(false), [changeExpanded]);
  useEffect(() => {
    const collapse = (event: Event) => {
      const navigation = (event as CustomEvent<{ page?: Page; preserveConversations?: boolean }>).detail;
      if (navigation?.preserveConversations) {
        if (navigation.page) previousPage.current = navigation.page;
        return;
      }
      if (conversationsRef.current?.contains(document.activeElement)) focusConversationToggle.current = true;
      setExpanded(false);
    };
    window.addEventListener('easel:page-navigation', collapse);
    return () => window.removeEventListener('easel:page-navigation', collapse);
  }, []);
  useEffect(() => {
    if (previousPage.current === currentPage) return;
    previousPage.current = currentPage;
    // Every destination starts compact, including a return to chat.
    if (conversationsRef.current?.contains(document.activeElement)) focusConversationToggle.current = true;
    setExpanded(false);
  }, [currentPage]);
  useEffect(() => {
    // Only explicit toggles move focus; restoring the initial layout must not.
    if (!focusConversationToggle.current) return;
    (expanded ? collapseToggleRef : toggleRef).current?.focus({ preventScroll: true });
    focusConversationToggle.current = false;
  }, [expanded]);
  const toggleToolbar = () => setToolbarExpanded((previous) => !previous);
  const navigate = (page: Page) => {
    setExpanded(false);
    onPageChange(page);
  };
  const selectSession = (id: string) => {
    onSessionSelect(id);
  };
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('.sidebar-account-popover, .sidebar-more-menu, .session-menu, .easel-select-popup') && window.matchMedia('(max-width: 760px)').matches) {
        event.preventDefault(); closeSidebar();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [expanded, closeSidebar]);

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

  const active = sessions.filter((s) => !s.archived && (s.pinnedAt || s.messages.length > 0 || s.id === activeSessionId));
  const pinned = active.filter(s => s.pinnedAt).sort((a, b) => a.pinnedAt! - b.pinnedAt!);
  const recent = active.filter(s => !s.pinnedAt);
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
        data-session-id={s.id}
        className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
        onClick={() => selectSession(s.id)}
        onPointerLeave={()=>setHoveredSession(null)}
        onClickCapture={()=>setHoveredSession(null)}
        onFocusCapture={event=>{if(!(event.target as HTMLElement).classList.contains('session-select'))setHoveredSession(null);}}
        onPointerOver={event=>{if(!(event.target as HTMLElement).closest('.session-select'))setHoveredSession(null);}}
      >
        <button className="session-item-title session-select" aria-current={currentPage === 'chat' && s.id === activeSessionId ? 'page' : undefined} onPointerEnter={event=>{if(event.pointerType!=='touch')setHoveredSession({session:s,anchor:event.currentTarget});}} onFocus={event=>setHoveredSession({session:s,anchor:event.currentTarget})} onBlur={()=>setHoveredSession(null)} onKeyDown={event=>{if(event.key==='Escape')setHoveredSession(null);}} onClick={(e) => { e.stopPropagation(); selectSession(s.id); }}>{s.title}</button>
        {!s.importedFromBackup && (runningSessions.includes(s.id) || stoppingSessions.includes(s.id)) && <span className="session-running-indicator" role="status" aria-label={stoppingSessions.includes(s.id) ? '正在停止' : '正在对话'} title={stoppingSessions.includes(s.id) ? '正在停止' : '正在对话'} />}
        {!isArchived && <button type="button" className={`session-quick-pin${s.pinnedAt?' is-pinned':''}`} aria-label={`${s.pinnedAt?'取消置顶':'置顶'}对话：${s.title}`} title={s.pinnedAt?'取消置顶':'置顶'} onPointerEnter={()=>setHoveredSession(null)} onClick={event=>{event.stopPropagation();pinFocusId.current=s.id;onSessionPin(s.id,!s.pinnedAt);}}><SessionPinIcon unpin={Boolean(s.pinnedAt)}/></button>}
        <SessionActionsMenu session={s} onPin={() => { setHoveredSession(null);pinFocusId.current = s.id; onSessionPin(s.id, !s.pinnedAt); }}
          onRename={() => startRename(s)} onArchive={() => onSessionArchive(s.id, !isArchived)} onDelete={() => onSessionDelete(s.id)} />
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
        {expanded&&<section ref={conversationsRef} className="sidebar-conversations" aria-label="对话列表">
          <header className="sidebar-header"><div className="sidebar-topline"><div className="sidebar-logo"><img className="sidebar-logo-icon" src="./static/easel-icon-transparent.png" alt=""/><h1>Easel</h1></div><button ref={collapseToggleRef} type="button" className="sidebar-toggle" aria-label="收起对话列表" title="收起对话列表" aria-expanded={true} onClick={closeSidebar}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16m7 5-3 3 3 3"/></svg></button></div>
            <button type="button" className="new-chat-btn sidebar-new-chat" onClick={onNewChat} title="新建对话"><IconNewChat size={16}/>新建对话</button>
            <Select className="persona-select" aria-label="创作画像" value={selectedPersona} onChange={e=>{if(e.target.value==='__new__'){onNewProfile();return;}onPersonaChange(e.target.value);}} disabled={activeSessionHasMessages} title={activeSessionHasMessages?'当前对话已绑定画像，请先新建对话再切换画像':'选择用户画像'}><option value="">通用模式</option>{personas.map(p=><option key={p.name} value={p.name}>{p.name}</option>)}<option value="__new__">+ 新建画像…</option></Select>
          </header>
          <div className="sidebar-scroll" ref={recentRef}><div className="sidebar-section">
            {pinned.length > 0 && <section className="sidebar-pinned" aria-label="置顶对话"><div className="sidebar-section-header"><span className="sidebar-section-title">置顶</span><span className="sidebar-session-count">{pinned.length}</span></div>{pinned.map(s=>renderItem(s,false))}</section>}
            <section className="sidebar-recent" aria-label="最近对话"><div className="sidebar-section-header"><span className="sidebar-section-title">最近对话</span><span className="sidebar-session-count">{recent.length}</span></div>
            {recent.map(s=>renderItem(s,false))}
            {!active.length&&<p className="sidebar-empty">还没有最近对话。<br/>新建对话，开始今天的创作。</p>}
            </section>
            {archived.length>0&&<><button className="archived-header" aria-expanded={showArchived} onClick={()=>setShowArchived(value=>!value)}><span className={`archived-chevron ${showArchived?'open':''}`}><IconChevron size={12}/></span>已归档 · {archived.length}</button>{showArchived&&archived.map(s=>renderItem(s,true))}</>}
          </div></div>
          <div className="sidebar-status" title={gatewayStatus==='connected'?'网关已连接':gatewayStatus==='disconnected'?'网关离线':'连接中…'}><span className={`status-dot ${gatewayStatus==='connected'?'':'offline'}`}/><span className="sidebar-status-label">{gatewayStatus==='connected'?'网关已连接':gatewayStatus==='disconnected'?'网关离线':'连接中…'}</span></div>
        </section>}
      </aside>
      {expanded && hoveredSession && <SessionHoverCard key={hoveredSession.session.id} session={hoveredSession.session} anchor={hoveredSession.anchor}/>}
    </div>
  );
}
