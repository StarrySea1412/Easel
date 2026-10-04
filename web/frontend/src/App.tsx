import { chatErrorDetail } from './lib/chatErrors';
import { drainStreamRun } from './lib/streamLifecycle';
import { createLazyPage } from './lib/lazyPage';
import StorageNotice from './components/StorageNotice';
import { useImageStudio } from './hooks/useImageStudio';
import { useVideoStudio } from './hooks/useVideoStudio';
import { useState, useEffect, useCallback, useRef } from 'react';
import Sidebar from './components/Sidebar';
import type { Page } from './components/Sidebar';
import DashboardPage from './components/DashboardPage';
import SubNav from './components/SubNav';
import OnboardingWizard from './components/OnboardingWizard';
import type { SettingsSection } from './components/SettingsPanel';
import { fetchStatus, fetchPersonas, streamChat, fetchLastTurn, stopChat } from './lib/api';
import type { PersonaItem, UploadedFile, ChatQuestion } from './lib/api';
import { questionStatus } from './lib/api';
import { deleteSession as deleteRemoteSession } from './lib/api';
import {
  loadSessions,
  saveSessions,
  createSession,
  updateSessionTitle,
  loadActiveId,
  saveActiveId,
} from './lib/store';
import type { ChatSession, ChatMessage, StreamState } from './lib/store';
import { createConversationBackup, createImportedSessions, type ConversationBackup } from './lib/conversationBackup';
import { exportRawConversationStorage } from './lib/conversationStorageBackup';
import { clearChatDraft } from './lib/chatDrafts';

