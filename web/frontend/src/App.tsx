import { saveAnalysisChatResult, type AnalysisBinding, type AnalysisChatRequest } from './lib/analysisConversations';
import { prepareWriting, writingSession, seedWritingDraft } from './lib/writingHandoff';
import { analysisRequest } from './lib/contentAnalysis';
import { analyticsScope } from './lib/analyticsCache';
import { savePanelTools } from './lib/chatPanels';
import { confirmModal } from './components/ui/ConfirmModal';
import FailureRecordDialog from './components/FailureRecordDialog';
import { chatErrorDetail } from './lib/chatErrors';
import { pickMergeTarget } from './lib/sessionMerge';
import { lastExchangeQuote, sideChatOf, sideChatsOf, sideChatTitle } from './lib/sideChat';
import { createConversationShare, fetchShareAppends, mergeShareAppends } from './lib/conversationShare';
import { taskRequest, mergeTaskSessions, taskInspectionSessions, type TaskSessionState, type SessionTombstone } from './lib/tasks';
import { useTaskSnapshot } from './hooks/useTaskSnapshot';
import {syncConversations, readServerConversation, readServerConversations, mergeServerConversation} from './lib/conversationSync';
import { taskWorkspaceHash, parseTaskWorkspaceHash, isScheduleWorkspaceHash } from './lib/taskWorkspace';
import { editBranchPlan, editBranchSeed, remapEditedMessage } from './lib/chatEditing';
import { prepareChatBranch } from './lib/api';
import { decodeChatTiming, finishChatTiming } from './lib/chatTiming';
import { decodeChatReasoning, type ChatReasoning } from './lib/chatReasoning';
import { shouldKeepChatQuestion } from './lib/chatQuestionStatus';
import type { ChatTiming } from './lib/chatTiming';
import { drainStreamRun } from './lib/streamLifecycle';
import { createLazyPage } from './lib/lazyPage';
import StorageNotice from './components/StorageNotice';
import { useImageStudio } from './hooks/useImageStudio';
import { useVideoStudio } from './hooks/useVideoStudio';
import { useDemoDataPreference } from './hooks/useDemoDataPreference';
import { usePublishReceipts } from './hooks/usePublishReceipts';
import PublishReceiptCenter from './components/PublishReceiptCenter';
import { parsePublishReceiptHash, publishReceiptHash } from './lib/publishReceiptNavigation';
import { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from 'react';
import Sidebar from './components/Sidebar';
import CreationWorkspaceHost from './components/CreationWorkspaceHost';
import CreationWorkspaceSlot from './components/CreationWorkspaceSlot';
import { creationSessionDeleted, currentCreation, creationRevision, subscribeCreation, selectCreation, requestCreationPanel } from './lib/creationWorkspace';
import ToastHost from './components/ToastHost';
import EventNotificationCenter from './components/EventNotificationCenter';
import { notificationOutputPath, removeSessionEvents, startEventSync } from './lib/eventNotifications';
import { noticeSubject } from './lib/noticeFormat';
import { markSessionSeenById } from './lib/seenStatus';
import SkillDrawer from './components/SkillDrawer';
import { showToast } from './lib/toast';
import { steerQueuedMessage } from './lib/chatSteering';
import type { Page } from './components/Sidebar';
import DashboardPage from './components/DashboardPage';
import SubNav from './components/SubNav';
import OnboardingWizard from './components/OnboardingWizard';
import type { SettingsSection } from './components/SettingsPanel';
import type { OfficeTaskRequest } from './components/agent-office/OfficeTaskComposer';
import { fetchStatus, fetchPersonas, streamChat, fetchLastTurn, stopChat } from './lib/api';
import { ensureGateway } from './lib/gatewayRecovery';
import { codexRequest } from './lib/codex';
import { CODEX_RECOVERED, applyCodexResult } from './lib/codexRecovery';
import type { PersonaItem, UploadedFile, ChatQuestion, ThinkingLevel } from './lib/api';
import { questionStatus } from './lib/api';
import { deleteSession as deleteRemoteSession } from './lib/api';
import {
  loadSessions,
  saveSessions,
  setSessionPinned,
  createSession,
  updateSessionTitle,
  loadActiveId,
  saveActiveId,
} from './lib/store';
import type { ChatSession, ChatMessage, StreamState } from './lib/store';
import { rememberOutputReferences, markOutputSessionDeleted, outputSessionDeleted } from './lib/outputReferences';
import { displayName } from './lib/skillDisplayNames';
import { createConversationBackup, createImportedSessions, type ConversationBackup } from './lib/conversationBackup';
import { exportRawConversationStorage } from './lib/conversationStorageBackup';
import { addChatDraftQuote, clearChatDraft, getChatDraft, setChatDraftText } from './lib/chatDrafts';
import { analysisChatMessage, defaultAnalysisRequest } from './lib/analysisComposer';
import { enqueueChat, getChatQueue, getQueueRevision, subscribeChatQueue, dispatchQueuedMessage, dispatchSelectedQueuedMessage, pauseChatQueue, clearChatQueue } from './lib/chatQueue';
import { requirementsForSelection, writeSelectedSkills, writeSkillRequirements } from './lib/selectedSkills';
import type { SkillRequirements } from './lib/selectedSkills';
import { requestConversationTitle } from './lib/conversationTitles';
import { adoptBreakdownRun, createBreakdownSession, loadSessionsWithBreakdown, rememberBreakdownReport } from './lib/breakdownChat';
import { buildBreakdownReportPrompt } from './lib/breakdownReport';
import type { ActiveRun } from './lib/breakdownStore';

const AutomationPage = createLazyPage('目标与定时任务', () => import('./components/AutomationPage'));
const TaskWorkspacePage = createLazyPage('任务工作区', () => import('./components/TaskWorkspacePage'));
const ChatPage = createLazyPage('对话', () => import('./components/ChatPage'));
const SkillPage = createLazyPage('技能库', () => import('./components/SkillPage'));
const OutputsPage = createLazyPage('内容库', () => import('./components/OutputsPage'));
const ActivityPage = createLazyPage('运行记录', () => import('./components/ActivityPage'));
const AgentOfficePage = createLazyPage('Agent 办公室', () => import('./components/AgentOfficePage'));
const AccountsPage = createLazyPage('账号', () => import('./components/AccountsPage'));
const PublishReceiptsPage = createLazyPage('发布回执', () => import('./components/PublishReceiptsPage'));
const ContentAnalysisPage = createLazyPage('内容分析', () => import('./components/ContentAnalysisPage'));
const ProfilePage = createLazyPage('画像', () => import('./components/ProfilePage'));
const TrendsPage = createLazyPage('热点雷达', () => import('./components/TrendsPage'));
const CalendarPage = createLazyPage('内容日历', () => import('./components/CalendarPage'));
const IdeasPage = createLazyPage('选题库', () => import('./components/IdeasPage'));
const BreakdownPage = createLazyPage('爆款拆解', () => import('./components/BreakdownPage'));
const SettingsPanel = createLazyPage('设置', () => import('./components/SettingsPanel'));

const ONBOARDING_SEEN_KEY = 'easel_onboarding_seen';

function onboardingSeen(): boolean {
  try {
    const current = localStorage.getItem(ONBOARDING_SEEN_KEY);
    if (current) return true;
    const previousKey = `${['post', 'craft'].join('')}_onboarding_seen`;
    const previous = localStorage.getItem(previousKey);
    if (!previous) return false;
    try {
      localStorage.setItem(ONBOARDING_SEEN_KEY, previous);
      localStorage.removeItem(previousKey);
    } catch { /* Keep the previous marker if migration cannot be saved. */ }
    return true;
  } catch { return false; }
}

function markOnboardingSeen() {
  try { localStorage.setItem(ONBOARDING_SEEN_KEY, '1'); } catch { /* Optional preference. */ }
}

export default function App() {
  useSyncExternalStore(subscribeCreation, creationRevision);
  useEffect(() => startEventSync(), []);
  const [currentPage, setPageState] = useState<Page>('dashboard');
  const [taskTarget,setTaskTarget] = useState<string|undefined>(()=>parseTaskWorkspaceHash(window.location.hash)?.goalId);
  const setCurrentPage = useCallback((page: Page, preserveConversations = false) => {
    const hash = window.location.hash;
    const routedPage = ['tasks', 'automation', 'publish-receipts'].includes(page);
    if (!routedPage && (parseTaskWorkspaceHash(hash) || isScheduleWorkspaceHash(hash) || parsePublishReceiptHash(hash))) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    if (page === 'tasks' && !parseTaskWorkspaceHash(window.location.hash)) { setTaskTarget(undefined); window.location.hash = taskWorkspaceHash(); }
    if (page === 'automation' && !isScheduleWorkspaceHash(window.location.hash)) window.location.hash = '#/schedules';
    if (page === 'publish-receipts' && !parsePublishReceiptHash(window.location.hash)) window.location.hash = publishReceiptHash();
    window.dispatchEvent(new window.CustomEvent('easel:page-navigation', { detail: { page, preserveConversations } }));
    setPageState(page);
  }, []);
  useEffect(()=>{
    const navigateTasks=()=>{
      const route=parseTaskWorkspaceHash(window.location.hash);
      if(route){setTaskTarget(route.goalId);setCurrentPage('tasks');}
      else if(isScheduleWorkspaceHash(window.location.hash))setCurrentPage('automation');
      else setPageState(page=>page==='tasks'||page==='automation'?'dashboard':page);
    };
    window.addEventListener('hashchange',navigateTasks);navigateTasks();
    return()=>window.removeEventListener('hashchange',navigateTasks);
  },[setCurrentPage]);
  const imageStudio = useImageStudio(currentPage === 'image' && !currentCreation('image').sessionId);
  const videoStudio = useVideoStudio(currentPage === 'image');
  const demoDataPreference = useDemoDataPreference();
  const receiptState = usePublishReceipts();
  const { open: openReceiptState } = receiptState;
  const openReceipts = useCallback((receiptId?: unknown) => {
    openReceiptState(receiptId);
    window.location.hash = publishReceiptHash(receiptId);
    setCurrentPage('publish-receipts');
  }, [openReceiptState, setCurrentPage]);
  const publishReceipts = { ...receiptState, open: openReceipts };
  useEffect(() => {
    const navigateReceipts = () => {
      const route = parsePublishReceiptHash(window.location.hash);
      if (route) { openReceiptState(route.receiptId); setCurrentPage('publish-receipts'); }
      else if (!window.location.hash || window.location.hash === '#') setPageState(page => page === 'publish-receipts' ? 'publish' : page);
    };
    window.addEventListener('hashchange', navigateReceipts);
    navigateReceipts();
    return () => window.removeEventListener('hashchange', navigateReceipts);
  }, [openReceiptState, setCurrentPage]);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('model');
  const [settingsModelRef, setSettingsModelRef] = useState<string>();
  const [skillConfiguration, setSkillConfiguration] = useState<string>();
  useEffect(() => {
    const open = (event: Event) => {
      const channel = (event as CustomEvent<unknown>).detail;
      if (typeof channel !== 'string' || !['chat', 'transcribe', 'speech', 'image', 'video', 'music', 'notify'].includes(channel)) return;
      setSettingsModelRef(undefined);
      setSettingsSection(channel === 'notify' ? 'notify' : `channel:${channel}` as SettingsSection);
      setSettingsNavigationKey(key => key + 1);
      setCurrentPage('settings');
    };
    window.addEventListener('easel:open-skill-settings', open);
    return () => window.removeEventListener('easel:open-skill-settings', open);
  }, []);
  useEffect(() => {
    const open = (event: Event) => {
      const name = (event as CustomEvent<unknown>).detail;
      if (typeof name === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(name)) setSkillConfiguration(name);
    };
    window.addEventListener('easel:open-skill-configuration', open);
    return () => window.removeEventListener('easel:open-skill-configuration', open);
  }, []);
  const [settingsNavigationKey, setSettingsNavigationKey] = useState(0);
  const [analysisPlatform, setAnalysisPlatform] = useState('xiaohongshu');
  const [analysisAutoCollect, setAnalysisAutoCollect] = useState(0);
  const [outputFilter, setOutputFilter] = useState('');
  const [outputJumpPath, setOutputJumpPath] = useState('');
  const [automationDraft, setAutomationDraft] = useState<{objective?:string;title?:string}|null>(null);
  useEffect(() => {
    const navigateOutput = () => {
      if (!window.location.hash.startsWith('#/outputs/')) return;
      try {
        const parts = window.location.hash.slice('#/outputs/'.length).split('/').map(decodeURIComponent);
        if (parts.some(part => part === '.' || part === '..' || /[\\\u0000]/.test(part))) return;
        setOutputJumpPath(parts.join('/'));
        setOutputFilter('all');
        setCurrentPage('outputs');
      } catch { /* malformed links leave the current page intact */ }
    };
    window.addEventListener('hashchange', navigateOutput);
    navigateOutput();
    return () => window.removeEventListener('hashchange', navigateOutput);
  }, [setCurrentPage]);
  const [personas, setPersonas] = useState<PersonaItem[]>([]);
  const [selectedPersona, setSelectedPersona] = useState('');
  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessionsWithBreakdown());
  useEffect(() => { rememberOutputReferences(sessions); }, [sessions]);
  const [sessionsLoading, setSessionsLoading] = useState(() => loadSessions().length === 0);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [gatewayStatus, setGatewayStatus] = useState('connecting');
  const [runtime, setRuntime] = useState('openclaw');
  const [gatewayRecoveryNote, setGatewayRecoveryNote] = useState('');
  const [gatewayRetryToken, setGatewayRetryToken] = useState(0);
  const [showRecommend, setShowRecommend] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const stopRequests = useRef<Record<string, object>>({});
  const [stoppingSessions, setStoppingSessions] = useState<Record<string, boolean>>({});
  const [stopErrors, setStopErrors] = useState<Record<string, string>>({});

  // 挂载时决定进哪个会话。规则：
  //  - 同一标签刷新（sessionStorage 记着本标签的会话）→ 直接续上（同标签不算冲突）。
  //  - 新开标签/窗口 → 若「上次活跃会话」正被另一个存活标签占用（跨标签 BroadcastChannel 探测），
  //    则开一个新会话，避免两个窗口撞同一会话 → openclaw 并发 takeover 崩溃（后端还有 flock 兜底）。
  //  - 否则续上上次会话（保留「关页重开续接」的体验）。
  const TAB_SESSION_KEY = 'easel_tab_session';
  useEffect(() => {
    const existing = loadSessions();
    let ch: BroadcastChannel | null = null;
    try { ch = new BroadcastChannel('easel-session'); } catch { ch = null; }

    const settle = (id: string | null, sess: ChatSession[]) => {
      setSessions(sess);
      setActiveSessionId(id);
      const s = sess.find((x) => x.id === id);
      if (s) setSelectedPersona(s.persona || '');
      try {
        if (id) sessionStorage.setItem(TAB_SESSION_KEY, id);
        else sessionStorage.removeItem(TAB_SESSION_KEY);
      } catch { /* ignore */ }
      if (id) ch?.postMessage({ type: 'claim', sessionId: id });
    };
    const openNew = (sess: ChatSession[]) => {
      const ns = createSession();
      const updated = [ns, ...sess];
      saveSessions(updated);
      settle(ns.id, updated);
    };

    // 持久监听：别的标签问「谁在用会话 X」时，若正是本标签当前会话就应答 owned
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; sessionId?: string } | null;
      if (d?.type === 'query' && d.sessionId && d.sessionId === activeIdRef.current) {
        ch?.postMessage({ type: 'owned', sessionId: d.sessionId });
      }
    };
    ch?.addEventListener('message', onMsg);

    // 1) 本标签刷新：续本标签原会话
    let tabOwn: string | null = null;
    try { tabOwn = sessionStorage.getItem(TAB_SESSION_KEY); } catch { tabOwn = null; }
    if (tabOwn && existing.find((s) => s.id === tabOwn)) {
      settle(tabOwn, existing);
      return () => { ch?.removeEventListener('message', onMsg); ch?.close(); };
    }

    // 2) 新标签：候选=上次活跃会话；先跨标签问有没有别的活标签占着它
    const lastId = loadActiveId();
    const candidate = lastId && existing.find((s) => s.id === lastId && !s.archived) ? lastId : null;
    if (candidate && ch) {
      let taken = false;
      const probe = (e: MessageEvent) => {
        const d = e.data as { type?: string; sessionId?: string } | null;
        if (d?.type === 'owned' && d.sessionId === candidate) taken = true;
      };
      ch.addEventListener('message', probe);
      ch.postMessage({ type: 'query', sessionId: candidate });
      const t = setTimeout(() => {
        ch?.removeEventListener('message', probe);
        if (taken) openNew(existing);      // 另一个窗口在用 → 开新会话
        else settle(candidate, existing);  // 没人占 → 续上
      }, 250);
      return () => { clearTimeout(t); ch?.removeEventListener('message', probe); ch?.removeEventListener('message', onMsg); ch?.close(); };
    }

    // 3) 仅有归档时保留空白入口，刷新不生成同名的最近会话。
    if (candidate) {
      settle(candidate, existing);
    } else {
      const available = existing.find((s) => !s.archived && s.messages.length === 0)
        || existing.find((s) => !s.archived);
      if (available) settle(available.id, existing);
      else if (existing.length) settle(null, existing);
      else openNew(existing);
    }
    return () => { ch?.removeEventListener('message', onMsg); ch?.close(); };
  }, []);

  // 持久化当前活跃会话 id，重开网页据此续接上次对话（修复"今天再问就忘了"）。
  // 仅在非空时写：避免挂载首刷 activeSessionId 尚为 null 时误清掉已存的 id。
  // 同时更新本标签的 sessionStorage 标记：手动切会话/新建后刷新本标签仍续在正确会话上。
  useEffect(() => {
    if (activeSessionId) {
      saveActiveId(activeSessionId);
      try { sessionStorage.setItem(TAB_SESSION_KEY, activeSessionId); } catch { /* ignore */ }
    }
  }, [activeSessionId]);

  const retryGateway = useCallback(() => {
    setGatewayStatus('connecting');
    setGatewayRetryToken(value => value + 1);
  }, []);

  // Offline recovery starts only the local gateway; messages are never replayed.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => { if (!cancelled) timer = setTimeout(probe, delay); };
    const probe = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      setGatewayStatus(previous => previous === 'connected' ? previous : 'connecting');
      try {
        const data = await fetchStatus();
        if (cancelled) return;
        setRuntime(data.runtime || 'openclaw');
        setPersonas(data.personas || []);
        if (data.gateway) {
          setGatewayStatus('connected');setGatewayRecoveryNote('');
          if (attempt > 0) window.dispatchEvent(new Event('easel:channel-names-changed'));
        } else if (data.runtime === 'openclaw') {
          const recovery=await ensureGateway();
          if(cancelled)return;
          setGatewayRecoveryNote(recovery.note);
          setGatewayStatus(recovery.state==='starting'?'connecting':recovery.state==='connected'?'connected':'disconnected');
        } else setGatewayStatus('disconnected');
        attempt = data.gateway ? 0 : attempt + 1;
        // 首次使用：没有任何个性化画像 且 未看过引导 → 推荐配置
        if ((data.personas || []).length === 0 && !onboardingSeen()) {
          setShowRecommend(true);
        }
        schedule(data.gateway ? 15000 : Math.min(30000, 3000 * 2 ** Math.min(attempt - 1, 3)));
      } catch {
        if (cancelled) return;
        setGatewayStatus('disconnected');
        attempt += 1;
        schedule(Math.min(30000, 3000 * 2 ** Math.min(attempt - 1, 3)));
      } finally {
        inFlight = false;
      }
    };
    void probe();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [gatewayRetryToken]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || null;

  // 最新 sessions 的 ref，供回调里读取而不必进依赖数组（避免闭包过期/频繁重建）
  const sessionsRef = useRef(sessions);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => {
    const timer = setTimeout(() => { void syncConversations([...sessions].sort((a,b) => Number(b.id === activeSessionId) - Number(a.id === activeSessionId))); }, 350);
    return () => clearTimeout(timer);
  }, [sessions, activeSessionId]);
  useEffect(() => {
    const timer = setInterval(() => { void syncConversations(sessionsRef.current); }, 15000);
    return () => clearInterval(timer);
  }, []);
  const {snapshot:tasks,sessions:taskSessions,sync:taskSync,refresh:refreshTasks}=useTaskSnapshot();
  const inspectionSessions=useMemo(()=>taskInspectionSessions(sessions,tasks.runs,tasks.goals),[sessions,tasks.runs,tasks.goals]);
  const synchronizedDeleted=useRef(new Set<string>());
  useEffect(()=>{
    const deleted=tasks.deletedSessions||[];
    if(!taskSessions&&!deleted.length)return;
    const ids=new Set(deleted.map(row=>row.id)),isDeleted=(id:string)=>ids.has(id)||outputSessionDeleted(id);
    if(deleted.some(row=>!synchronizedDeleted.current.has(row.id)))rememberOutputReferences(sessionsRef.current);
    for(const row of deleted)if(!synchronizedDeleted.current.has(row.id)){markOutputSessionDeleted(row.id);removeSessionEvents(row.id);synchronizedDeleted.current.add(row.id);}
    setSessions(old=>{const next=mergeTaskSessions(old,taskSessions||[],isDeleted);if(next!==old)saveSessions(next);return next;});
    setActiveSessionId(current=>current&&isDeleted(current)&&!sessionsRef.current.find(s=>s.id===current)?.importedFromBackup?null:current);
  },[taskSessions,tasks.deletedSessions]);
  useEffect(()=>{if(!taskSync.loading)setSessionsLoading(false);},[taskSync.loading]);

  // 当前活跃会话 id 的 ref：供跨标签「谁在用会话 X」查询时即时应答（见挂载 effect）
  const activeIdRef = useRef<string | null>(activeSessionId);
  useEffect(() => { activeIdRef.current = activeSessionId; }, [activeSessionId]);

  // ---- 流式对话：状态与生命周期都放在 App（永不卸载），切页/切 ChatPage 都不中断/丢失 ----
  const [streams, setStreams] = useState<Record<string, StreamState>>({});
  const previousMediaStates = useRef(new Map<string, string>());
  useEffect(() => {
    for (const [type, job] of [['image', imageStudio.imgJob], ['video', videoStudio.job]] as const) {
      if (!job) continue;
      const id = `${type}:${job.jobId}`;
      const previous = previousMediaStates.current.get(id);
      previousMediaStates.current.set(id, job.state);
      if (previousMediaStates.current.size > 100) previousMediaStates.current.delete(previousMediaStates.current.keys().next().value!);
      if (previous !== 'running' || job.state === 'running') continue;
      const outcome = job.state === 'done' ? '已完成' : job.state === 'cancelled' ? '已停止本地等待' : '失败';
      showToast(`${type === 'image' ? '生图' : '生视频'} · ${outcome}`, job.state === 'done' ? 'success' : job.state === 'cancelled' ? 'info' : 'error',
        undefined, `${id}:${job.state}`, job.state === 'done'
          ? { page: 'outputs', filter: type, path: notificationOutputPath(job.url) }
          : { page: 'image', medium: type });
    }
  }, [imageStudio.imgJob, videoStudio.job]);
  useEffect(() => {
    const outcomes = { published: '平台确认已发布', submitted: '已提交，待确认发布', draft: '已保存草稿', unverified: '发布状态待核验', failed: '发布失败' };
    for (const receipt of publishReceipts.notices) {
      if (receipt?.outcome) showToast(`${receipt.platform} · ${outcomes[receipt.outcome]}`, receipt.outcome === 'published' ? 'success' : receipt.outcome === 'failed' ? 'error' : 'info',
        undefined, `publish:${receipt.receiptId}:${receipt.outcome}`, { page: 'publish-receipts', receiptId: receipt.receiptId });
    }
  }, [publishReceipts.notices]);
  useEffect(() => {
    for (const [sessionId, stream] of Object.entries(streams)) {
      for (const question of stream.questions || []) showToast(`${noticeSubject(sessionsRef.current.find(item => item.id === sessionId)?.title, '对话')} · 需要回答`, 'info',
        undefined, `question:${sessionId}:${question.id}`, { page: 'chat', sessionId });
    }
  }, [streams]);
  const queueRevision = useSyncExternalStore(subscribeChatQueue, getQueueRevision);
  const streamCtl = useRef<Record<string, AbortController>>({});
  useEffect(() => {
    let cancelled=false,reading=false;
    const refresh=async()=>{
      if(reading||document.visibilityState==='hidden')return;
      reading=true;
      try {
        const remote=await readServerConversations(sessionsRef.current);
        if(cancelled)return;
        setSessions(current=>{
          let next=current;
          for(const session of remote)if(!outputSessionDeleted(session.id)&&!streamCtl.current[session.id])next=mergeServerConversation(next,session);
          if(next!==current){saveSessions(next);sessionsRef.current=next;}
          return next;
        });
      }catch{/* Keep local history and retry when the workbench is reachable. */}
      finally{reading=false;}
    };
    void refresh();
    const timer=setInterval(()=>void refresh(),15000);
    const focus=()=>void refresh();
    window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    return()=>{cancelled=true;clearInterval(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  }, []);
  const [activityTarget,setActivityTarget]=useState<{sessionId:string;turnId:string;key:number}|null>(null);
  const [officeTarget, setOfficeTarget] = useState<{ sessionId: string; key: number } | null>(null);
  const streamAcc = useRef<Record<string, ChatTiming & ChatReasoning & { turnId?:string; requestedModelRef?: string; requestedThinkingLevel?: ThinkingLevel; content: string; thinking: string; steps: string[]; questions: ChatQuestion[] }>>({});
  const answeredRef = useRef<Set<string>>(new Set());   // 已提交答案的 question id：重放/恢复不再重现
  // ---- 打字机：分批到达的 token 按节奏吐给界面 ----
  const typingBuf = useRef<Record<string, string>>({});
  const typingTimer = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const TYPING_INTERVAL = 12;          // 每 tick 间隔 ms（短回复约 83 字/秒：快且有逐字感）

  const pumpTyping = (sessionId: string) => {
    const buf = typingBuf.current[sessionId] || '';
    if (!buf) { clearTyping(sessionId); return; }
    // 动态步长：<80 字逐字吐（83字/秒），每满 80 字每 tick 多吐 1 字，长文更快
    const step = Math.max(1, Math.floor(buf.length / 80));
    const take = buf.slice(0, step);
    typingBuf.current[sessionId] = buf.slice(step);
    const a = streamAcc.current[sessionId]; if (!a) { clearTyping(sessionId); return; }
    a.content += take;
    setStreams((p) => (p[sessionId] ? { ...p, [sessionId]: { ...p[sessionId], content: a.content } } : p));
  };
  const startTypingPump = (sessionId: string) => {
    if (typingTimer.current[sessionId]) return;
    typingTimer.current[sessionId] = setInterval(() => pumpTyping(sessionId), TYPING_INTERVAL);
  };
  const ensureTypingPump = (sessionId: string) => {
    if (!typingTimer.current[sessionId]) startTypingPump(sessionId);
  };
  const clearTyping = (sessionId: string) => {
    const t = typingTimer.current[sessionId];
    if (t) { clearInterval(t); delete typingTimer.current[sessionId]; }
  };
  /** 收尾冲刷：把剩余队列立刻吐完（避免结束瞬间内容被截断）。 */
  const flushTyping = (sessionId: string) => {
    clearTyping(sessionId);
    const buf = typingBuf.current[sessionId] || '';
    if (!buf) return;
    typingBuf.current[sessionId] = '';
    const a = streamAcc.current[sessionId]; if (!a) return;
    a.content += buf;
    setStreams((p) => (p[sessionId] ? { ...p, [sessionId]: { ...p[sessionId], content: a.content } } : p));
  };

  const appendAssistant = useCallback((sessionId: string, msg: ChatMessage, sessionKey?: string) => {
    const accumulated = streamAcc.current[sessionId];
    const observedReasoning = accumulated?.turnId === msg.turnId && msg.turnId && msg.error?.code !== 'chat_recovery_unavailable'
      ? { thinkingStatus: msg.thinking ? msg.error || msg.stopped ? 'partial' as const : 'available' as const : 'unavailable' as const, ...decodeChatReasoning(accumulated) }
      : {};
    const completed = { ...finishChatTiming(decodeChatTiming(accumulated)), ...decodeChatTiming(msg),
      requestedThinkingLevel: accumulated?.requestedThinkingLevel, ...observedReasoning, ...msg };
    const session = sessionsRef.current.find(item => item.id === sessionId);
    const stopped = msg.stopped === true;
    if (!msg.error && !stopped) {
      rememberBreakdownReport(session, msg.content, msg.turnId);
      void saveAnalysisChatResult(session, msg).catch(reason => showToast('分析回填未完成：' + (reason instanceof Error ? reason.message : '请重试'), 'error'));
    }
    const outcome = msg.error ? '失败' : stopped ? '已停止' : '已完成';
    showToast(`${noticeSubject(session?.title, '对话')} · ${outcome}`, msg.error ? 'error' : stopped ? 'info' : 'success', undefined,
      `chat:${sessionId}:${msg.turnId || session?.pendingTurnId || msg.startedAt || 'legacy'}:${outcome}`, { page: 'chat', sessionId });
    setSessions((prev) => {
      const next = prev.map((s) =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, completed], sessionKey: sessionKey || s.sessionKey, pendingTurnId: undefined }
          : s);
      saveSessions(next);
      return next;
    });
  }, []);

  const clearStream = useCallback((sessionId: string) => {
    // 打字机收尾：剩余队列立刻吐出，避免结束瞬间内容被截断
    flushTyping(sessionId);
    delete streamCtl.current[sessionId];
    delete streamAcc.current[sessionId];
    setStopErrors((prev) => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setStreams((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  useEffect(()=>{
    const recovered = (event: Event)=>{
      const detail = (event as CustomEvent<{sessionId:string;turnId:string}>).detail;
      if (!detail?.sessionId || !detail.turnId || outputSessionDeleted(detail.sessionId)) return;
      void codexRequest<Parameters<typeof applyCodexResult>[2]>(`turn/${encodeURIComponent(detail.sessionId)}/${encodeURIComponent(detail.turnId)}`).then(snapshot=>{
        if (streamAcc.current[detail.sessionId] || outputSessionDeleted(detail.sessionId)) return;
        setSessions(previous=>{
          const next=previous.map(session=>session.id===detail.sessionId?applyCodexResult(session,detail.turnId,snapshot):session);
          saveSessions(next);return next;
        });
      }).catch(()=>showToast('结果读取失败，请重新核对。','error'));
    };
    window.addEventListener(CODEX_RECOVERED,recovered);
    return()=>window.removeEventListener(CODEX_RECOVERED,recovered);
  },[]);

  // Both fresh and restored streams can lose their event log. Read only the
  // exact turn snapshot; never replay the prompt or adopt another turn's reply.
  const recoverMissingTurn = useCallback(async (sessionId: string, turnId: string, runAcc: typeof streamAcc.current[string]) => {
    const current = () => streamAcc.current[sessionId] === runAcc;
    let snapshot: Awaited<ReturnType<typeof fetchLastTurn>> | undefined;
    try { snapshot = await fetchLastTurn(sessionId, turnId); } catch { /* preserve partial output below */ }
    if (!current()) return;
    flushTyping(sessionId);
    const recovered = snapshot?.status === 'done' && snapshot.turn_id === turnId ? snapshot : undefined;
    if (!recovered) pauseChatQueue(sessionId, '本轮结果尚未确认，队列已暂停。请先核对运行记录。');
    appendAssistant(sessionId, recovered ? {
      ...decodeChatTiming(recovered), ...decodeChatReasoning(recovered), role: 'assistant', content: recovered.text || (recovered.error ? '' : '（无输出）'),
      error: recovered.error, thinking: recovered.thinking || runAcc.thinking || undefined,
      turnId, requestedModelRef: runAcc.requestedModelRef || recovered.requestedModelRef || undefined,
      activity: runAcc.steps.join('\n') || undefined,
    } : {
      role: 'assistant', content: runAcc.content, thinking: runAcc.thinking || undefined,
      turnId, requestedModelRef: runAcc.requestedModelRef, activity: runAcc.steps.join('\n') || undefined,
      error: { code: 'chat_recovery_unavailable', category: 'connection', retryable: false,
        message: '无法接回本轮任务，最终结果尚未确认。已保留收到的内容；请先查看运行记录，确认后再手动发送。' },
    });
    if (recovered?.error) pauseChatQueue(sessionId, '本轮失败，队列已暂停。修复后可继续发送。');
    clearStream(sessionId);
    try { if (sessionStorage.getItem(`easel_pending_turn:${sessionId}`) === turnId) sessionStorage.removeItem(`easel_pending_turn:${sessionId}`); } catch { /* optional storage */ }
  }, [appendAssistant, clearStream]);

  // 启动一次流式（fetch + 累积 + 回调）——只管流，不动消息列表
  const startStream = useCallback((
    sessionId: string,
    text: string,
    persona: string | undefined,
    attachments: UploadedFile[] = [],
    selectedSkills: string[] = [],
    skillRequirements: SkillRequirements = {},
    modelRef?: string,
    thinkingLevel?: ThinkingLevel,
    history?: { role: 'user' | 'assistant'; content: string }[],
    preparedTurnId?: string,
  ) => {
    const startedAt = Date.now();
    const turnId = preparedTurnId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try { sessionStorage.setItem(`easel_pending_turn:${sessionId}`, turnId); } catch { /* ignore */ }
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === sessionId ? { ...s, pendingTurnId: turnId,
        messages: s.messages.map((m, index) => index === s.messages.length - 1 && m.role === 'user' ? { ...m, startedAt } : m) } : s));
      saveSessions(next); return next;
    });
    const runAcc: ChatTiming & { turnId?: string; requestedModelRef?: string; requestedThinkingLevel?: ThinkingLevel; content: string; thinking: string; steps: string[]; questions: ChatQuestion[] } = { startedAt, turnId, requestedModelRef: modelRef, requestedThinkingLevel: thinkingLevel, content:'', thinking:'', steps:[], questions:[] };
    streamAcc.current[sessionId] = runAcc;
    setStreams((prev) => ({ ...prev, [sessionId]: { startedAt, requestedModelRef: modelRef, content: '', thinking: '', activity: '', activitySteps: [], questions: [] } }));
    // 打字机队列：流式事件按批到达（OpenClaw 攒批），前端按字符节奏显示，体验逐字浮现。
    typingBuf.current[sessionId] = '';
    startTypingPump(sessionId);
    streamCtl.current[sessionId] = streamChat(
      text, persona, sessionId,
      (chunk) => {
        const a = streamAcc.current[sessionId]; if (a !== runAcc) return;
        // 不直接追加 content——进打字机队列，pump 按节奏吐出（切会话不中断，队列归属 sessionId）
        typingBuf.current[sessionId] = (typingBuf.current[sessionId] || '') + chunk;
        ensureTypingPump(sessionId);
      },
      (sessionKey, outcome) => {
        Object.assign(runAcc, finishChatTiming(runAcc));
        // done 不能立即 flush——token 和 done 几乎同时到达（OpenClaw 攒批），
        // 立即 flush 会把整包瞬间冲出，打字机白做。等队列吐完再落盘。
        drainStreamRun(() => streamAcc.current[sessionId] === runAcc, () => Boolean(typingBuf.current[sessionId]), () => {
          const a = streamAcc.current[sessionId];
          appendAssistant(sessionId, {
            role: 'assistant', content: a?.content || (outcome?.stopped ? '（已停止）' : ''), stopped: outcome?.stopped, turnId, requestedModelRef: a?.requestedModelRef,
            thinking: a?.thinking || undefined, activity: a?.steps.join('\n') || undefined,
          }, sessionKey);
          clearStream(sessionId);
          try { sessionStorage.removeItem(`easel_pending_turn:${sessionId}`); } catch { /* ignore */ }
        });
      },
      (err) => {
        Object.assign(runAcc, finishChatTiming(runAcc));
        if (streamAcc.current[sessionId] === runAcc) pauseChatQueue(sessionId, '本轮失败，队列已暂停。修复后可继续发送。');
        drainStreamRun(() => streamAcc.current[sessionId] === runAcc, () => Boolean(typingBuf.current[sessionId]), () => {
          const a = streamAcc.current[sessionId];
          appendAssistant(sessionId, {
            role: 'assistant',
            content: a?.content || '', error:chatErrorDetail(err),
            turnId, requestedModelRef: a?.requestedModelRef,
            thinking: a?.thinking || undefined, activity: a?.steps.join('\n') || undefined,
          });
          clearStream(sessionId);
          try { sessionStorage.removeItem(`easel_pending_turn:${sessionId}`); } catch { /* ignore */ }
        });
      },
      (thinkChunk) => {
        const a = streamAcc.current[sessionId]; if (a !== runAcc) return;
        a.thinking += thinkChunk;
        // 有真实思考流 → 清掉防呆提示（不再显示「未卡住」）
        setStreams((p) => (p[sessionId] && streamAcc.current[sessionId] === runAcc ? { ...p, [sessionId]: { ...p[sessionId], thinking: a.thinking, stillWorking: undefined } } : p));
      },
      (status) => {
        const a = streamAcc.current[sessionId]; if (a !== runAcc) return;
        if (a.steps[a.steps.length - 1] !== status) a.steps.push(status);
        // 有真实活动状态 → 清掉防呆提示，让真实状态占据活动行
        setStreams((p) => (p[sessionId] && streamAcc.current[sessionId] === runAcc ? { ...p, [sessionId]: { ...p[sessionId], activity: status, activitySteps: [...a.steps], stillWorking: undefined } } : p));
      },
      // onInterrupted：SSE 被中断（长任务时代理掐断），但后端仍在跑并会落盘完整结果。
      // streamChat 会按 eventId 自动重连并补发遗漏事件；这里只更新用户可见状态。
      (note) => {
        if (note && streamAcc.current[sessionId] === runAcc) setStopErrors(previous => ({ ...previous, [sessionId]: note }));
        setStreams((p) => {
          if (!p[sessionId] || streamAcc.current[sessionId] !== runAcc) return p;
          const next = note || '连接中断，正在续接';
          if (runAcc.steps[runAcc.steps.length - 1] !== next) runAcc.steps.push(next);
          return { ...p, [sessionId]: { ...p[sessionId], activity: next, activitySteps: [...runAcc.steps] } };
        });
      },
      turnId,
      false,
      () => { void recoverMissingTurn(sessionId, turnId, runAcc); },
      attachments,
      (q) => {
        // ask_user 问答题：追加进流式状态（去重），ChatPage 渲染为选项卡片
        // 重放可能带已解决/已过期的旧问题，先查状态只留 pending（失败则保留）
        const a = streamAcc.current[sessionId]; if (a !== runAcc) return;
        if (a.questions.some((x) => x.id === q.id)) return;
        if (answeredRef.current.has(q.id)) return;   // 本会话已答过：不再重现
        void questionStatus([q.id]).then((st) => {
          const s = st[q.id]?.status;
          // 查询失败或未知状态不能抹掉刚收到的问题；只过滤权威终态。
          if (!shouldKeepChatQuestion(s) || answeredRef.current.has(q.id)) return;
          const a2 = streamAcc.current[sessionId]; if (a2 !== runAcc) return;
          if (a2.questions.some((x) => x.id === q.id)) return;
          a2.questions.push(q);
          setStreams((p) => (p[sessionId] && streamAcc.current[sessionId] === runAcc
            ? { ...p, [sessionId]: { ...p[sessionId], questions: [...a2.questions] } } : p));
        });
      },
      // onHeartbeat：防呆心跳（30s 静默）。只设独立的「未卡住」提示，绝不写 activity/thinking → 不顶掉真实状态。
      (note) => setStreams((p) => (p[sessionId] && streamAcc.current[sessionId] === runAcc ? { ...p, [sessionId]: { ...p[sessionId], stillWorking: note } } : p)),
      selectedSkills,
      skillRequirements,
      modelRef,
      (selection) => {
        if (streamAcc.current[sessionId] !== runAcc || selection !== (modelRef ?? null)) return;
        setStreams(p => p[sessionId] && streamAcc.current[sessionId] === runAcc
          ? { ...p, [sessionId]: { ...p[sessionId], requestedModelRef: selection || undefined } } : p);
      },
      thinkingLevel,
      (text) => {
        if (streamAcc.current[sessionId] !== runAcc) return;
        clearTyping(sessionId);
        typingBuf.current[sessionId] = '';
        runAcc.content = text;
        setStreams(p => p[sessionId] && streamAcc.current[sessionId] === runAcc
          ? { ...p, [sessionId]: { ...p[sessionId], content: text } } : p);
      },
      (event) => setStreams(p => p[sessionId] && streamAcc.current[sessionId] === runAcc
        ? { ...p, [sessionId]: { ...p[sessionId], compaction: event } } : p),
      (timing) => {
        if (streamAcc.current[sessionId] !== runAcc) return;
        Object.assign(runAcc, timing);
        setStreams(p => p[sessionId] ? { ...p, [sessionId]: { ...p[sessionId], ...timing } } : p);
      },
      sessionsRef.current.find(s=>s.id===sessionId)?.engine || 'openclaw',
      history,
      (status) => { if (streamAcc.current[sessionId] === runAcc) Object.assign(runAcc, status); },
    );
  }, [appendAssistant, clearStream, recoverMissingTurn]);

  // 刷新/重开页面后按 eventId=0 重放当前 job，再继续实时 tail；旧任务无事件日志时退回最终快照。
  const resumePendingTurn = useCallback((sessionId: string) => {
    if (streamCtl.current[sessionId] || streamAcc.current[sessionId]) return;  // 本标签正在跑，不插手
    const s = sessionsRef.current.find((x) => x.id === sessionId);
    if (s?.importedFromBackup) return;
    const last = s?.messages[s.messages.length - 1];
    if (!last || last.role !== 'user') return;   // 没有悬空的用户消息 = 无需恢复
    let turnId = s.pendingTurnId;
    try { turnId = sessionStorage.getItem(`easel_pending_turn:${sessionId}`) || turnId; } catch { /* use persisted id */ }
    const runAcc: ChatTiming & { turnId?: string; requestedModelRef?: string; requestedThinkingLevel?: ThinkingLevel; content: string; thinking: string; steps: string[]; questions: ChatQuestion[] } = { startedAt: last.startedAt, turnId, requestedModelRef: last.requestedModelRef, requestedThinkingLevel: last.requestedThinkingLevel, content:'', thinking:'', steps:[], questions:[] };
    streamAcc.current[sessionId] = runAcc;
    setStreams((p) => ({ ...p, [sessionId]: { startedAt: last.startedAt, requestedModelRef: last.requestedModelRef, content: '', thinking: '', activity: '正在接回上一轮结果', activitySteps: ['正在接回上一轮结果'], questions: [] } }));
    typingBuf.current[sessionId] = '';
    startTypingPump(sessionId);
    if (!turnId) {
      void fetchLastTurn(sessionId).then((r) => {
        if (streamAcc.current[sessionId] !== runAcc) return;
        if (r.status === 'done') appendAssistant(sessionId, { ...decodeChatTiming(r), ...decodeChatReasoning(r), role: 'assistant', content: r.text || (r.error?'':'（无输出）'), error:r.error, thinking: r.thinking || undefined, turnId:r.turn_id, requestedModelRef: last.requestedModelRef || r.requestedModelRef || undefined });
        clearStream(sessionId);
      }).catch(() => {if(streamAcc.current[sessionId]===runAcc)clearStream(sessionId);});
      return;
    }
    streamCtl.current[sessionId] = streamChat(
      '', undefined, sessionId,
      (chunk) => {
        const a = streamAcc.current[sessionId]; if (a !== runAcc) return;
        typingBuf.current[sessionId] = (typingBuf.current[sessionId] || '') + chunk;
        ensureTypingPump(sessionId);
      },
      (sessionKey, outcome) => {
        Object.assign(runAcc, finishChatTiming(runAcc));
        drainStreamRun(() => streamAcc.current[sessionId] === runAcc, () => Boolean(typingBuf.current[sessionId]), () => {
          const a = streamAcc.current[sessionId];
          appendAssistant(sessionId, {
            role: 'assistant', content: a?.content || (outcome?.stopped ? '（已停止）' : '（无输出）'), stopped: outcome?.stopped, turnId, requestedModelRef: a?.requestedModelRef,
            thinking: a?.thinking || undefined, activity: a?.steps.join('\n') || undefined,
          }, sessionKey);
          clearStream(sessionId);
          try { sessionStorage.removeItem(`easel_pending_turn:${sessionId}`); } catch { /* ignore */ }
        });
      },
      (err) => {
        Object.assign(runAcc, finishChatTiming(runAcc));
        if (streamAcc.current[sessionId] === runAcc) pauseChatQueue(sessionId, '本轮失败，队列已暂停。修复后可继续发送。');
        drainStreamRun(() => streamAcc.current[sessionId] === runAcc, () => Boolean(typingBuf.current[sessionId]), () => {
          const a = streamAcc.current[sessionId];
          appendAssistant(sessionId, { role: 'assistant', content: a?.content || '', error:chatErrorDetail(err), turnId, requestedModelRef: a?.requestedModelRef, thinking: a?.thinking || undefined, activity: a?.steps.join('\n') || undefined });
          clearStream(sessionId);
          try { sessionStorage.removeItem(`easel_pending_turn:${sessionId}`); } catch { /* optional storage */ }
        });
      },
      (chunk) => {
        const a = streamAcc.current[sessionId]; if (a !== runAcc) return;
        a.thinking += chunk;
        setStreams((p) => (p[sessionId] && streamAcc.current[sessionId] === runAcc ? { ...p, [sessionId]: { ...p[sessionId], thinking: a.thinking, stillWorking: undefined } } : p));
      },
      (status) => {
        const a = streamAcc.current[sessionId]; if (a !== runAcc) return;
        if (a.steps[a.steps.length - 1] !== status) a.steps.push(status);
        setStreams((p) => (p[sessionId] && streamAcc.current[sessionId] === runAcc ? { ...p, [sessionId]: { ...p[sessionId], activity: status, activitySteps: [...a.steps] } } : p));
      },
      (note) => {
        if (note && streamAcc.current[sessionId] === runAcc) setStopErrors(previous => ({ ...previous, [sessionId]: note }));
        setStreams((p) => {
          if (!p[sessionId] || streamAcc.current[sessionId] !== runAcc) return p;
          const next = note || '正在自动续接';
          if (runAcc.steps[runAcc.steps.length - 1] !== next) runAcc.steps.push(next);
          return { ...p, [sessionId]: { ...p[sessionId], activity: next, activitySteps: [...runAcc.steps] } };
        });
      },
      turnId,
      true,
      () => { void recoverMissingTurn(sessionId, turnId, runAcc); },
      undefined,   // attachments: 恢复轮次无新附件
      (q) => {
        const a = streamAcc.current[sessionId]; if (a !== runAcc) return;
        if (a.questions.some((x) => x.id === q.id)) return;
        if (answeredRef.current.has(q.id)) return;   // 本会话已答过：不再重现
        // 重放可能带已解决/已过期的旧问题（gateway 15s 后即清理）——先查状态只留 pending；
        // 查询失败时保留原样（宁显示不丢题）。
        void questionStatus([q.id]).then((st) => {
          const s = st[q.id]?.status;
          // 重放查询暂时失败时保留卡片；只有权威终态才过滤。
          if (!shouldKeepChatQuestion(s) || answeredRef.current.has(q.id)) return;
          const a2 = streamAcc.current[sessionId]; if (a2 !== runAcc) return;
          if (a2.questions.some((x) => x.id === q.id)) return;
          a2.questions.push(q);
          setStreams((p) => (p[sessionId] && streamAcc.current[sessionId] === runAcc
            ? { ...p, [sessionId]: { ...p[sessionId], questions: [...a2.questions] } } : p));
        });
      },
      // onHeartbeat：同上，独立的「未卡住」提示，不覆盖 activity/thinking。
      (note) => setStreams((p) => (p[sessionId] && streamAcc.current[sessionId] === runAcc ? { ...p, [sessionId]: { ...p[sessionId], stillWorking: note } } : p)),
      [], {}, undefined,
      (selection) => {
        if (streamAcc.current[sessionId] !== runAcc || (last.requestedModelRef && selection !== last.requestedModelRef)) return;
        runAcc.requestedModelRef = selection || undefined;
        setStreams(p => p[sessionId] && streamAcc.current[sessionId] === runAcc
          ? { ...p, [sessionId]: { ...p[sessionId], requestedModelRef: selection || undefined } } : p);
      },
      last.requestedThinkingLevel,
      (text) => {
        if (streamAcc.current[sessionId] !== runAcc) return;
        clearTyping(sessionId);
        typingBuf.current[sessionId] = '';
        runAcc.content = text;
        setStreams(p => p[sessionId] && streamAcc.current[sessionId] === runAcc
          ? { ...p, [sessionId]: { ...p[sessionId], content: text } } : p);
      },
      (event) => setStreams(p => p[sessionId] && streamAcc.current[sessionId] === runAcc
        ? { ...p, [sessionId]: { ...p[sessionId], compaction: event } } : p),
      (timing) => {
        if (streamAcc.current[sessionId] !== runAcc) return;
        Object.assign(runAcc, timing);
        setStreams(p => p[sessionId] ? { ...p, [sessionId]: { ...p[sessionId], ...timing } } : p);
      },
      sessionsRef.current.find(s=>s.id===sessionId)?.engine || 'openclaw',
      undefined,
      (status) => { if (streamAcc.current[sessionId] === runAcc) Object.assign(runAcc, status); },
    );
  }, [appendAssistant, clearStream, recoverMissingTurn]);

  // 活跃会话确定后（含挂载首刷）尝试恢复它悬空的一轮
  useEffect(() => {
    if (activeSessionId) {
      resumePendingTurn(activeSessionId);
      for (const child of sessionsRef.current.filter(item=>item.parentSessionId===activeSessionId)) resumePendingTurn(child.id);
    }
  }, [activeSessionId, resumePendingTurn]);

  // 落用户消息（可选先把 messages 截断到 truncateAt）→ 启动流。retry/edit 都走这里。
  const sendUserAndStream = useCallback((
    sessionId: string,
    displayText: string,
    attachments: UploadedFile[] = [],
    legacyAgentText?: string,
    truncateAt?: number,
    selectedSkills: string[] = [],
    skillRequirements: SkillRequirements = {},
    modelRef?: string,
    thinkingLevel?: ThinkingLevel,
    kind?: 'breakdown',
    purpose?: 'content-generation',
  ) => {
    const cur = sessionsRef.current.find((s) => s.id === sessionId);
    if (cur?.importedFromBackup) return false;
    const history = truncateAt != null ? cur?.messages.slice(0, truncateAt) : cur?.messages;
    const analysisMessage = analysisChatMessage(cur?.analysisContext, displayText, !history?.some(message => message.role === 'user'));
    const visible = analysisMessage.content;
    const agentMessage = (legacyAgentText || analysisMessage.agentContent).trim();
    if ((!agentMessage && attachments.length === 0) || streamCtl.current[sessionId] || stopRequests.current[sessionId]) return false;
    const persona = cur?.writingContext ? cur.writingContext.persona || undefined : cur?.persona || selectedPersona || undefined;
    const requirementSnapshot = requirementsForSelection(skillRequirements, selectedSkills);
    setSessions((prev) => {
      const next = prev.map((s) => {
        if (s.id !== sessionId) return s;
        const base = truncateAt != null ? s.messages.slice(0, truncateAt) : s.messages;
        const updated = {
          ...s,
          ...(purpose && !s.analysisContext && !['account-analysis', 'content-analysis'].includes(s.conversationType || '') ? { conversationType: purpose } : {}),
          messages: [...base, {
            role: 'user',
            content: visible,
            ...(kind ? { kind } : {}),
            selectedSkills,
            skillRequirements: requirementSnapshot,
            ...(modelRef !== undefined ? { requestedModelRef: modelRef } : {}),
            ...(thinkingLevel !== undefined ? { requestedThinkingLevel: thinkingLevel } : {}),
            ...(attachments.length ? { attachments } : {}),
            ...(agentMessage !== visible ? { agentContent: agentMessage } : {}),
          } as ChatMessage],
        };
        updateSessionTitle(updated);
        return updated;
      });
      saveSessions(next);
      return next;
    });
    const seed = cur ? editBranchSeed(cur, truncateAt ?? cur.messages.length) : undefined;
    startStream(sessionId, agentMessage, persona, seed ? [...new Map([...seed.attachments, ...attachments].map(file => [file.path, file])).values()] : attachments, selectedSkills, requirementSnapshot, modelRef, thinkingLevel, seed?.history);
    return true;
  }, [selectedPersona, startStream]);

  const handleSendMessage = useCallback((sessionId: string, displayText: string, attachments?: UploadedFile[], selectedSkills: string[] = [], skillRequirements: SkillRequirements = {}, thinkingLevel?: ThinkingLevel, modelRef?: string) => {
    const session = sessionsRef.current.find(session => session.id === sessionId);
    if (!session || session.importedFromBackup || stopRequests.current[sessionId]) return false;
    if (streamAcc.current[sessionId] || streamCtl.current[sessionId] || getChatQueue(sessionId).items.length) {
      return enqueueChat(sessionId, { text: displayText.trim(), attachments: attachments || [], selectedSkills, skillRequirements, thinkingLevel, modelRef });
    }
    return sendUserAndStream(sessionId, displayText, attachments, undefined, undefined, selectedSkills, skillRequirements, modelRef, thinkingLevel);
  }, [sendUserAndStream]);

  const analysisPreparing = useRef(new Set<string>());
  const handleAnalysisChat = useCallback(async (request: AnalysisChatRequest) => {
    if (request.sessionId) {
      const existing = sessionsRef.current.find(s => s.id === request.sessionId && s.analysisContext?.platform === request.platform && s.analysisContext.accountId === request.accountId);
      if (!existing) { showToast('原分析对话不在本机，可重新提取材料创建对话', 'info'); return; }
      setActiveSessionId(existing.id); setCurrentPage('chat'); return;
    }
    const key = JSON.stringify(request);
    if (analysisPreparing.current.has(key)) return;
    analysisPreparing.current.add(key);
    const identity = analyticsScope(request.platform);
    try {
      const session = createSession(selectedPersona);
      const binding = await analysisRequest<AnalysisBinding>('/conversations', 'POST', { ...request, sessionId: session.id, persona: session.persona || '' });
      if (identity !== analyticsScope(request.platform)) throw new Error('账号已切换，请在当前账号重新提取材料');
      session.conversationType = binding.kind; session.analysisContext = binding;
      session.title = `${binding.kind === 'content-analysis' ? '作品分析' : '账号分析'} · ${binding.accountName}`;
      const next = [session, ...sessionsRef.current];
      if (!saveSessions(next)) throw new Error('分析对话未能保存，未发送模型请求');
      savePanelTools(session.id, ['analysis']);
      setChatDraftText(session.id, defaultAnalysisRequest(binding));
      sessionsRef.current = next; setSessions(next);
      setActiveSessionId(session.id); setCurrentPage('chat');
    } catch (reason) { showToast(reason instanceof Error ? reason.message : '准备分析对话失败', 'error'); }
    finally { analysisPreparing.current.delete(key); }
  }, [selectedPersona]);

  const writingPreparing = useRef(new Set<string>());
  const handleWriting = useCallback(async (sourceId: string) => {
    if (writingPreparing.current.has(sourceId)) return;
    const source = sessionsRef.current.find(session => session.id === sourceId);
    if (!source) throw new Error('原分析对话已删除');
    writingPreparing.current.add(sourceId);
    try {
      const context = await prepareWriting(source);
      if (!sessionsRef.current.some(session => session.id === sourceId)) throw new Error('原分析对话已删除');
      const target = writingSession(source, context, sessionsRef.current);
      if (!sessionsRef.current.some(session => session.id === target.id)) {
        const next = [target, ...sessionsRef.current];
        if (!saveSessions(next)) throw new Error('写作对话未能保存，未发送模型请求');
        sessionsRef.current = next; setSessions(next);
      }
      seedWritingDraft(target);
      setActiveSessionId(target.id); setCurrentPage('chat');
    } finally { writingPreparing.current.delete(sourceId); }
  }, [setCurrentPage]);

  const editRequests = useRef(new Set<string>());
  const handleEditMessage = useCallback(async (sessionId: string, userIndex: number, text: string, signal: AbortSignal) => {
    if (editRequests.current.has(sessionId)) throw new Error('另一条消息正在准备编辑分支，请稍候。');
    editRequests.current.add(sessionId);
    try {
      const source = sessionsRef.current.find(session => session.id === sessionId);
      if (!source || streamAcc.current[sessionId] || streamCtl.current[sessionId] || stopRequests.current[sessionId]) throw new Error('请先停止或等待当前生成完成。');
      if (getChatQueue(sessionId).items.length) throw new Error('请先处理当前对话的待发队列，再编辑历史消息。');
      const plan = editBranchPlan(source, userIndex, text);
      const result = await prepareChatBranch(sessionId, plan.attachments, signal);
      if (signal.aborted || activeIdRef.current !== sessionId) return false;
      const current = sessionsRef.current.find(session => session.id === sessionId);
      if (!current || current.messages !== source.messages || current.pendingTurnId
        || streamAcc.current[sessionId] || streamCtl.current[sessionId] || stopRequests.current[sessionId]
        || getChatQueue(sessionId).items.length) throw new Error('原对话状态已变化，请重新打开编辑。');
      const original = remapEditedMessage(plan.original, result.attachments);
      const branch: ChatSession = { ...createSession(source.persona), id: result.sessionId, engine: source.engine, conversationType: source.analysisContext?.kind || source.conversationType,
        writingContext: result.writingContext,
        title: `${source.title} · 编辑分支`, messages: [...plan.prefix.map(message => remapEditedMessage(message, result.attachments)),
          { role: 'user', content: plan.text, attachments: original.attachments, selectedSkills: original.selectedSkills,
            ...(original.kind === 'breakdown' ? { kind: 'breakdown' as const, agentContent: buildBreakdownReportPrompt(plan.text, source.persona) }
              : source.analysisContext ? { agentContent: analysisChatMessage(source.analysisContext, plan.text, true).agentContent } : {}),
            skillRequirements: original.skillRequirements, requestedModelRef: original.requestedModelRef, requestedThinkingLevel: original.requestedThinkingLevel }],
        editBranch: { sourceSessionId: sessionId, prefixLength: plan.prefix.length } };
      if (!writeSelectedSkills(branch.id, original.selectedSkills || [])
        || !writeSkillRequirements(branch.id, original.skillRequirements || {})) throw new Error('无法保存分支技能配置，未发送。');
      const next = [branch, ...sessionsRef.current];
      if (!saveSessions(next)) throw new Error('无法保存编辑分支，未发送。请先恢复浏览器存储。');
      sessionsRef.current = next;
      setSessions(next);
      activeIdRef.current = branch.id;
      setActiveSessionId(branch.id);
      const seed = editBranchSeed(branch, plan.prefix.length)!;
      startStream(branch.id, branch.messages.at(-1)?.agentContent || plan.text, branch.persona, seed.attachments, original.selectedSkills,
        original.skillRequirements, original.requestedModelRef, original.requestedThinkingLevel, seed.history);
      return true;
    } finally { editRequests.current.delete(sessionId); }
  }, [startStream]);

  useEffect(() => {
    for (const session of sessionsRef.current) {
      if (session.importedFromBackup || session.archived || streamAcc.current[session.id] || streamCtl.current[session.id] || stopRequests.current[session.id]) continue;
      dispatchQueuedMessage(session.id, item => sendUserAndStream(session.id, item.text, item.attachments,
        undefined, undefined, item.selectedSkills, item.skillRequirements, item.modelRef, item.thinkingLevel));
    }
  }, [streams, queueRevision, sendUserAndStream]);

  // Last-turn retry uses the same runtime; history editing forks separately.
  const handleResend = useCallback((
    sessionId: string,
    userIndex: number,
    displayText: string,
    attachments?: UploadedFile[],
    legacyAgentText?: string,
  ) => {
    const selectedSkills = sessionsRef.current.find((session) => session.id === sessionId)?.messages[userIndex]?.selectedSkills || [];
    const skillRequirements = sessionsRef.current.find((session) => session.id === sessionId)?.messages[userIndex]?.skillRequirements || {};
    const modelRef = sessionsRef.current.find((session) => session.id === sessionId)?.messages[userIndex]?.requestedModelRef;
    const thinkingLevel = sessionsRef.current.find((session) => session.id === sessionId)?.messages[userIndex]?.requestedThinkingLevel;
    const kind = sessionsRef.current.find(session => session.id === sessionId)?.messages[userIndex]?.kind;
    sendUserAndStream(sessionId, displayText, attachments, legacyAgentText, userIndex, selectedSkills, skillRequirements, modelRef, thinkingLevel, kind);
  }, [sendUserAndStream]);

  // 对话分享（完整快照）与接管回传（外部模型追加 → 加载回原对话，去重并标注来源）。
  const handleShareConversation = useCallback(async () => {
    const active = sessionsRef.current.find(item => item.id === activeSessionId);
    if (!active) return;
    if (active.importedFromBackup) { showToast('备份导入的对话不支持分享', 'info'); return; }
    try {
      const share = await createConversationShare(active);
      const next = sessionsRef.current.map(item => item.id === active.id ? { ...item, share: { token: share.token, title: share.title, createdAt: share.createdAt } } : item);
      if (!saveSessions(next)) showToast('分享已创建，但本机未能记录 token；请先复制保留。', 'error');
      else showToast(`已生成完整分享（${share.messageCount} 条消息）· token ${share.token}`, 'success');
      sessionsRef.current = next;
      setSessions(next);
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '分享创建失败', 'error');
    }
  }, [activeSessionId]);
  const handleLoadShareAppends = useCallback(async () => {
    const active = sessionsRef.current.find(item => item.id === activeSessionId);
    const share = active?.share;
    if (!active || !share) return;
    try {
      const { appends } = await fetchShareAppends(share.token);
      const merged = mergeShareAppends(active, appends);
      if (!merged.added) { showToast('没有新的接管内容', 'info'); return; }
      const next = sessionsRef.current.map(item => item.id === active.id ? merged.session : item);
      if (!saveSessions(next)) { showToast('接管内容未能保存到本机；请保留当前页面。', 'error'); return; }
      sessionsRef.current = next;
      setSessions(next);
      showToast(`已加载 ${merged.added} 条接管内容`, 'success');
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '接管内容读取失败', 'error');
    }
  }, [activeSessionId]);

  // 非显式入口（看热点一键做成内容、技能开聊、爆款拆解）并入当前选中的对话；
  // 只有侧栏“新建对话”与工作台“开始创作”会新增列表条目。
  const mergeTarget = useCallback((): ChatSession | undefined => {
    const busy = (id: string) => Boolean(streamCtl.current[id] || streamAcc.current[id] || stopRequests.current[id]);
    return pickMergeTarget(sessionsRef.current, activeSessionId, busy);
  }, [activeSessionId]);

  // 热点「一键做成内容」：并入当前对话（没有才新开），把选题作为指令发出去，跳到对话页。
  const handleUseTopic = useCallback((title: string) => {
    const prompt = `围绕当前热点「${title}」：先判断它适不适合我的账号赛道；若合适，给 2-3 个差异化的二创角度，并把你最推荐的那条写成可直接发布的文案初稿。`;
    const target = mergeTarget();
    if (target) { setCurrentPage('chat'); sendUserAndStream(target.id, prompt, [], undefined, undefined, [], {}, undefined, undefined, undefined, 'content-generation'); return; }
    const ns = createSession(selectedPersona || undefined);
    ns.conversationType = 'content-generation';
    setSessions((prev) => { const u = [ns, ...prev]; saveSessions(u); return u; });
    setActiveSessionId(ns.id);
    setCurrentPage('chat');
    sendUserAndStream(ns.id, prompt);
  }, [selectedPersona, sendUserAndStream, mergeTarget]);

  // 工作台「一句话开干」：用户输入什么就发什么，不再替用户编排指令（v2 直达创作入口）。
  const handleQuickPrompt = useCallback((text: string, selectedSkills: string[] = [], skillRequirements: SkillRequirements = {}, thinkingLevel?: ThinkingLevel, modelRef?: string) => {
    const t = text.trim();
    if (!t || gatewayStatus !== 'connected') return false;
    const ns = createSession(selectedPersona || undefined);
    ns.conversationType = 'content-generation';
    const skills = [...selectedSkills];
    const requirements = requirementsForSelection(skillRequirements, skills);
    // The new composer must be able to display the same selection that is sent.
    // A rejected local save leaves the dashboard draft in place and sends nothing.
    if (skills.length && (!writeSelectedSkills(ns.id, skills) || !writeSkillRequirements(ns.id, requirements))) return false;
    setSessions((prev) => { const u = [ns, ...prev]; saveSessions(u); return u; });
    setActiveSessionId(ns.id);
    setCurrentPage('chat');
    return sendUserAndStream(ns.id, t, [], undefined, undefined, skills, requirements, modelRef, thinkingLevel);
  }, [selectedPersona, sendUserAndStream, gatewayStatus]);

  const handleSkillChat = useCallback((skill: string, input: string): boolean => {
    const merged = mergeTarget();
    if (merged) {
      if (!writeSelectedSkills(merged.id, [skill])) return false;
      setChatDraftText(merged.id, input);
      try {
        if (JSON.parse(localStorage.getItem(`easel:chat-draft:${merged.id}`) || 'null')?.text !== input) return false;
      } catch { return false; }
      setCurrentPage('chat');
      return true;
    }
    const created = createSession(selectedPersona || undefined);
    if (!writeSelectedSkills(created.id, [skill])) return false;
    setChatDraftText(created.id, input);
    try {
      if (JSON.parse(localStorage.getItem(`easel:chat-draft:${created.id}`) || 'null')?.text !== input) return false;
    } catch { return false; }
    const next = [created, ...sessionsRef.current];
    if (!saveSessions(next)) return false;
    setSessions(next);
    setActiveSessionId(created.id);
    setCurrentPage('chat');
    return true;
  }, [selectedPersona, setCurrentPage, mergeTarget]);

  const handleImagePromptSkill = useCallback((skill: string, input: string): boolean => {
    if (!skill.trim() || !input.trim()) return false;
    const created = createSession(selectedPersona || undefined);
    created.conversationType = 'content-generation';
    created.title = `提示词灵感 · ${displayName(skill)}`;
    if (!writeSelectedSkills(created.id, [skill])) return false;
    setChatDraftText(created.id, input);
    try {
      if (JSON.parse(localStorage.getItem(`easel:chat-draft:${created.id}`) || 'null')?.text !== input) return false;
    } catch { return false; }
    const next = [created, ...sessionsRef.current];
    if (!saveSessions(next)) return false;
    sessionsRef.current = next;
    setSessions(next);
    setActiveSessionId(created.id);
    requestCreationPanel('image', created.id);
    setCurrentPage('chat', true);
    return true;
  }, [selectedPersona, setCurrentPage]);

  const handleStartBreakdown = useCallback((material: string, modelRef?: string, thinkingLevel?: ThinkingLevel): boolean => {
    if (!material.trim() || gatewayStatus !== 'connected') return false;
    const base = mergeTarget();
    const session = createBreakdownSession(material, selectedPersona || undefined, modelRef, thinkingLevel, base);
    const next = base ? sessionsRef.current.map(item => item.id === session.id ? session : item) : [session, ...sessionsRef.current];
    // Persist the material AND recovery identity before starting any request.
    if (!saveSessions(next)) return false;
    sessionsRef.current = next;
    setSessions(next);
    setActiveSessionId(session.id);
    setCurrentPage('chat');
    const turn = session.messages.at(-1)!;
    startStream(session.id, turn.agentContent!, session.persona, [], [], {}, modelRef, thinkingLevel, undefined, session.pendingTurnId);
    return true;
  }, [selectedPersona, gatewayStatus, setCurrentPage, startStream, mergeTarget]);

  const handleOpenBreakdownRun = useCallback((run: ActiveRun): boolean => {
    const next = adoptBreakdownRun(sessionsRef.current, run);
    const target = next.find(session => session.id === run.sessionId);
    if (!target || target.importedFromBackup || (next !== sessionsRef.current && !saveSessions(next))) return false;
    sessionsRef.current = next;
    setSessions(next);
    setActiveSessionId(target.id);
    setCurrentPage('chat');
    resumePendingTurn(target.id);
    return true;
  }, [setCurrentPage, resumePendingTurn]);

  const handleOfficeTask = useCallback(({ sessionId, message, modelRef }: OfficeTaskRequest): string | null => {
    if (!message.trim() || (modelRef !== undefined && (!/^[^\s/]+\/[^\s]+$/.test(modelRef) || modelRef.length > 500))) return null;
    let targetId = sessionId;
    if (targetId) {
      const current = sessionsRef.current.find(session => session.id === targetId);
      if (!current || current.importedFromBackup || streamCtl.current[targetId] || streamAcc.current[targetId] || stopRequests.current[targetId]
        || (current.pendingTurnId && current.messages.at(-1)?.role === 'user')) return null;
    } else {
      const created = createSession(selectedPersona || undefined);
      targetId = created.id;
      setSessions(previous => { const next = [created, ...previous]; saveSessions(next); return next; });
    }
    const accepted = sendUserAndStream(targetId, message, [], undefined, undefined, [], {}, modelRef);
    if (!accepted) return null;
    setActiveSessionId(targetId);
    return targetId;
  }, [selectedPersona, sendUserAndStream]);

  const handleStopStream = useCallback(async (sessionId: string, pauseQueue = true) => {
    if (sessionsRef.current.find(s => s.id === sessionId)?.importedFromBackup) return false;
    const run = streamAcc.current[sessionId];
    if (!run || stopRequests.current[sessionId]) return false;
    if (pauseQueue) pauseChatQueue(sessionId, '生成已请求停止，队列已暂停。');
    const request = {};
    stopRequests.current[sessionId] = request;
    setStoppingSessions((prev) => ({ ...prev, [sessionId]: true }));
    setStopErrors((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    try {
      // Keep receiving/reconnecting until the backend confirms termination.
      // A network failure must not discard the only durable job identifier.
      const result = await stopChat(sessionId, run.turnId);
      if (stopRequests.current[sessionId] !== request) return false;
      if (streamAcc.current[sessionId] !== run) return !streamAcc.current[sessionId] && !streamCtl.current[sessionId];
      if (!result.stopped) {
        setStopErrors((prev) => ({ ...prev, [sessionId]: '后端尚未确认本轮已停止。可以重试停止，或保留记录新建对话；不会自动重发本轮。' }));
        return false;
      }
      if (result.status === 'already_finished') {
        const saved = await fetchLastTurn(sessionId, run.turnId);
        if (streamAcc.current[sessionId] !== run) return true;
        if (saved.status !== 'done' || saved.turn_id !== run.turnId) throw new Error('结束记录尚不可读，请重试核实');
        streamCtl.current[sessionId]?.abort();
        clearTyping(sessionId); typingBuf.current[sessionId] = '';
        appendAssistant(sessionId, { ...decodeChatTiming(saved), ...decodeChatReasoning(saved), role: 'assistant', content: saved.text || '', error: saved.error,
          thinking: saved.thinking || undefined, turnId: run.turnId, requestedModelRef: run.requestedModelRef });
        clearStream(sessionId);
        try { sessionStorage.removeItem(`easel_pending_turn:${sessionId}`); } catch { /* ignore */ }
        return true;
      }
      streamCtl.current[sessionId]?.abort();
      flushTyping(sessionId);
      appendAssistant(sessionId, {
        role: 'assistant',
        content: (run.content || '') + '\n\n_（已停止）_',
        stopped: true,
        turnId: run.turnId,
        requestedModelRef: run.requestedModelRef,
        thinking: run.thinking || undefined,
        activity: run.steps.join('\n') || undefined,
      });
      clearStream(sessionId);
      try { sessionStorage.removeItem(`easel_pending_turn:${sessionId}`); } catch { /* ignore */ }
      return true;
    } catch (error) {
      if (streamAcc.current[sessionId] === run && stopRequests.current[sessionId] === request) {
        const detail = error instanceof Error ? error.name === 'TimeoutError' ? '请求超时' : error.message : '连接失败';
        setStopErrors((prev) => ({ ...prev, [sessionId]: `停止请求失败：${detail}。后台状态未确认；可重试停止或保留记录新建对话。` }));
      }
      return false;
    } finally {
      if (stopRequests.current[sessionId] === request) {
        delete stopRequests.current[sessionId];
        setStoppingSessions((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
      }
    }
  }, [appendAssistant, clearStream]);

  // 辅助对话（侧边面板的子会话）：多实例（每个父会话可开多个）、转发消息、双向引用；
  // 主线程消息流不受影响。mode='create' 总是新建，'open'（默认）复用最近的。
  const handleQuestionAnswered = useCallback((sessionId: string, qid: string) => {
    answeredRef.current.add(qid);
    const accumulator = streamAcc.current[sessionId];
    if (!accumulator) return;
    const kept = accumulator.questions.filter(question=>question.id!==qid);
    if (kept.length===accumulator.questions.length) return;
    accumulator.questions=kept;
    setStreams(previous=>previous[sessionId]?{...previous,[sessionId]:{...previous[sessionId],questions:[...kept]}}:previous);
  }, []);
  const ensureSideChat = useCallback((): string | undefined => {
    const active = sessionsRef.current.find(item => item.id === activeSessionId);
    if (!active) return undefined;
    const existing = sideChatOf(active, sessionsRef.current);
    if (existing) return existing.id;
    const child = { ...createSession(active.persona), engine: active.engine || 'openclaw' as const, parentSessionId: active.id, title: sideChatTitle(active, sessionsRef.current) };
    const next = [child, ...sessionsRef.current];
    if (!saveSessions(next)) { showToast('辅助对话未能保存到本机', 'error'); return undefined; }
    sessionsRef.current = next;
    setSessions(next);
    return child.id;
  }, [activeSessionId]);
  const newSideChat = useCallback((): string | undefined => {
    const active = sessionsRef.current.find(item => item.id === activeSessionId);
    if (!active) return undefined;
    const child = { ...createSession(active.persona), engine: active.engine || 'openclaw' as const, parentSessionId: active.id, title: sideChatTitle(active, sessionsRef.current) };
    const next = [child, ...sessionsRef.current];
    if (!saveSessions(next)) { showToast('辅助对话未能保存到本机', 'error'); return undefined; }
    sessionsRef.current = next;
    setSessions(next);
    return child.id;
  }, [activeSessionId]);
  const handleOpenSideChat = useCallback((mode?: 'open' | 'create'): string | undefined => (
    mode === 'create' ? newSideChat() : ensureSideChat()
  ), [ensureSideChat, newSideChat]);
  const handleSideSend = useCallback((childId: string, text: string, attachments?: UploadedFile[], skills?: string[], requirements?: SkillRequirements, thinking?: ThinkingLevel, model?: string) => {
    const child = sessionsRef.current.find(item => item.id === childId);
    if (!child?.parentSessionId || child.parentSessionId !== activeIdRef.current) return false;
    return handleSendMessage(childId, text, attachments, skills, requirements, thinking, model);
  }, [handleSendMessage]);
  const handleSideStop = useCallback((childId: string) => {
    if (sessionsRef.current.some(item => item.id === childId)) void handleStopStream(childId);
  }, [handleStopStream]);
  const handleQuoteFromMain = useCallback((childId: string) => {
    const child = sessionsRef.current.find(item => item.id === childId);
    const parent = child?.parentSessionId ? sessionsRef.current.find(item => item.id === child.parentSessionId) : undefined;
    if (!parent) return;
    const quote = lastExchangeQuote(parent);
    if (!quote) { showToast('主对话还没有可引用的内容', 'info'); return; }
    addChatDraftQuote(childId, quote);
  }, []);
  const handleQuoteToMain = useCallback((childId: string) => {
    const child = sessionsRef.current.find(item => item.id === childId);
    if (!child?.parentSessionId) return;
    const reply = [...child.messages].reverse().find(message => message.role === 'assistant' && (message.content || '').trim());
    if (!reply) { showToast('辅助对话还没有可引用的回答', 'info'); return; }
    addChatDraftQuote(child.parentSessionId, (reply.content || '').slice(0, 600));
  }, []);
  const handleSideClose = useCallback((childId: string) => {
    const child = sessionsRef.current.find(item => item.id === childId);
    if (!child?.parentSessionId) return;
    const next = sessionsRef.current.map(item => item.id === childId ? {...item, sideClosed:true} : item);
    if (!saveSessions(next)) { showToast('关闭未能保存到本机', 'error'); return; }
    sessionsRef.current = next;
    setSessions(next);
    showToast('标签已关闭，记录和草稿已保留；可从“＋”重新打开。', 'info');
  }, []);
  const handleSideReopen = useCallback((childId: string) => {
    const child = sessionsRef.current.find(item => item.id === childId);
    if (!child?.parentSessionId || child.parentSessionId !== activeIdRef.current) return false;
    const next = sessionsRef.current.map(item=>item.id===childId?{...item,sideClosed:false}:item);
    if (!saveSessions(next)) { showToast('重新打开未能保存', 'error'); return false; }
    sessionsRef.current = next; setSessions(next); return true;
  }, []);
  const handleSideRename = useCallback((childId: string, title: string) => {
    const clean = title.trim();
    const child = sessionsRef.current.find(item => item.id === childId);
    if (!child?.parentSessionId || !clean || clean === child.title) return;
    const next = sessionsRef.current.map(item => item.id === childId ? { ...item, title: clean } : item);
    if (!saveSessions(next)) { showToast('重命名未能保存；请保留当前页面。', 'error'); return; }
    sessionsRef.current = next;
    setSessions(next);
    showToast('已重命名辅助对话', 'success');
  }, []);
  const handleSideReorder = useCallback((orderedIds: string[]) => {
    const order = new Map(orderedIds.map((id, index) => [id, index]));
    let changed = false;
    const next = sessionsRef.current.map(item => {
      if (!item.parentSessionId || !order.has(item.id)) return item;
      const sideOrder = order.get(item.id) as number;
      if (item.sideOrder === sideOrder) return item;
      changed = true;
      return { ...item, sideOrder };
    });
    if (!changed) return;
    if (!saveSessions(next)) { showToast('顺序未能保存；请保留当前页面。', 'error'); return; }
    sessionsRef.current = next;
    setSessions(next);
  }, []);


  const handleSteer = useCallback(async (sessionId: string, id: string) => {
    if (sessionsRef.current.find(s=>s.id===sessionId)?.engine === 'codex') {
      const item=getChatQueue(sessionId).items.find(row=>row.id===id), run=streamAcc.current[sessionId];
      if (!item || !run?.turnId || stopRequests.current[sessionId]) return false;
      if (item.attachments.length || item.missingAttachments.length || item.selectedSkills.length) {
        showToast('Codex 插话暂只支持文字，素材和技能请排队到下一轮。','error'); return false;
      }
      try {
        await codexRequest('steer',{sessionId,turnId:run.turnId,requestId:item.id,message:item.text,modelRef:item.modelRef,thinkingLevel:item.thinkingLevel});
        dispatchSelectedQueuedMessage(sessionId,id,()=>{
          setSessions(prev=>{const next=prev.map(s=>s.id===sessionId?{...s,messages:[...s.messages,{role:'user',content:item.text,requestedModelRef:item.modelRef,requestedThinkingLevel:item.thinkingLevel} as ChatMessage]}:s);saveSessions(next);return next;});
          return true;
        });
        return true;
      } catch(cause) {showToast(cause instanceof Error?cause.message:'Codex 插话失败，消息保留在队列。','error');return false;}
    }
    return steerQueuedMessage(sessionId, id,
    () => handleStopStream(sessionId, false), item => sendUserAndStream(sessionId, item.text, item.attachments,
      undefined, undefined, item.selectedSkills, item.skillRequirements, item.modelRef, item.thinkingLevel),
    () => Boolean(streamAcc.current[sessionId] || streamCtl.current[sessionId] || stopRequests.current[sessionId]
      || sessionsRef.current.find(session => session.id === sessionId)?.pendingTurnId));
  }, [handleStopStream, sendUserAndStream]);

  const handleSessionRename = useCallback((id: string, title: string) => {
    const t = title.trim();
    if (!t) return;
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, title: t } : s));
      const saved = saveSessions(next);
      showToast(saved ? '已保存对话标题' : '标题已在本页修改，但未能保存；请保留当前页面。', saved ? 'success' : 'error');
      return next;
    });
  }, []);

  const handleSessionPin = useCallback((id: string, pinned: boolean) => {
    setSessions(previous => {
      const next = setSessionPinned(previous, id, pinned);
      const saved = saveSessions(next);
      showToast(saved ? (pinned ? '已置顶对话' : '已取消置顶') : '置顶状态已在本页修改，但未能保存；请保留当前页面。', saved ? 'success' : 'error');
      return next;
    });
  }, []);

  const handleGenerateSessionTitle = useCallback(async (id: string) => {
    const session = sessionsRef.current.find(item => item.id === id);
    if (!session || session.importedFromBackup || streamCtl.current[id] || stopRequests.current[id]) {
      throw new Error('请在可编辑且已结束的对话中生成标题。');
    }
    return requestConversationTitle(session.messages.slice(-6).map(({ role, content }) => ({ role, content })));
  }, []);

  const handleSessionArchive = useCallback((id: string, archived: boolean) => {
    const target = sessionsRef.current.find((session) => session.id === id);
    if (!target) return;
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, archived } : s));
      const saved = saveSessions(next);
      showToast(saved ? (archived ? '已归档对话' : '已恢复对话') : '归档状态已在本页修改，但未能保存；请保留当前页面。', saved ? 'success' : 'error');
      return next;
    });
    // 归档当前会话只切换已有会话；由用户明确新建下一条。
    if (archived && id === activeSessionId) {
      const rest = sessionsRef.current.filter((s) => s.id !== id && !s.archived);
      const next = rest[0] || null;
      setActiveSessionId(next?.id || null);
      setSelectedPersona(next?.persona || '');
      if (!next) {
        saveActiveId(null);
        try { sessionStorage.removeItem(TAB_SESSION_KEY); } catch { /* ignore */ }
      }
      setCurrentPage('chat', true);
    } else if (!archived && !activeSessionId) {
      setActiveSessionId(id);
      setSelectedPersona(target.persona || '');
      setCurrentPage('chat', true);
    }
  }, [activeSessionId]);

  const handleNewChat = useCallback(() => {
    const newSession = createSession(selectedPersona || undefined);
    setSessions((prev) => {
      const updated = [newSession, ...prev];
      saveSessions(updated);
      return updated;
    });
    setActiveSessionId(newSession.id);
    setCurrentPage('chat', true);
  }, [selectedPersona]);

  const handleSessionSelect = useCallback((id: string) => {
    setActiveSessionId(id);
    const target = sessions.find(s => s.id === id);
    if (target) {
      setSelectedPersona(target.persona || '');
    }
    setCurrentPage('chat', true);
  }, [sessions]);

  async function openTaskConversation(id:string) {
    if(outputSessionDeleted(id)){showToast('原对话已删除，保留任务历史记录','info');return false;}
    try {
      const remote=await taskRequest<TaskSessionState>('/sessions');
      for(const row of remote.deletedSessions||[])markOutputSessionDeleted(row.id);
      if(outputSessionDeleted(id)||remote.deletedSessions?.some(row=>row.id===id)){refreshTasks();showToast('原对话已删除','info');return false;}
      let next=mergeTaskSessions(sessionsRef.current,remote.sessions,outputSessionDeleted);
      let target=next.find(session=>session.id===id);
      if (!target || (!target.importedFromBackup && !streamCtl.current[id] && !remote.sessions.some(session=>session.id===id))) {
        try {
          const stored = await readServerConversation(id);
          if (outputSessionDeleted(id)) { showToast('原对话已删除','info'); return false; }
          next = mergeTaskSessions(sessionsRef.current,remote.sessions,outputSessionDeleted);
          if (!streamCtl.current[id]) next = mergeServerConversation(next, stored);
          target = next.find(session => session.id === id);
        } catch (error) {
          if (!target || (error as {status?:number})?.status===410) throw error;
          // Existing local history stays readable during migration or an outage.
        }
      }
      if(!target||target.importedFromBackup){showToast('原对话暂不可用，请稍后重试','info');return false;}
      if(next!==sessionsRef.current){saveSessions(next);sessionsRef.current=next;setSessions(next);}
      refreshTasks();setActiveSessionId(id);setSelectedPersona(target.persona||'');setCurrentPage('chat');
      return true;
    }catch(e){showToast(e instanceof Error?e.message:'对话暂不可读，请重试','error');return false;}
  }

  const handleOutputConversation = useCallback(async (id: string, file: {path:string;name:string}) => {
    let target=sessionsRef.current.find(session=>session.id===id);
    if (!target) { showToast(outputSessionDeleted(id) ? '原对话已删除' : '未找到原对话，可能已删除或不在当前记录中', 'info'); return false; }
    if (target.importedFromBackup) { showToast('这是一份只读对话备份，无法继续操作', 'info'); return false; }
    if (target.archived && !await confirmModal('原对话已归档，恢复后继续？', {confirmLabel:'恢复并打开'})) return false;
    target=sessionsRef.current.find(session=>session.id===id);
    if (!target || outputSessionDeleted(id)) { showToast('原对话已删除', 'info'); return false; }
    if (target.importedFromBackup) return false;
    if (target.archived) {
      const next=sessionsRef.current.map(session=>session.id===id ? {...session,archived:false} : session);
      if (!saveSessions(next)) { showToast('恢复对话未能保存，请重试', 'error'); return false; }
      sessionsRef.current=next; setSessions(next);
    }
    const name=file.name.replace(/[[\]\\]/g, '\\$&');
    const quote=`内容库文件：[${name}](/api/media/${file.path.split('/').map(encodeURIComponent).join('/')})`;
    if (!getChatDraft(id).quotes?.includes(quote)) addChatDraftQuote(id, quote);
    setActiveSessionId(id); setSelectedPersona(target.persona || ''); setCurrentPage('chat', true);
    return true;
  }, [setCurrentPage]);

  const handleSessionDelete = useCallback(async (id: string) => {
    const target = sessionsRef.current.find((s) => s.id === id);
    if (!target || !(await confirmModal('删除对话并停止关联目标？'))) return;
    const latest = sessionsRef.current.find(session => session.id === id);
    if (!latest) return;
    let stopPending=false;
    if(!latest.importedFromBackup){
      try{
        const result=await taskRequest<{deleted:boolean;tombstone:SessionTombstone;stopPending:boolean}>(`/sessions/${encodeURIComponent(id)}/delete`,{});
        if(!result.deleted||result.tombstone?.id!==id)throw Error('删除状态未确认，请重试');
        stopPending=result.stopPending;
        refreshTasks();
      }catch(e){showToast(e instanceof Error?e.message:'删除未同步，请重试','error');return;}
    }

    if (target && !target.importedFromBackup) { clearChatDraft(id); clearChatQueue(id); }
    creationSessionDeleted(id);
    rememberOutputReferences(sessionsRef.current);
    if(!latest.importedFromBackup){markOutputSessionDeleted(id);removeSessionEvents(id);}
    const wasRunning = Boolean(streamCtl.current[id]);
    streamCtl.current[id]?.abort();   // 删除正在流式的会话时中止其流
    clearStream(id);
    try { sessionStorage.removeItem(`easel_pending_turn:${id}`); } catch { /* ignore */ }

    if (target?.sessionKey && !target.importedFromBackup && !wasRunning && !stopPending) {
      // Do not delete OpenClaw's session record while its agent is still
      // writing to it; the stop endpoint waits for backend cleanup first.
      void deleteRemoteSession(target.sessionKey).catch(() => {});
    }

    setSessions((prev) => {
      const updated = prev.filter((s) => s.id !== id);
      saveSessions(updated);

      if (id === activeSessionId) {
        if (updated.length > 0) {
          setActiveSessionId(updated[0].id);
        } else {
          const newSession = createSession();
          updated.unshift(newSession);
          saveSessions(updated);
          setActiveSessionId(newSession.id);
        }
      }
      return updated;
    });
    if(stopPending)showToast('对话已删除，后台停止待确认','info');
  }, [activeSessionId, clearStream, refreshTasks]);

  // 首次引导：跳过（用通用模式）
  const dismissRecommend = useCallback(() => {
    markOnboardingSeen();
    setShowRecommend(false);
  }, []);

  // 打开引导向导
  const openWizard = useCallback(() => {
    setShowRecommend(false);
    setShowWizard(true);
  }, []);

  // 画像创建完成
  const handleProfileCreated = useCallback((name: string) => {
    markOnboardingSeen();
    setShowWizard(false);
    fetchPersonas().then((list) => {
      setPersonas(list);
      setSelectedPersona(name);
      // 用新画像开一个新会话
      const newSession = createSession(name);
      setSessions((prev) => {
        const updated = [newSession, ...prev];
        saveSessions(updated);
        return updated;
      });
      setActiveSessionId(newSession.id);
      setCurrentPage('profile');
    }).catch(() => {});
  }, []);

  // 画像删除完成：刷新列表 + 若删的是当前选中的则清空选择
  const handleProfileDeleted = useCallback((name: string) => {
    fetchPersonas().then((list) => {
      setPersonas(list);
      setSelectedPersona((cur) => (cur === name ? '' : cur));
    }).catch(() => {});
  }, []);

  // 流式生命周期在 App，页面切换随意——ChatPage 可自由卸载/重挂，回来从 props 读流式态即可。
  const handleExportConversations = () => createConversationBackup(sessionsRef.current,
    Object.fromEntries(Object.entries(streamAcc.current).map(([id, run]) => [id, {
      content: run.content + (typingBuf.current[id] || ''),
      thinking: run.thinking,
      activity: run.steps.join('\n'),
    }])));

  const handleImportConversations = (backup: ConversationBackup) => {
    const imported = createImportedSessions(backup, sessionsRef.current.map(session => session.id));
    // Apply to the latest React state, not the state captured when the file was previewed.
    // Keep active selection and all live controllers untouched.
    setSessions(previous => {
      const next = [...imported, ...previous];
      saveSessions(next);
      return next;
    });
    return { count: imported.length, firstSessionId: imported[0]?.id };
  };

  const renderPage = () => {
    switch (currentPage) {
      case 'dashboard':
        return (
          <DashboardPage
            persona={selectedPersona}
            gatewayStatus={gatewayStatus}
            onNavigate={setCurrentPage}
            onNavigateAnalysis={(platform) => { setAnalysisPlatform(platform); setCurrentPage('analysis'); }}
            onOpenModels={(modelRef) => { setSettingsModelRef(modelRef); setSettingsSection('model'); setSettingsNavigationKey(key => key + 1); setCurrentPage('settings'); }}
            onUseTopic={handleUseTopic}
            onQuickPrompt={handleQuickPrompt}
          />
        );
      case 'image':
        return <CreationWorkspaceSlot kind="image" sessionId={currentCreation('image').sessionId}/>;
      case 'chat':
        return activeSession ? (
          <ChatPage
            key={activeSession.id}
            session={activeSession}
            taskState={tasks}
            onOpenAnalysis={() => { if (activeSession.analysisContext) setAnalysisPlatform(activeSession.analysisContext.platform); setCurrentPage('analysis'); }}
            onWriteFromAnalysis={() => handleWriting(activeSession.id)}
            sideSessions={sideChatsOf(activeSession, sessions)}
            closedSideSessions={sideChatsOf(activeSession, sessions, true).filter(item=>item.sideClosed)}
            onSideReopen={handleSideReopen}
            sideStreams={streams}
            sideStoppingSessions={stoppingSessions}
            sideStopErrors={stopErrors}
            onSideQuestionAnswered={handleQuestionAnswered}
            onSideSteer={handleSteer}
            onSideChat={handleOpenSideChat}
            onSideSend={handleSideSend}
            onSideStop={handleSideStop}
            onQuoteFromMain={handleQuoteFromMain}
            onQuoteToMain={handleQuoteToMain}
            onSideClose={handleSideClose}
            onSideRename={handleSideRename}
            onSideReorder={handleSideReorder}
            onShare={handleShareConversation}
            onLoadShare={handleLoadShareAppends}
            onTaskChange={refreshTasks}
            onOpenTask={id=>{setTaskTarget(id);window.location.hash=taskWorkspaceHash(id);setCurrentPage('tasks');}}
            onEngineChange={engine=>setSessions(prev=>{const next=prev.map(s=>s.id===activeSession.id&&!s.messages.length&&!s.pendingTurnId?{...s,engine}:s);saveSessions(next);return next;})}
            stream={streams[activeSession.id]}
            stopping={Boolean(stoppingSessions[activeSession.id])}
            stopError={stopErrors[activeSession.id]}
            onSend={(displayText, attachments, selectedSkills, skillRequirements, thinkingLevel, modelRef) => handleSendMessage(activeSession.id, displayText, attachments, selectedSkills, skillRequirements, thinkingLevel, modelRef)}
            onEdit={(index, text, signal) => handleEditMessage(activeSession.id, index, text, signal)}
            onOpenSource={id => { if (sessionsRef.current.some(session => session.id === id)) setActiveSessionId(id); else showToast(activeSession.writingContext ? '原分析已删除，已有写作内容保留；后续生成需重新准备' : '原对话已删除，当前编辑分支仍可继续。', 'info'); }}
            onStop={() => handleStopStream(activeSession.id)}
            onSteer={id => handleSteer(activeSession.id, id)}
            onNewChat={handleNewChat}
            onOpenModels={(modelRef) => { setSettingsModelRef(modelRef); setSettingsSection('model'); setSettingsNavigationKey(key => key + 1); setCurrentPage('settings'); }}
            onOpenAudit={(turnId)=>{setActivityTarget({sessionId:activeSession.id,turnId,key:Date.now()});setCurrentPage('activity');}}
            onResend={(userIndex, displayText, attachments, legacyAgentText) => handleResend(
              activeSession.id, userIndex, displayText, attachments, legacyAgentText,
            )}
            onQuestionAnswered={qid=>handleQuestionAnswered(activeSession.id,qid)}
            onScheduleDraft={(text) => { setAutomationDraft(text ? { objective: text } : {}); setCurrentPage('automation'); }}
          />
        ) : (
          <section className="chat-page chat-no-session" aria-label="开始新对话">
            <h1>开始新对话</h1>
            <p>已归档的内容保留在对话列表中，可以随时查看或取消归档。</p>
            <button type="button" className="btn" onClick={handleNewChat}>新建对话</button>
          </section>
        );
      case 'trends':
        return <TrendsPage onUseTopic={handleUseTopic} />;
      case 'automation':
        return <AutomationPage sessions={sessions} sessionId={activeSessionId} initialDraft={automationDraft} onDraftConsumed={()=>setAutomationDraft(null)} onOpen={id=>void openTaskConversation(id)}/>;
      case 'tasks':
        return <TaskWorkspacePage data={tasks} sessions={sessions} sync={taskSync} selectedId={taskTarget}
          onSelect={id=>{setTaskTarget(id);window.location.hash=taskWorkspaceHash(id);}} onRefresh={refreshTasks}
          onOpenChat={id=>void openTaskConversation(id)}
          onOpenActivity={(sessionId,turnId='')=>{setActivityTarget({sessionId,turnId,key:Date.now()});setCurrentPage('activity');}}
          onOpenOffice={sessionId=>{setOfficeTarget({sessionId,key:Date.now()});setCurrentPage('agent-office');}}
          onNew={()=>{const session=createSession(selectedPersona||undefined);setSessions(old=>{const next=[session,...old];saveSessions(next);return next;});setChatDraftText(session.id,'/goal ');setActiveSessionId(session.id);setCurrentPage('chat');}}
          onSchedules={()=>setCurrentPage('automation')}/>;
      case 'ideas':
        return <IdeasPage onUseTopic={handleUseTopic} />;
      case 'calendar':
        return <CalendarPage />;
      case 'publish':
        return <CreationWorkspaceSlot kind="publish" sessionId={currentCreation('publish').sessionId}/>;
      case 'publish-receipts':
        return <PublishReceiptsPage model={publishReceipts} onOpenPublish={() => setCurrentPage('publish')}
          onAccounts={() => setCurrentPage('accounts')}
          onConfigure={() => { setSettingsSection('notify'); setSettingsNavigationKey(key => key + 1); setCurrentPage('settings'); }} />;
      case 'breakdown':
        return <BreakdownPage persona={selectedPersona} onStart={handleStartBreakdown} onOpenRun={handleOpenBreakdownRun} />;
      case 'skills':
        return <SkillPage onOpenChat={handleSkillChat} />;
      case 'outputs':
        return <OutputsPage sessions={sessions} sessionsLoading={sessionsLoading} onOpenConversation={handleOutputConversation} initialFilter={outputFilter} jumpPath={outputJumpPath} onJumpHandled={() => { setOutputJumpPath(''); window.history.replaceState(null, '', window.location.pathname + window.location.search); }} onReferenceImage={(image) => { selectCreation('image',null); videoStudio.setViewMode('image'); setCurrentPage('image'); void imageStudio.useGalleryReference(image); }} onReuseImage={(prompt, size) => { selectCreation('image',null); videoStudio.setViewMode('image'); imageStudio.setImgPrompt(prompt); if (size) imageStudio.setImgSize(size); imageStudio.setMode('generate'); setCurrentPage('image'); }} />;
      case 'accounts':
        return <AccountsPage onAnalysisLogin={() => setAnalysisAutoCollect((value) => value + 1)} onNavigateAnalysis={(platform) => { setAnalysisPlatform(platform); setCurrentPage('analysis'); }} />;
      case 'analysis':
        return <ContentAnalysisPage onAnalysisChat={handleAnalysisChat} demoEnabled={demoDataPreference.enabled} initialPlatform={analysisPlatform} autoCollectSignal={analysisAutoCollect} onAutoCollectHandled={() => setAnalysisAutoCollect(0)} onNavigateAccounts={() => setCurrentPage('accounts')} onNavigateIdeas={() => setCurrentPage('ideas')} />;
      case 'activity':
        return <ActivityPage onOpenChat={id=>void openTaskConversation(inspectionSessions.find(item=>item.id===id&&item.taskWorker)?.parentSessionId||id)} onOpenSchedules={()=>setCurrentPage('automation')} onOpenPublish={()=>setCurrentPage('publish')} key={activityTarget?.key||"default"} sessions={inspectionSessions} activeSessionId={activeSessionId} streams={streams} target={activityTarget||undefined} onOpenOffice={sessionId => { setOfficeTarget({ sessionId, key: Date.now() }); setCurrentPage('agent-office'); }} />;
      case 'agent-office':
        return <AgentOfficePage key={officeTarget?.key || "default"} initialSessionId={officeTarget?.sessionId} demoEnabled={demoDataPreference.enabled} onOpenModels={() => { setSettingsSection('model'); setSettingsNavigationKey(key => key + 1); setCurrentPage('settings'); }} onOpenOutputs={() => { setOutputFilter('all'); setCurrentPage('outputs'); }} onOpenSettings={() => { setSettingsSection('employees'); setSettingsNavigationKey(key => key + 1); setCurrentPage('settings'); }} sessions={inspectionSessions} activeSessionId={activeSessionId} streams={streams} onStartTask={handleOfficeTask} onStopTask={handleStopStream} stoppingSessions={stoppingSessions} stopErrors={stopErrors} onOpenChat={id=>void openTaskConversation(inspectionSessions.find(item=>item.id===id&&item.taskWorker)?.parentSessionId||id)} onOpenActivity={(sessionId, turnId = '') => { setActivityTarget({sessionId, turnId, key: Date.now()}); setCurrentPage('activity'); }} />;
      case 'profile':
        return <ProfilePage key={selectedPersona} persona={selectedPersona} onNewProfile={() => setShowWizard(true)} onDeleted={handleProfileDeleted} onSource={id=>{const source=sessionsRef.current.find(item=>item.id===id);if(!source||source.importedFromBackup||outputSessionDeleted(id)){showToast('原对话已删除或不在当前记录中','info');return;}handleSessionSelect(id);}} />;
      case 'settings':
        return <SettingsPanel onAssessUpdate={handleQuickPrompt} demoDataPreference={demoDataPreference} initialSection={settingsSection} targetModelRef={settingsModelRef} navigationKey={settingsNavigationKey} onOpenOffice={() => { setOfficeTarget(null); setCurrentPage('agent-office'); }} conversationBackup={{
          onExport: handleExportConversations,
          onExportRaw: exportRawConversationStorage,
          onImport: handleImportConversations,
          onOpenSession: handleSessionSelect,
        }} />;
      default:
        return null;
    }
  };

  const handlePersonaChange = useCallback((persona: string) => {
    const writing = sessionsRef.current.find(session => session.id === activeSessionId)?.writingContext;
    if (writing && (persona || '') !== writing.persona) {
      showToast('写作沿用接收时的画像；可回原分析切换画像后重新准备', 'info');
      return;
    }
    setSelectedPersona(persona);
    setCurrentPage('chat');
    // 修复：选/切画像不再新建空会话丢上下文。就地把当前会话的画像设为新选的、
    // 保留会话 id 与历史（画像只是每轮的系统前缀，中途换安全）。想开新线程用「New Chat」。
    const cur = sessionsRef.current.find((s) => s.id === activeSessionId);
    if (cur) {
      setSessions((prev) => {
        const updated = prev.map((s) =>
          s.id === activeSessionId ? { ...s, persona: persona || undefined } : s);
        saveSessions(updated);
        return updated;
      });
    } else {
      // 无活跃会话（极少）才新建
      const ns = createSession(persona || undefined);
      setSessions((prev) => { const u = [ns, ...prev]; saveSessions(u); return u; });
      setActiveSessionId(ns.id);
    }
  }, [activeSessionId]);

  return (
    <div className={`app-layout${currentPage === 'chat' ? ' app-layout-chat' : ''}`}>
      <ToastHost />
      <CreationWorkspaceHost studio={imageStudio} video={videoStudio} receipts={publishReceipts} sessions={sessions} persona={selectedPersona}
        onPromptSkill={handleImagePromptSkill}
        onOpenChat={handleSessionSelect} onNewChat={()=>{const session=createSession(selectedPersona || undefined);session.conversationType='content-generation';setSessions(previous=>{const next=[session,...previous];saveSessions(next);return next;});return session.id;}}
        onOpenSettings={()=>{setSettingsSection('image');setCurrentPage('settings');}}
        onOpenVideoSettings={()=>{setSettingsSection('video');setCurrentPage('settings');}}
        onOpenOutputs={()=>{setOutputFilter('image');setCurrentPage('outputs');}}
        onOpenPublishOutputs={()=>{setOutputFilter('all');setCurrentPage('outputs');}}
        onOpenAccounts={()=>setCurrentPage('accounts')}
        onExpand={kind=>setCurrentPage(kind)} />
      <Sidebar
        currentPage={currentPage}
        onPageChange={(page, preserveConversations = false) => { if (page === 'agent-office') setOfficeTarget(null); if (page === 'activity') setActivityTarget(null); if (page === 'settings') { setSettingsModelRef(undefined); setSettingsSection('model'); setSettingsNavigationKey(key => key + 1); } setCurrentPage(page, preserveConversations); }}
        personas={personas}
        selectedPersona={selectedPersona}
        onPersonaChange={handlePersonaChange}
        onNewProfile={() => setShowWizard(true)}
        sessions={sessions}
        runningSessions={Object.keys(streams)}
        stoppingSessions={Object.keys(stoppingSessions).filter(id => stoppingSessions[id])}
        taskState={tasks}
        sessionsLoading={sessionsLoading}
        activeSessionId={activeSessionId}
        activeSessionHasMessages={activeSession ? activeSession.messages.length > 0 : false}
        onSessionSelect={handleSessionSelect}
        onSessionDelete={handleSessionDelete}
        onSessionRename={handleSessionRename}
        onGenerateSessionTitle={handleGenerateSessionTitle}
        onSessionArchive={handleSessionArchive}
        onSessionPin={handleSessionPin}
        onNewChat={handleNewChat}
        gatewayStatus={gatewayStatus}
        gatewayRecoveryNote={gatewayRecoveryNote}
        runtime={runtime}
        onGatewayRetry={retryGateway}
        eventNotifications={<EventNotificationCenter
          onNoticeAcknowledged={sessionId => markSessionSeenById(sessionId, sessionsRef.current)}
          onOpen={async target => {
          if (target.page === 'chat' && target.sessionId) {
            if (!await openTaskConversation(target.sessionId)) return false;
            if (target.tool) {
              requestCreationPanel(target.tool,target.sessionId);
            }
            if(target.receiptId) { publishReceipts.open(target.receiptId); }
            return true;
          }
          if (target.page === 'image' && target.medium) videoStudio.setViewMode(target.medium);
          if (target.page === 'outputs') {
            setOutputFilter(target.filter || 'all');
            setOutputJumpPath(target.path || '');
          }
          if (target.page === 'publish-receipts') { publishReceipts.open(target.receiptId); return true; }
          setCurrentPage(target.page);
          return true;
        }} />}
      />
      <main className="main-content">
        <StorageNotice onOpenBackup={() => { setSettingsSection('backup'); setSettingsNavigationKey(key => key + 1); setCurrentPage('settings'); }} />
        <PublishReceiptCenter model={publishReceipts} showEntry={false} mode="notices"
          onConfigure={() => { setSettingsSection('notify'); setSettingsNavigationKey(key => key + 1); setCurrentPage('settings'); }}
          onOpenPublish={() => setCurrentPage('publish')} />
        {(['trends', 'ideas', 'calendar', 'publish', 'publish-receipts', 'breakdown'] as Page[]).includes(currentPage) && (
          <SubNav current={currentPage} onNavigate={setCurrentPage} />
        )}
        <div className="page-host">
          {renderPage()}
        </div>
      </main>

      <FailureRecordDialog/>
      {/* 首次使用：推荐配置画像 */}
      {showRecommend && (
        <div className="overlay">
          <div className="modal" style={{ width: 420, maxWidth: '100%', textAlign: 'center' }}>
            <div style={{ fontSize: 'calc(40px * var(--easel-font-scale, 1))' }}>👋</div>
            <h2 style={{ margin: '12px 0 8px', fontSize: 'calc(20px * var(--easel-font-scale, 1))' }}>欢迎使用 Easel</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: 'calc(14px * var(--easel-font-scale, 1))', lineHeight: 1.6 }}>
              配置你的账号画像，生成的内容会更贴合你的风格、受众和平台调性。<br />
              大约 2 分钟，也可以随时在侧栏「+ 新建画像」补配。
            </p>
            <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'center' }}>
              <button className="btn" onClick={dismissRecommend}>先用通用模式</button>
              <button className="btn btn-primary" onClick={openWizard}>开始配置</button>
            </div>
          </div>
        </div>
      )}

      {/* 画像配置向导 */}
      {skillConfiguration && <SkillDrawer skillName={skillConfiguration} onClose={() => setSkillConfiguration(undefined)}
        onConfigured={() => window.dispatchEvent(new CustomEvent('easel:skill-configured'))}
        onOpenChat={handleSkillChat} />}
      {showWizard && (
        <OnboardingWizard onClose={() => setShowWizard(false)} onCreated={handleProfileCreated} />
      )}
    </div>
  );
}
