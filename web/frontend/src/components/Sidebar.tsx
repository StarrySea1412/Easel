import { NativeSelect as Select } from './ui/Select';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatSession } from '../lib/store';
import type { PersonaItem } from '../lib/api';
import {
  IconChat,
  IconNewChat, IconChevron,
  IconDashboard, IconAgentOffice, IconOpenClaw,
  IconLoader, IconPublish,
} from './icons';
import { IconGear, IconImage, IconMoon, IconSun } from './settingsIcons';
import { readTheme, setThemePreference, subscribeTheme } from '../lib/theme';
import { showToast } from '../lib/toast';
import SidebarAccountPopover from './SidebarAccountPopover';
import SidebarMoreMenu from './SidebarMoreMenu';
import AppVersion from './AppVersion';
import SessionActionsMenu, { SessionPinIcon } from './SessionActionsMenu';
import SessionHoverCard from './SessionHoverCard';
import {sessionStatuses} from '../lib/sessionStatus';
import type {SessionStatusKind} from '../lib/sessionStatus';
import {readSeenStatuses, subscribeSeenStatuses} from '../lib/seenStatus';
import type {TaskSnapshot} from '../lib/tasks';
import '../styles/sidebar-shell.css';

export type Page = 'automation' | 'image' | 'dashboard' | 'chat' | 'trends' | 'ideas' | 'calendar' | 'publish' | 'breakdown' | 'skills' | 'outputs' | 'activity' | 'agent-office' | 'accounts' | 'analysis' | 'profile' | 'settings';

interface SidebarProps {
  eventNotifications?: React.ReactNode;
  currentPage: Page;
  onPageChange: (page: Page, preserveConversations?: boolean) => void;
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
  onGatewayRetry?: () => void;
  runningSessions?: string[];
  stoppingSessions?: string[];
  taskState?: TaskSnapshot;
}