const ImageStudioPage = createLazyPage('生图工坊', () => import('./components/ImageStudioPage'));
const ChatPage = createLazyPage('对话', () => import('./components/ChatPage'));
const SkillPage = createLazyPage('技能库', () => import('./components/SkillPage'));
const OutputsPage = createLazyPage('内容库', () => import('./components/OutputsPage'));
const ActivityPage = createLazyPage('运行记录', () => import('./components/ActivityPage'));
const AgentOfficePage = createLazyPage('Agent 办公室', () => import('./components/AgentOfficePage'));
const AccountsPage = createLazyPage('账号', () => import('./components/AccountsPage'));
const ContentAnalysisPage = createLazyPage('内容分析', () => import('./components/ContentAnalysisPage'));
const ProfilePage = createLazyPage('画像', () => import('./components/ProfilePage'));
const TrendsPage = createLazyPage('热点雷达', () => import('./components/TrendsPage'));
const CalendarPage = createLazyPage('内容日历', () => import('./components/CalendarPage'));
const IdeasPage = createLazyPage('选题库', () => import('./components/IdeasPage'));
const PublishPage = createLazyPage('发布中心', () => import('./components/PublishPage'));
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
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const imageStudio = useImageStudio(currentPage === 'image');
  const videoStudio = useVideoStudio(currentPage === 'image');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('model');
  const [settingsNavigationKey, setSettingsNavigationKey] = useState(0);
  const [analysisPlatform, setAnalysisPlatform] = useState('xiaohongshu');
  const [analysisAutoCollect, setAnalysisAutoCollect] = useState(0);
  const [outputFilter, setOutputFilter] = useState('');
  const [personas, setPersonas] = useState<PersonaItem[]>([]);
  const [selectedPersona, setSelectedPersona] = useState('');
  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessions());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [gatewayStatus, setGatewayStatus] = useState('connecting');
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

    const settle = (id: string, sess: ChatSession[]) => {
      setSessions(sess);
      setActiveSessionId(id);
      const s = sess.find((x) => x.id === id);
      if (s) setSelectedPersona(s.persona || '');
      try { sessionStorage.setItem(TAB_SESSION_KEY, id); } catch { /* ignore */ }
      ch?.postMessage({ type: 'claim', sessionId: id });
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
    const candidate = lastId && existing.find((s) => s.id === lastId) ? lastId : null;
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

    // 3) 无候选 / 不支持 BroadcastChannel：退化为原逻辑（复用空会话或新建；后端 flock 兜底防崩）
    if (candidate) {
      settle(candidate, existing);
    } else {
      const empty = existing.find((s) => s.messages.length === 0);
      if (empty) settle(empty.id, existing);
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

  // Fetch status on mount — 真实反映 gateway 状态 + 首次引导检测
  useEffect(() => {
    fetchStatus()
      .then((data) => {
        setPersonas(data.personas || []);
        setGatewayStatus(data.gateway ? 'connected' : 'disconnected');
        // 首次使用：没有任何个性化画像 且 未看过引导 → 推荐配置
        if ((data.personas || []).length === 0 && !onboardingSeen()) {
          setShowRecommend(true);
        }
      })
      .catch(() => {
        setGatewayStatus('disconnected');
      });
  }, []);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || null;

  // 最新 sessions 的 ref，供回调里读取而不必进依赖数组（避免闭包过期/频繁重建）
  const sessionsRef = useRef(sessions);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

  // 当前活跃会话 id 的 ref：供跨标签「谁在用会话 X」查询时即时应答（见挂载 effect）
  const activeIdRef = useRef<string | null>(activeSessionId);
  useEffect(() => { activeIdRef.current = activeSessionId; }, [activeSessionId]);

  // ---- 流式对话：状态与生命周期都放在 App（永不卸载），切页/切 ChatPage 都不中断/丢失 ----
  const [streams, setStreams] = useState<Record<string, StreamState>>({});
  const streamCtl = useRef<Record<string, AbortController>>({});
  const [activityTarget,setActivityTarget]=useState<{sessionId:string;turnId:string;key:number}|null>(null);
  const streamAcc = useRef<Record<string, { turnId?:string; content: string; thinking: string; steps: string[]; questions: ChatQuestion[] }>>({});
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
    setSessions((prev) => {
      const next = prev.map((s) =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, msg], sessionKey: sessionKey || s.sessionKey, pendingTurnId: undefined }
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

  // 启动一次流式（fetch + 累积 + 回调）——只管流，不动消息列表
  const startStream = useCallback((
    sessionId: string,
    text: string,
    persona: string | undefined,
    attachments: UploadedFile[] = [],
    selectedSkills: string[] = [],
  ) => {
    const turnId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try { sessionStorage.setItem(`easel_pending_turn:${sessionId}`, turnId); } catch { /* ignore */ }
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === sessionId ? { ...s, pendingTurnId: turnId } : s));
      saveSessions(next); return next;
    });
    const runAcc = { turnId, content:'', thinking:'', steps:[] as string[], questions:[] as ChatQuestion[] };
    streamAcc.current[sessionId] = runAcc;
    setStreams((prev) => ({ ...prev, [sessionId]: { content: '', thinking: '', activity: '', questions: [] } }));
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
      (sessionKey) => {
        // done 不能立即 flush——token 和 done 几乎同时到达（OpenClaw 攒批），
        // 立即 flush 会把整包瞬间冲出，打字机白做。等队列吐完再落盘。
        drainStreamRun(() => streamAcc.current[sessionId] === runAcc, () => Boolean(typingBuf.current[sessionId]), () => {
          const a = streamAcc.current[sessionId];
          appendAssistant(sessionId, {
            role: 'assistant', content: a?.content || '', turnId,
            thinking: a?.thinking || undefined, activity: a?.steps.join('\n') || undefined,
          }, sessionKey);
          clearStream(sessionId);
          try { sessionStorage.removeItem(`easel_pending_turn:${sessionId}`); } catch { /* ignore */ }
        });
      },
      (err) => {
        drainStreamRun(() => streamAcc.current[sessionId] === runAcc, () => Boolean(typingBuf.current[sessionId]), () => {
          const a = streamAcc.current[sessionId];
          appendAssistant(sessionId, {
            role: 'assistant',
            content: a?.content || '', error:chatErrorDetail(err),
            turnId,
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
        setStreams((p) => (p[sessionId] && streamAcc.current[sessionId] === runAcc ? { ...p, [sessionId]: { ...p[sessionId], activity: status, stillWorking: undefined } } : p));
      },
      // onInterrupted：SSE 被中断（长任务时代理掐断），但后端仍在跑并会落盘完整结果。
      // streamChat 会按 eventId 自动重连并补发遗漏事件；这里只更新用户可见状态。
      () => {
        setStreams((p) => (p[sessionId] && streamAcc.current[sessionId] === runAcc
          ? { ...p, [sessionId]: { ...p[sessionId], activity: '⏳ 连接中断，正在自动续接…' } } : p));
      },
      turnId,
      false,
      undefined,
      attachments,
      (q) => {
        // ask_user 问答题：追加进流式状态（去重），ChatPage 渲染为选项卡片
        // 重放可能带已解决/已过期的旧问题，先查状态只留 pending（失败则保留）
        const a = streamAcc.current[sessionId]; if (a !== runAcc) return;
        if (a.questions.some((x) => x.id === q.id)) return;
        if (answeredRef.current.has(q.id)) return;   // 本会话已答过：不再重现
        void questionStatus([q.id]).then((st) => {
          const s = st[q.id]?.status;
          // 只显示仍 pending 的：answered/expired/cancelled/not_found/unknown 一律过滤
          if (s && s !== 'pending' || answeredRef.current.has(q.id)) return;
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
    );
  }, [appendAssistant, clearStream]);

  // 刷新/重开页面后按 eventId=0 重放当前 job，再继续实时 tail；旧任务无事件日志时退回最终快照。
  const resumePendingTurn = useCallback((sessionId: string) => {
    if (streamCtl.current[sessionId] || streamAcc.current[sessionId]) return;  // 本标签正在跑，不插手
    const s = sessionsRef.current.find((x) => x.id === sessionId);
    if (s?.importedFromBackup) return;
    const last = s?.messages[s.messages.length - 1];
    if (!last || last.role !== 'user') return;   // 没有悬空的用户消息 = 无需恢复
    let turnId = s.pendingTurnId;
    try { turnId = sessionStorage.getItem(`easel_pending_turn:${sessionId}`) || turnId; } catch { /* use persisted id */ }
    const runAcc = { turnId, content:'', thinking:'', steps:[] as string[], questions:[] as ChatQuestion[] };
    streamAcc.current[sessionId] = runAcc;
    setStreams((p) => ({ ...p, [sessionId]: { content: '', thinking: '', activity: '⏳ 正在接回上一轮结果…', questions: [] } }));
    typingBuf.current[sessionId] = '';
    startTypingPump(sessionId);
    if (!turnId) {
      void fetchLastTurn(sessionId).then((r) => {
        if (streamAcc.current[sessionId] !== runAcc) return;
        if (r.status === 'done') appendAssistant(sessionId, { role: 'assistant', content: r.text || (r.error?'':'（无输出）'), error:r.error, thinking: r.thinking || undefined, turnId:r.turn_id });
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
      (sessionKey) => {
        drainStreamRun(() => streamAcc.current[sessionId] === runAcc, () => Boolean(typingBuf.current[sessionId]), () => {
          const a = streamAcc.current[sessionId];
          appendAssistant(sessionId, {
            role: 'assistant', content: a?.content || '（无输出）', turnId,
            thinking: a?.thinking || undefined, activity: a?.steps.join('\n') || undefined,
          }, sessionKey);
          clearStream(sessionId);
          try { sessionStorage.removeItem(`easel_pending_turn:${sessionId}`); } catch { /* ignore */ }
        });
      },
      (err) => {
        drainStreamRun(() => streamAcc.current[sessionId] === runAcc, () => Boolean(typingBuf.current[sessionId]), () => {
          const a = streamAcc.current[sessionId];
          appendAssistant(sessionId, { role: 'assistant', content: a?.content || '', error:chatErrorDetail(err), turnId, thinking: a?.thinking || undefined, activity: a?.steps.join('\n') || undefined });
          clearStream(sessionId);
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
        setStreams((p) => (p[sessionId] && streamAcc.current[sessionId] === runAcc ? { ...p, [sessionId]: { ...p[sessionId], activity: status } } : p));
      },
      () => setStreams((p) => (p[sessionId] && streamAcc.current[sessionId] === runAcc
        ? { ...p, [sessionId]: { ...p[sessionId], activity: '⏳ 正在自动续接…' } } : p)),
      turnId,
      true,
      () => {
        // The event log may disappear after a backend restart. Prefer the
        // completed per-session snapshot; otherwise terminate stale recovery.
        void fetchLastTurn(sessionId, turnId).then((r) => {
          if(streamAcc.current[sessionId]!==runAcc)return;
          if (r.status === 'done') {
            appendAssistant(sessionId, { role: 'assistant', content: r.text || (r.error?'':'（无输出）'), error:r.error, thinking: r.thinking || undefined, turnId });
          } else {
            appendAssistant(sessionId, {
              role: 'assistant',
              content: '上一轮任务记录已失效，无法继续恢复。请重新发送上一条消息。',
            });
          }
          clearStream(sessionId);
          try { sessionStorage.removeItem(`easel_pending_turn:${sessionId}`); } catch { /* ignore */ }
        }).catch(() => {
          if(streamAcc.current[sessionId]!==runAcc)return;
          appendAssistant(sessionId, {
            role: 'assistant', content: '上一轮任务记录已失效，请重新发送上一条消息。',
          });
          clearStream(sessionId);
        });
      },
      undefined,   // attachments: 恢复轮次无新附件
      (q) => {
        const a = streamAcc.current[sessionId]; if (a !== runAcc) return;
        if (a.questions.some((x) => x.id === q.id)) return;
        if (answeredRef.current.has(q.id)) return;   // 本会话已答过：不再重现
        // 重放可能带已解决/已过期的旧问题（gateway 15s 后即清理）——先查状态只留 pending；
        // 查询失败时保留原样（宁显示不丢题）。
        void questionStatus([q.id]).then((st) => {
          const s = st[q.id]?.status;
          // 只显示仍 pending 的：answered/expired/cancelled/not_found/unknown 一律过滤
          //（unknown 通常=问题已从 gateway 清理，即已答或已过期，重放旧事件时不该重现）
          if (s && s !== 'pending' || answeredRef.current.has(q.id)) return;
          const a2 = streamAcc.current[sessionId]; if (a2 !== runAcc) return;
          if (a2.questions.some((x) => x.id === q.id)) return;
          a2.questions.push(q);
          setStreams((p) => (p[sessionId] && streamAcc.current[sessionId] === runAcc
            ? { ...p, [sessionId]: { ...p[sessionId], questions: [...a2.questions] } } : p));
        });
      },
      // onHeartbeat：同上，独立的「未卡住」提示，不覆盖 activity/thinking。
      (note) => setStreams((p) => (p[sessionId] && streamAcc.current[sessionId] === runAcc ? { ...p, [sessionId]: { ...p[sessionId], stillWorking: note } } : p)),
    );
  }, [appendAssistant, clearStream]);

  // 活跃会话确定后（含挂载首刷）尝试恢复它悬空的一轮
  useEffect(() => {
    if (activeSessionId) resumePendingTurn(activeSessionId);
  }, [activeSessionId, resumePendingTurn]);

  // 落用户消息（可选先把 messages 截断到 truncateAt）→ 启动流。retry/edit 都走这里。
  const sendUserAndStream = useCallback((
    sessionId: string,
    displayText: string,
    attachments: UploadedFile[] = [],
    legacyAgentText?: string,
    truncateAt?: number,
    selectedSkills: string[] = [],
  ) => {
    const visible = displayText.trim();
    const agentMessage = (legacyAgentText || displayText).trim();
    if ((!agentMessage && attachments.length === 0) || streamCtl.current[sessionId] || stopRequests.current[sessionId]) return false;
    const cur = sessionsRef.current.find((s) => s.id === sessionId);
    if (cur?.importedFromBackup) return false;
    const persona = cur?.persona || selectedPersona || undefined;
    setSessions((prev) => {
      const next = prev.map((s) => {
        if (s.id !== sessionId) return s;
        const base = truncateAt != null ? s.messages.slice(0, truncateAt) : s.messages;
        const updated = {
          ...s,
          messages: [...base, {
            role: 'user',
            content: visible,
            selectedSkills,
            ...(attachments.length ? { attachments } : {}),
            ...(legacyAgentText && legacyAgentText !== visible ? { agentContent: legacyAgentText } : {}),
          } as ChatMessage],
        };
        updateSessionTitle(updated);
        return updated;
      });
      saveSessions(next);
      return next;
    });
    startStream(sessionId, agentMessage, persona, attachments, selectedSkills);
    return true;
  }, [selectedPersona, startStream]);

  const handleSendMessage = useCallback((sessionId: string, displayText: string, attachments?: UploadedFile[], selectedSkills: string[] = []) => {
    if (!sessionsRef.current.some(session => session.id === sessionId)) return false;
    return sendUserAndStream(sessionId, displayText, attachments, undefined, undefined, selectedSkills);
  }, [sendUserAndStream]);

  // 重试/编辑重发：从该用户消息处截断（丢弃它及其之后），用 text 重新发起。
  const handleResend = useCallback((
    sessionId: string,
    userIndex: number,
    displayText: string,
    attachments?: UploadedFile[],
    legacyAgentText?: string,
  ) => {
    const selectedSkills = sessionsRef.current.find((session) => session.id === sessionId)?.messages[userIndex]?.selectedSkills || [];
    sendUserAndStream(sessionId, displayText, attachments, legacyAgentText, userIndex, selectedSkills);
  }, [sendUserAndStream]);

  // 热点「一键做成内容」：新开会话，把选题作为指令发出去，跳到对话页。
  const handleUseTopic = useCallback((title: string) => {
    const prompt = `围绕当前热点「${title}」：先判断它适不适合我的账号赛道；若合适，给 2-3 个差异化的二创角度，并把你最推荐的那条写成可直接发布的文案初稿。`;
    const ns = createSession(selectedPersona || undefined);
    setSessions((prev) => { const u = [ns, ...prev]; saveSessions(u); return u; });
    setActiveSessionId(ns.id);
    setCurrentPage('chat');
    sendUserAndStream(ns.id, prompt);
  }, [selectedPersona, sendUserAndStream]);

  // 工作台「一句话开干」：用户输入什么就发什么，不再替用户编排指令（v2 直达创作入口）。
  const handleQuickPrompt = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    const ns = createSession(selectedPersona || undefined);
    setSessions((prev) => { const u = [ns, ...prev]; saveSessions(u); return u; });
    setActiveSessionId(ns.id);
    setCurrentPage('chat');
    sendUserAndStream(ns.id, t);
  }, [selectedPersona, sendUserAndStream]);

  const handleStopStream = useCallback(async (sessionId: string) => {
    if (sessionsRef.current.find(s => s.id === sessionId)?.importedFromBackup) return;
    const run = streamAcc.current[sessionId];
    if (!run || stopRequests.current[sessionId]) return;
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
      const result = await stopChat(sessionId);
      if (streamAcc.current[sessionId] !== run || stopRequests.current[sessionId] !== request) return;
      if (!result.stopped) {
        setStopErrors((prev) => ({ ...prev, [sessionId]: '后端尚未确认本轮已停止。已保留连接和恢复记录，等待结果或重试停止。' }));
        return;
      }
      streamCtl.current[sessionId]?.abort();
      flushTyping(sessionId);
      appendAssistant(sessionId, {
        role: 'assistant',
        content: (run.content || '') + '\n\n_（已停止）_',
        turnId: run.turnId,
        thinking: run.thinking || undefined,
        activity: run.steps.join('\n') || undefined,
      });
      clearStream(sessionId);
      try { sessionStorage.removeItem(`easel_pending_turn:${sessionId}`); } catch { /* ignore */ }
    } catch (error) {
      if (streamAcc.current[sessionId] === run && stopRequests.current[sessionId] === request) {
        const detail = error instanceof Error ? error.message : '连接失败';
        setStopErrors((prev) => ({ ...prev, [sessionId]: `停止请求失败：${detail}。任务可能仍在运行，已保留连接和恢复记录，请重试停止。` }));
      }
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

  const handleSessionRename = useCallback((id: string, title: string) => {
    const t = title.trim();
    if (!t) return;
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, title: t } : s));
      saveSessions(next);
      return next;
    });
  }, []);

  const handleSessionArchive = useCallback((id: string, archived: boolean) => {
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, archived } : s));
      saveSessions(next);
      return next;
    });
    // 归档当前激活会话 → 切到另一个未归档会话或新建
    if (archived && id === activeSessionId) {
      const rest = sessionsRef.current.filter((s) => s.id !== id && !s.archived);
      if (rest.length) {
        setActiveSessionId(rest[0].id);
      } else {
        const ns = createSession(selectedPersona || undefined);
        setSessions((prev) => { const u = [ns, ...prev]; saveSessions(u); return u; });
        setActiveSessionId(ns.id);
      }
      setCurrentPage('chat');
    }
  }, [activeSessionId, selectedPersona]);

  const handleNewChat = useCallback(() => {
    const newSession = createSession(selectedPersona || undefined);
    setSessions((prev) => {
      const updated = [newSession, ...prev];
      saveSessions(updated);
      return updated;
    });
    setActiveSessionId(newSession.id);
    setCurrentPage('chat');
  }, [selectedPersona]);

  const handleSessionSelect = useCallback((id: string) => {
    setActiveSessionId(id);
    const target = sessions.find(s => s.id === id);
    if (target) {
      setSelectedPersona(target.persona || '');
    }
    setCurrentPage('chat');
  }, [sessions]);

  const handleSessionDelete = useCallback((id: string) => {
    if (!window.confirm('确定删除这条对话？')) return;

    const target = sessionsRef.current.find((s) => s.id === id);
    if (target && !target.importedFromBackup) clearChatDraft(id);
    const wasRunning = Boolean(streamCtl.current[id]);
    const stopped = wasRunning
      ? stopChat(id).catch(() => ({ stopped: false }))
      : Promise.resolve({ stopped: false });
    streamCtl.current[id]?.abort();   // 删除正在流式的会话时中止其流
    clearStream(id);
    try { sessionStorage.removeItem(`easel_pending_turn:${id}`); } catch { /* ignore */ }

    if (target?.sessionKey && !target.importedFromBackup) {
      // Do not delete OpenClaw's session record while its agent is still
      // writing to it; the stop endpoint waits for backend cleanup first.
      void stopped.then(() => deleteRemoteSession(target.sessionKey as string)).catch(() => {});
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
  }, [activeSessionId, clearStream]);

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
            onUseTopic={handleUseTopic}
            onQuickPrompt={handleQuickPrompt}
          />
        );
      case 'image':
        return <ImageStudioPage studio={imageStudio} video={videoStudio} onOpenVideoSettings={() => { setSettingsSection('video'); setCurrentPage('settings'); }} onOpenSettings={() => { setSettingsSection('image'); setCurrentPage('settings'); }} onOpenModels={() => { setSettingsSection('model'); setCurrentPage('settings'); }} onOpenOutputs={() => { setOutputFilter(videoStudio.viewMode === 'video' ? 'video' : 'imagegen'); setCurrentPage('outputs'); }} />;
      case 'chat':
        return activeSession ? (
          <ChatPage
            key={activeSession.id}
            session={activeSession}
            stream={streams[activeSession.id]}
            stopping={Boolean(stoppingSessions[activeSession.id])}
            stopError={stopErrors[activeSession.id]}
            onSend={(displayText, attachments, selectedSkills) => handleSendMessage(activeSession.id, displayText, attachments, selectedSkills)}
            onStop={() => handleStopStream(activeSession.id)}
            onNewChat={handleNewChat}
            onOpenAudit={(turnId)=>{setActivityTarget({sessionId:activeSession.id,turnId,key:Date.now()});setCurrentPage('activity');}}
            onResend={(userIndex, displayText, attachments, legacyAgentText) => handleResend(
              activeSession.id, userIndex, displayText, attachments, legacyAgentText,
            )}
            onQuestionAnswered={(qid) => {
              answeredRef.current.add(qid);
              // 已答题从流式状态中移除——切走/切回会话都不再重现（组件内部 state 会在重挂时清零，只藏不移除没用）
              const a = streamAcc.current[activeSession.id];
              if (a) {
                const before = a.questions.length;
                const kept = a.questions.filter((q) => q.id !== qid);
                if (kept.length !== before) {
                  a.questions = kept;
                  setStreams((p) => {
                    const cur = p[activeSession.id];
                    if (!cur) return p;
                    return { ...p, [activeSession.id]: { ...cur, questions: [...kept] } };
                  });
                }
              }
            }}
          />
        ) : null;
      case 'trends':
        return <TrendsPage onUseTopic={handleUseTopic} />;
      case 'ideas':
        return <IdeasPage onUseTopic={handleUseTopic} />;
      case 'calendar':
        return <CalendarPage />;
      case 'publish':
        return <PublishPage persona={selectedPersona} />;
      case 'breakdown':
        return <BreakdownPage persona={selectedPersona} />;
      case 'skills':
        return <SkillPage persona={selectedPersona} />;
      case 'outputs':
        return <OutputsPage initialFilter={outputFilter} onReferenceImage={(image) => { videoStudio.setViewMode('image'); setCurrentPage('image'); void imageStudio.useGalleryReference(image); }} onReuseImage={(prompt, size) => { videoStudio.setViewMode('image'); imageStudio.setImgPrompt(prompt); if (size) imageStudio.setImgSize(size); imageStudio.setMode('generate'); setCurrentPage('image'); }} />;
      case 'accounts':
        return <AccountsPage onAnalysisLogin={() => setAnalysisAutoCollect((value) => value + 1)} onNavigateAnalysis={(platform) => { setAnalysisPlatform(platform); setCurrentPage('analysis'); }} />;
      case 'analysis':
        return <ContentAnalysisPage initialPlatform={analysisPlatform} autoCollectSignal={analysisAutoCollect} onAutoCollectHandled={() => setAnalysisAutoCollect(0)} onNavigateAccounts={() => setCurrentPage('accounts')} onNavigateIdeas={() => setCurrentPage('ideas')} />;
      case 'activity':
        return <ActivityPage key={activityTarget?.key||"default"} sessions={sessions} activeSessionId={activeSessionId} streams={streams} target={activityTarget||undefined} />;
      case 'agent-office':
        return <AgentOfficePage onOpenModels={() => { setSettingsSection('model'); setSettingsNavigationKey(key => key + 1); setCurrentPage('settings'); }} onOpenOutputs={() => { setOutputFilter('all'); setCurrentPage('outputs'); }} onOpenSettings={() => { setSettingsSection('employees'); setSettingsNavigationKey(key => key + 1); setCurrentPage('settings'); }} sessions={sessions} activeSessionId={activeSessionId} streams={streams} onOpenChat={handleSessionSelect} onOpenActivity={sessionId => { setActivityTarget({sessionId, turnId: '', key: Date.now()}); setCurrentPage('activity'); }} />;
      case 'profile':
        return <ProfilePage persona={selectedPersona} onNewProfile={() => setShowWizard(true)} onDeleted={handleProfileDeleted} />;
      case 'settings':
        return <SettingsPanel initialSection={settingsSection} navigationKey={settingsNavigationKey} conversationBackup={{
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
    <div className="app-layout">
      <Sidebar
        currentPage={currentPage}
        onPageChange={(page) => { if (page === 'settings') setSettingsSection('model'); setCurrentPage(page); }}
        personas={personas}
        selectedPersona={selectedPersona}
        onPersonaChange={handlePersonaChange}
        onNewProfile={() => setShowWizard(true)}
        sessions={sessions}
        activeSessionId={activeSessionId}
        activeSessionHasMessages={activeSession ? activeSession.messages.length > 0 : false}
        onSessionSelect={handleSessionSelect}
        onSessionDelete={handleSessionDelete}
        onSessionRename={handleSessionRename}
        onSessionArchive={handleSessionArchive}
        onNewChat={handleNewChat}
        gatewayStatus={gatewayStatus}
      />
      <main className="main-content">
        <StorageNotice onOpenBackup={() => { setSettingsSection('more'); setSettingsNavigationKey(key => key + 1); setCurrentPage('settings'); }} />
        {(['trends', 'ideas', 'calendar', 'publish', 'breakdown'] as Page[]).includes(currentPage) && (
          <SubNav current={currentPage} onNavigate={setCurrentPage} />
        )}
        <div className="page-host">
          {renderPage()}
        </div>
      </main>

      {/* 首次使用：推荐配置画像 */}
      {showRecommend && (
        <div className="overlay">
          <div className="modal" style={{ width: 420, maxWidth: '100%', textAlign: 'center' }}>
            <div style={{ fontSize: 40 }}>👋</div>
            <h2 style={{ margin: '12px 0 8px', fontSize: 20 }}>欢迎使用 Easel</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 }}>
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
      {showWizard && (
        <OnboardingWizard onClose={() => setShowWizard(false)} onCreated={handleProfileCreated} />
      )}
    </div>
  );
}