export default function Sidebar({
  eventNotifications,
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
  onGatewayRetry,
  runningSessions = [],
  stoppingSessions = [],
  taskState,
}: SidebarProps) {
  // 辅助对话（子会话）只在侧边面板里出现，不进主列表。
  const listedSessions = sessions.filter((s) => !s.parentSessionId);
  // 已读状态（lib/seenStatus）是外部存储：终态点“看过即清除”，变化时重算角标。
  const seenStatuses = useSyncExternalStore(subscribeSeenStatuses, readSeenStatuses);
  const statuses = useMemo(
    () => sessionStatuses(listedSessions, runningSessions, stoppingSessions, taskState, seenStatuses),
    [listedSessions, runningSessions, stoppingSessions, taskState, seenStatuses]);
  const runningCount=[...statuses.values()].filter(s=>s.kind==='running'||s.kind==='stopping').length;
  // “对话”入口总览：与列表同一套状态（进行中用 loading 图标、其余用状态点），
  // 按紧急度排序，紧凑展示（≤3 全显示，超出取前 2 加“+N”），摘要供 hover/读屏。
  const STATUS_PRIORITY: SessionStatusKind[]=['running','stopping','failed','blocked','review','waiting','unconfirmed','queued','paused','stopped','completed'];
  const statusOverview=[...statuses.entries()].map(([id,state])=>({id,state}))
    .sort((a,b)=>STATUS_PRIORITY.indexOf(a.state.kind)-STATUS_PRIORITY.indexOf(b.state.kind));
  const overviewShown=statusOverview.length<=3?statusOverview:statusOverview.slice(0,2);
  const overviewHidden=statusOverview.length-overviewShown.length;
  const overviewSummary=(()=>{const counts=new Map<string,number>();for(const {state} of statusOverview)counts.set(state.label,(counts.get(state.label)??0)+1);return [...counts].map(([label,n])=>n>1?`${label} ${n}`:label).join(' · ');})();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamePlace, setRenamePlace] = useState<'row'|'preview'>('row');
  const [renameValue, setRenameValue] = useState('');
  const [titleGenerating, setTitleGenerating] = useState(false);
  const [titleError, setTitleError] = useState('');
  const renameContext = useRef({ id: null as string | null, value: '' });
  const renameGeneration = useRef(0);
  const renameEditRevision = useRef(0);
  renameContext.current = { id: renamingId, value: renameValue };
  const [showArchived, setShowArchived] = useState(false);
  const [hoveredSession, setHoveredSession] = useState<{ session: ChatSession; anchor: HTMLElement } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previewEditing = useRef(false);
  previewEditing.current = Boolean(renamingId && renamePlace === 'preview');
  const restoreRenameFocus = useRef<string|null>(null);
  const cancelRename = useCallback((restore=false) => { if(restore)restoreRenameFocus.current=renameContext.current.id;renameGeneration.current++; setRenamingId(null); setTitleGenerating(false); setTitleError(''); },[]);
  const keepHover = () => clearTimeout(hoverTimer.current);
  const leaveHover = () => {
    keepHover();
    hoverTimer.current=setTimeout(()=>{if(!previewEditing.current)setHoveredSession(null);},180);
  };
  const openHover = (session:ChatSession,anchor:HTMLElement) => {keepHover();if(!previewEditing.current)setHoveredSession({session,anchor});};
  useEffect(()=>()=>clearTimeout(hoverTimer.current),[]);

  // Layout starts compact on every mount; old saved expansion must not reopen it.
  const [expanded, setExpanded] = useState(false);
  const previousPage = useRef(currentPage);
  const [toolbarExpanded, setToolbarExpanded] = useState(false);
  const focusConversationToggle = useRef(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const collapseToggleRef = useRef<HTMLButtonElement>(null);
  const recentRef = useRef<HTMLDivElement>(null);
  const conversationsRef = useRef<HTMLElement>(null);
  useLayoutEffect(()=>{
    if(renamingId||!restoreRenameFocus.current)return;
    const row=Array.from(conversationsRef.current?.querySelectorAll<HTMLElement>('[data-session-id]')||[]).find(item=>item.dataset.sessionId===restoreRenameFocus.current);
    restoreRenameFocus.current=null;
    row?.querySelector<HTMLButtonElement>('.session-select')?.focus({preventScroll:true});
  },[renamingId,sessions]);
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
    clearTimeout(hoverTimer.current);
    if(!next)cancelRename();
    focusConversationToggle.current = true;
    setExpanded(next);
  }, [cancelRename]);
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
    // Page changes start compact unless explicit chat navigation preserves the list.
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
  const navigate = (page: Page, preserveConversations = false) => {
    if (preserveConversations) {
      changeExpanded(true);
      onPageChange(page, true);
      return;
    }
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

  useEffect(() => { cancelRename(); }, [activeSessionId, currentPage,cancelRename]);
  const startRename = (s: ChatSession,place:'row'|'preview'='row') => { keepHover();if(place==='row')setHoveredSession(null);renameGeneration.current++; setRenamePlace(place);setRenamingId(s.id); setRenameValue(s.title); setTitleGenerating(false); setTitleError(''); };
  const commitRename = () => {
    const title=renameValue.trim();
    if(!title){setTitleError('标题不能为空，请输入名称或取消。');return;}
    if (renamingId) onSessionRename(renamingId, title);
    cancelRename(true);
  };
  useEffect(()=>{
    if(!hoveredSession)return;
    const outside=(event:PointerEvent)=>{
      const target=event.target as Node;
      if(hoveredSession.anchor.closest('.session-item')?.contains(target)||document.querySelector('.session-hover-card')?.contains(target))return;
      keepHover();setHoveredSession(null);
      if(previewEditing.current)cancelRename();
    };
    document.addEventListener('pointerdown',outside);
    return()=>document.removeEventListener('pointerdown',outside);
  },[hoveredSession,cancelRename]);
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

  const active = listedSessions.filter((s) => !s.archived && (s.pinnedAt || s.messages.length > 0 || s.id === activeSessionId));
  const pinned = active.filter(s => s.pinnedAt).sort((a, b) => a.pinnedAt! - b.pinnedAt!);
  const recent = active.filter(s => !s.pinnedAt);
  const archived = listedSessions.filter((s) => s.archived);

  const renameForm = (s:ChatSession,floating=false) => (
        <div key={s.id} className={`session-rename-form ${floating?'session-hover-editor':'session-item'}`}>
          <input
            className="session-rename-input"
            aria-label="对话名称"
            maxLength={200}
            value={renameValue}
            autoFocus
            onChange={(e) => { renameEditRevision.current++; setRenameValue(e.target.value);setTitleError(''); }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if(e.nativeEvent.isComposing||e.keyCode===229)return;
              if (e.key === 'Enter') {e.preventDefault();commitRename();}
              else if (e.key === 'Escape') {e.preventDefault();e.stopPropagation();cancelRename(true);}
            }}
          />
          {onGenerateSessionTitle && !s.importedFromBackup && s.messages.length > 0 && <button type="button" className="session-title-agent"
            disabled={titleGenerating} onMouseDown={event => event.preventDefault()} onClick={() => void generateTitle(s)}
            title="调用已配置的缺省模型，可能产生费用；生成建议后按 Enter 保存，手工编辑优先保留。">
            {titleGenerating ? '命名中…' : 'Agent 命名建议'}
          </button>}
          <button type="button" className="session-title-save" onClick={commitRename}>保存标题</button>
          <button type="button" className="session-title-save" onClick={()=>cancelRename(true)}>取消</button>
          {titleError && <span role="alert" className="session-title-error">{titleError}</span>}
        </div>
      );
  const renderItem = (s: ChatSession, isArchived: boolean) => {
    if (renamingId === s.id&&renamePlace==='row')return renameForm(s);
    const state=statuses.get(s.id);
    return (
      <div
        key={s.id}
        data-session-id={s.id}
        className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
        onClick={() => selectSession(s.id)}
        onPointerEnter={keepHover}
        onPointerLeave={leaveHover}
        onClickCapture={()=>setHoveredSession(null)}
        onFocusCapture={event=>{if(!(event.target as HTMLElement).classList.contains('session-select'))setHoveredSession(null);}}
        onPointerOver={event=>{if(!(event.target as HTMLElement).closest('.session-select')&&!previewEditing.current)setHoveredSession(null);}}
      >
        <div className="session-row-content">{state&&<span className={`session-status-badge is-${state.kind}`} title={`${state.label}：${state.detail}`} aria-label={state.kind==='running'?'正在对话':state.kind==='stopping'?'正在停止':state.label}>
          {state.kind==='running'||state.kind==='stopping'?<IconLoader size={10} strokeWidth={2.2} className="session-running-indicator"/>:<span className="session-status-dot" aria-hidden="true" />}
          <span className="session-status-label">{state.label}</span>
        </span>}<button className="session-item-title session-select" title="单击打开 · 双击重命名（F2）" aria-current={currentPage === 'chat' && s.id === activeSessionId ? 'page' : undefined} onPointerEnter={event=>{if(event.pointerType!=='touch')openHover(s,event.currentTarget);}} onFocus={event=>openHover(s,event.currentTarget)} onBlur={event=>{if(!(event.relatedTarget as HTMLElement)?.closest('.session-hover-card'))setHoveredSession(null);}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setHoveredSession(null);}if(event.key==='F2'){event.preventDefault();startRename(s);}}} onClick={(e) => { e.stopPropagation(); selectSession(s.id); }} onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); startRename(s); }}>{s.title}</button></div>
        {!isArchived && <button type="button" className={`session-quick-pin${s.pinnedAt?' is-pinned':''}`} aria-label={`${s.pinnedAt?'取消置顶':'置顶'}对话：${s.title}`} title={s.pinnedAt?'取消置顶':'置顶'} onPointerEnter={()=>setHoveredSession(null)} onClick={event=>{event.stopPropagation();pinFocusId.current=s.id;onSessionPin(s.id,!s.pinnedAt);}}><SessionPinIcon unpin={Boolean(s.pinnedAt)}/></button>}
        <SessionActionsMenu session={s} onPin={() => { setHoveredSession(null);pinFocusId.current = s.id; onSessionPin(s.id, !s.pinnedAt); }}
          onRename={() => startRename(s)} onArchive={() => onSessionArchive(s.id, !isArchived)} onDelete={() => onSessionDelete(s.id)} />
      </div>
    );
  };

  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  const themeNext: 'light' | 'dark' = theme.resolved === 'dark' ? 'light' : 'dark';
  const toggleTheme = () => {
    setThemePreference(themeNext);
    if (!readTheme().persisted) showToast(`主题已切换为${themeNext === 'dark' ? '深色' : '浅色'}，但未能保存到本机。`, 'error');
  };
  const railItem = (page: Page, label: string, icon: React.ReactNode) => <button type="button" className={`nav-item${currentPage===page?' active':''}`} title={page==='chat'&&overviewSummary?`${label} · ${overviewSummary}`:label} aria-label={label} aria-description={page==='chat'&&overviewSummary?`对话总览：${overviewSummary}`:undefined} aria-current={currentPage===page?'page':undefined} onClick={()=>navigate(page, page === 'chat')}><span className="nav-icon" aria-hidden="true">{icon}{page==='chat'&&statusOverview.length>0&&<span className="sidebar-status-overview">
    {overviewShown.map(({id,state})=><span key={id} className={`session-status-badge is-${state.kind}`} title={`${state.label}：${state.detail}`}>
      {state.kind==='running'||state.kind==='stopping'?<IconLoader size={10} strokeWidth={2.2} className="session-running-indicator"/>:<span className="session-status-dot"/>}
    </span>)}
    {overviewHidden>0&&<span className="sidebar-overview-more">+{overviewHidden}</span>}
  </span>}</span><span className="nav-item-label">{label}</span></button>;
  return (
    <div className={`sidebar-shell${expanded?' is-expanded':''}${toolbarExpanded?' is-toolbar-expanded':''}`}>
      {expanded&&<button type="button" className="sidebar-backdrop" aria-label="关闭侧边栏遮罩" onClick={closeSidebar} tabIndex={-1}/>}
      <aside className={`sidebar sidebar-rail${expanded?' is-expanded':' is-collapsed'}${toolbarExpanded?' is-toolbar-expanded':''}`} aria-label="工作空间导航">
        <div className="sidebar-toolbar">
          <div className="sidebar-toolbar-header">
            <button type="button" className="sidebar-toggle sidebar-tool-toggle" aria-label={toolbarExpanded?'收起工具栏':'展开工具栏'} title={toolbarExpanded?'收起工具栏':'展开工具栏'} aria-expanded={toolbarExpanded} onClick={toggleToolbar}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/><path d={toolbarExpanded?'m16 9-3 3 3 3':'m13 9 3 3-3 3'}/></svg><span className="nav-item-label">工具栏</span>
            </button>
            {!expanded&&<button ref={toggleRef} type="button" className="sidebar-toggle sidebar-conversations-toggle" aria-label="展开对话列表" title={`展开对话列表 · ${runningCount}个正在运行`} aria-expanded={false} onClick={()=>changeExpanded(true)}><IconNewChat size={19}/><span className="nav-item-label">对话列表</span></button>}
          </div>
          <nav className="sidebar-nav" aria-label="主导航">
            {railItem('dashboard','工作台',<IconDashboard size={19}/>)}
            {railItem('chat','对话',<IconChat size={19}/>)}
            {railItem('image','生图工坊',<IconImage size={19}/>)}
            {railItem('publish','内容发布',<IconPublish size={19}/>)}
            {railItem('automation','定时任务',<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2M17 4l2-2M5 4 3 2"/></svg>)}
            <SidebarMoreMenu currentPage={currentPage} onNavigate={navigate}/>
            {railItem('agent-office','Agent 办公室',<IconAgentOffice size={19}/>)}
          </nav>
          <div className="sidebar-toolbar-bottom">
            <button type="button" className={`sidebar-gateway-status ${gatewayStatus}`} aria-label={gatewayStatus==='connected'?'OpenClaw 网关已连接':gatewayStatus==='disconnected'?'OpenClaw 网关离线，点击重试':'OpenClaw 网关正在连接'} title={gatewayStatus==='connected'?'OpenClaw 网关已连接':gatewayStatus==='disconnected'?'OpenClaw 网关离线，点击立即重试':'OpenClaw 网关正在重连…'} onClick={onGatewayRetry} disabled={!onGatewayRetry || gatewayStatus==='connecting'}>
              <span className="sidebar-gateway-icon" aria-hidden="true"><IconOpenClaw size={20}/><span className="status-dot"/></span><span className="nav-item-label">OpenClaw · {gatewayStatus==='connected'?'已连接':gatewayStatus==='disconnected'?'已离线':'重连中…'}</span>
            </button>
            <SidebarAccountPopover active={currentPage==='accounts'} onNavigate={()=>navigate('accounts')}/>
            {eventNotifications}
            <button type="button" className="nav-item sidebar-theme-toggle" aria-label={`主题：当前${theme.resolved==='dark'?'深色':'浅色'}${theme.preference==='system'?'（跟随系统）':''}，点击切换为${themeNext==='dark'?'深色':'浅色'}`} title={`切换为${themeNext==='dark'?'深色':'浅色'}模式（当前${theme.resolved==='dark'?'深色':'浅色'}${theme.preference==='system'?'，跟随系统':''}；更多外观选项在设置 → 更多设置）`} onClick={toggleTheme}>
              <span className="nav-icon" aria-hidden="true">{theme.resolved==='dark'?<IconSun size={19}/>:<IconMoon size={19}/>}</span><span className="nav-item-label">{themeNext==='dark'?'深色':'浅色'}</span>
            </button>
            {railItem('settings','设置',<IconGear size={19}/>)}
            <AppVersion/>
          </div>
        </div>
        {expanded&&<section ref={conversationsRef} className="sidebar-conversations" aria-label="对话列表">
          <header className="sidebar-header"><div className="sidebar-topline"><div className="sidebar-logo"><img className="sidebar-logo-icon" src="./static/easel-icon-transparent.png" alt=""/><h1>Easel</h1></div><button ref={collapseToggleRef} type="button" className="sidebar-toggle" aria-label="收起对话列表" title="收起对话列表" aria-expanded={true} onClick={closeSidebar}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16m7 5-3 3 3 3"/></svg></button></div>
            <button type="button" className="new-chat-btn sidebar-new-chat" onClick={onNewChat} title="新建对话"><IconNewChat size={16}/>新建对话</button>
            <Select className="persona-select" aria-label="创作画像" value={selectedPersona} onChange={e=>{if(e.target.value==='__new__'){onNewProfile();return;}onPersonaChange(e.target.value);}} disabled={activeSessionHasMessages} title={activeSessionHasMessages?'当前对话已绑定画像，请先新建对话再切换画像':'选择用户画像'}><option value="">通用模式</option>{personas.map(p=><option key={p.name} value={p.name}>{p.name}</option>)}<option value="__new__">+ 新建画像…</option></Select>
            <div className="sidebar-run-summary" role="status" aria-label={`正在运行的对话：${runningCount}`} title="按对话去重，包含尚未停止确认及已归档的执行；排队和待核实不计入"><span className={runningCount?'is-running':''}/><strong>{runningCount}</strong> 个运行中</div>
          </header>
          <div className="sidebar-scroll" ref={recentRef}><div className="sidebar-section">
            {pinned.length > 0 && <section className="sidebar-pinned" aria-label="置顶对话"><div className="sidebar-section-header"><span className="sidebar-section-title">置顶</span><span className="sidebar-session-count">{pinned.length}</span></div>{pinned.map(s=>renderItem(s,false))}</section>}
            <section className="sidebar-recent" aria-label="最近对话"><div className="sidebar-section-header"><span className="sidebar-section-title">最近对话</span><span className="sidebar-session-count">{recent.length}</span></div>
            {recent.map(s=>renderItem(s,false))}
            {!active.length&&<p className="sidebar-empty">还没有最近对话。<br/>新建对话，开始今天的创作。</p>}
            </section>
            {archived.length>0&&<><button className="archived-header" aria-expanded={showArchived} onClick={()=>setShowArchived(value=>!value)}><span className={`archived-chevron ${showArchived?'open':''}`}><IconChevron size={12}/></span>已归档 · {archived.length}</button>{showArchived&&archived.map(s=>renderItem(s,true))}</>}
          </div></div>
        </section>}
      </aside>
      {expanded && hoveredSession && <SessionHoverCard key={hoveredSession.session.id} session={sessions.find(s=>s.id===hoveredSession.session.id)||hoveredSession.session} anchor={hoveredSession.anchor} onRename={()=>startRename(sessions.find(s=>s.id===hoveredSession.session.id)||hoveredSession.session,'preview')} editor={renamingId===hoveredSession.session.id&&renamePlace==='preview'?renameForm(hoveredSession.session,true):undefined} onPointerEnter={keepHover} onPointerLeave={leaveHover} onDismiss={()=>{cancelRename();hoveredSession.anchor.focus({preventScroll:true});setHoveredSession(null);}}/>}
    </div>
  );
}
