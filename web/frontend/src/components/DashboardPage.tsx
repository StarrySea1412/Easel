import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { useCompatibleThinking } from '../hooks/useCompatibleThinking';
import {
  fetchTrends, fetchSchedule, fetchOutputs, fetchAccounts, fetchIdeas,
  fetchAnalyticsPlatforms, fetchAccountAnalytics, restoreAccountAnalytics,
} from '../lib/api';
import type {
  TrendGroup, ScheduleItem, OutputNode, AccountItem, Idea,
  AnalyticsPlatform, AccountAnalytics,
} from '../lib/api';
import type { Page } from './Sidebar';
import { accountConnection, hydrateAccountIdentities, useAccountChecks, useAccountIdentities, verifyStale, watchAccountFreshness } from '../lib/whoami';
import { analyticsScope, readAnalyticsCache, analyticsPending, analyticsError, subscribeAnalytics, analyticsRevision, selectedAnalyticsPlatform, selectAnalyticsPlatform } from '../lib/analyticsCache';
import { watchWorkbenchChange } from '../lib/workbenchEvents';
import AccountConnectionDot from './AccountConnectionDot';
import AnalysisMetricChart from './AnalysisMetricChart';
import { metricData } from '../lib/analysisVisuals';
import PublishSpinner from './PublishSpinner';
import { AccountAnalysisSkeleton, SkeletonCard } from './Skeleton';
import DashboardCard from './ui/DashboardCard';
import DashboardEmpty from './ui/DashboardEmpty';
import PlatformIcon from './PlatformIcon';
import { IconImage } from './settingsIcons';
import { useComposerSkills } from '../hooks/useComposerSkills';
import { ComposerSkillChips, ComposerSkillPicker } from './ComposerSkills';
import ComposerModelPicker from './ComposerModelPicker';
import ComposerSkillSuggestions from './ComposerSkillSuggestions';
import { useComposerModels } from '../hooks/useComposerModels';
import { loadThinkingLevel, saveThinkingLevel } from '../lib/thinkingLevel';
import type { ThinkingPreference } from '../lib/thinkingLevel';
import { ThinkingLevelPicker } from './ThinkingLevelPicker';
import { composerModelIssue } from '../lib/composerModelIssue';
import { THINKING_LABELS } from '../lib/thinkingLevel';
import type { ThinkingLevel } from '../lib/api';
import { showToast } from '../lib/toast';
import '../styles/chat-composer.css';
import '../styles/dashboard-studio-entry.css';
import '../styles/dashboard-trends.css';
import { getChatDraft, subscribeChatDraft, setChatDraftText, setChatDraftError, clearChatDraft } from '../lib/chatDrafts';
import { DASHBOARD_DRAFT_SCOPE, isDashboardDraftTextCleared } from '../lib/dashboardDraft';
import type { SkillRequirements } from '../lib/selectedSkills';
import {
  IconFire, IconCalendar, IconOutputs, IconChat, IconSkills, IconAccounts,
  IconIdea, IconPublish,
} from './icons';

/** 大数格式化：12000 → 1.2万。 */
function fmtNum(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 10000) return (n / 10000).toFixed(a >= 100000 ? 0 : 1) + '万';
  return String(n);
}
/** 增长量渲染信息：正=绿↑，负=红↓，0=持平，缺失=不显示。 */
function growthInfo(n: number | null): { text: string; color: string } | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n === 0) return { text: '持平', color: 'var(--text-secondary)' };
  return n > 0
    ? { text: `▲+${fmtNum(n)}`, color: 'var(--trend-up)' }
    : { text: `▼${fmtNum(Math.abs(n))}`, color: 'var(--trend-down)' };
}

interface DashboardProps {
  persona: string;
  gatewayStatus: string;
  onNavigate: (page: Page) => void;
  onNavigateAnalysis?: (platform: string) => void;
  onOpenModels?: (modelRef?: string) => void;
  onUseTopic: (title: string) => void;
  /** 工作台输入框直达创作：新开会话把这句话发给 Agent */
  onQuickPrompt: (text: string, selectedSkills?: string[], skillRequirements?: SkillRequirements, thinkingLevel?: ThinkingLevel, modelRef?: string) => boolean;
}

const STATUS_LABEL: Record<string, string> = { idea: '选题', draft: '草稿', scheduled: '待发', published: '已发' };

export default function DashboardPage({ persona, gatewayStatus, onNavigate, onNavigateAnalysis, onUseTopic, onQuickPrompt, onOpenModels }: DashboardProps) {
  const mounted = useRef(false);
  const dataVersion = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [trends, setTrends] = useState<TrendGroup[] | null>(null);
  const [schedule, setSchedule] = useState<ScheduleItem[] | null>(null);
  const [outputs, setOutputs] = useState<OutputNode[] | null>(null);
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const [refreshKey, setRefreshKey] = useState(0);
  // 归因层：账号创作数据
  const [anaPlats, setAnaPlats] = useState<AnalyticsPlatform[]>([]);
  const [anaSel, setAnaSel] = useState(selectedAnalyticsPlatform);
  useSyncExternalStore(subscribeAnalytics, analyticsRevision);
  const openAnalysis = () => { if (anaSel) selectAnalyticsPlatform(anaSel); if (anaSel && onNavigateAnalysis) onNavigateAnalysis(anaSel); else onNavigate('analysis'); };
  // Account identity can change between visits. Never restore a platform-only cache.
  const [anaData, setAnaData] = useState<Record<string, AccountAnalytics | 'loading' | 'error'>>({});
  const [anaErrors, setAnaErrors] = useState<Record<string, string>>({});
  const [anaBusy, setAnaBusy] = useState<Set<string>>(new Set());
  const anaPending = useRef(new Set<string>());
  const [anaWin, setAnaWin] = useState<'last' | 'day' | 'week' | 'month' | 'year'>('week');
  // whoami 自愈：登录态以真实 profile 为准（与账号页共享 localStorage 缓存）
  const whoamiMap = useAccountIdentities();
  const accountChecks = useAccountChecks();
  const identitySignature = JSON.stringify(Object.entries(whoamiMap).map(([p, e]) => [p, e.identityKey, e.accountId]));
  useEffect(() => { if (anaSel && readAnalyticsCache(anaSel)?.growthSchema !== 'account-history-v1' && !analyticsPending(anaSel)) void restoreAccountAnalytics(anaSel).catch(() => {}); }, [anaSel, identitySignature]);
  useEffect(() => {
    const restore = () => {
      const restored: Record<string, AccountAnalytics> = {};
      for (const p of anaPlats) { const value = readAnalyticsCache(p.platform); if (value) restored[p.platform] = value; }
      setAnaData(restored);
    };
    restore();
    return watchWorkbenchChange('analysis', restore);
  }, [anaPlats, identitySignature]);
  useEffect(() => {
    const refresh = () => {
      void fetchAccounts().then(list => { if (mounted.current) { hydrateAccountIdentities(list); setAccounts(list); } }).catch(() => {});
      void verifyStale(anaPlats.map(p => p.platform), { alive: () => mounted.current });
    };
    return watchAccountFreshness(refresh);
  }, [anaPlats]);

  // ── 直达创作 ──
  const quickDraft = useSyncExternalStore(
    useCallback(listener => subscribeChatDraft(DASHBOARD_DRAFT_SCOPE, listener), []),
    useCallback(() => getChatDraft(DASHBOARD_DRAFT_SCOPE), []),
  );
  const quickText = quickDraft.text;
  const quickSkills = useComposerSkills(DASHBOARD_DRAFT_SCOPE, 'creation');
  const quickModels = useComposerModels(null);
  const [quickPreferredThinking, setQuickThinking] = useState<ThinkingPreference>(()=>loadThinkingLevel());
  const quickEffectiveModel = quickModels.selected || quickModels.options.find(option=>option.id===(quickModels.capability?.currentModelRef || quickModels.capability?.defaultModelRef));
  const quickSupportedThinking = quickEffectiveModel?.thinkingLevels;
  const { level: quickThinking } = useCompatibleThinking(quickPreferredThinking, quickSupportedThinking, setQuickThinking);
  const changeQuickThinking = (value: ThinkingPreference) => { setQuickThinking(value); const saved = saveThinkingLevel(value); showToast(saved ? `已选择思考强度：${THINKING_LABELS[value]}，下一轮生效` : '强度已在本页修改，但未能保存。', saved ? 'success' : 'error'); };

  const composingQuick = useRef(false);
  const setQuickText = (value: string | ((current: string) => string)) => {
    setChatDraftText(DASHBOARD_DRAFT_SCOPE, value);
    if (getChatDraft(DASHBOARD_DRAFT_SCOPE).error) setChatDraftError(DASHBOARD_DRAFT_SCOPE, '');
  };

  useEffect(() => {
    let alive = true;
    dataVersion.current += 1;
    setLoadErrors({});
    setLoaded({});
    setTrends(null);
    setSchedule(null);
    setOutputs(null);
    setAccounts([]);
    setIdeas([]);
    const load = <T,>(key: string, request: Promise<T>, apply: (data: T) => void) => {
      request.then((data) => { if (alive) apply(data); })
        .catch((e: unknown) => { if (alive) setLoadErrors((old) => ({ ...old, [key]: e instanceof Error ? e.message : '请求失败' })); })
        .finally(() => { if (alive) setLoaded((old) => ({ ...old, [key]: true })); });
    };
    load('热点', fetchTrends('weibo,douyin', 5), (d) => setTrends(d.trends));
    load('排期', fetchSchedule(), setSchedule);
    load('内容', fetchOutputs(), setOutputs);
    load('账号', fetchAccounts(), list => { hydrateAccountIdentities(list); setAccounts(list); });
    load('选题', fetchIdeas(), setIdeas);
    fetchAnalyticsPlatforms().then((ps) => {
      if (!alive) return;
      setAnaPlats(ps);
      const first = ps.find((p) => readAnalyticsCache(p.platform) || analyticsPending(p.platform)) || ps.find((p) => p.loggedIn);
      if (first) setAnaSel((s) => ps.some(p => p.platform === s) ? s : first.platform);
      // 开页后台自愈：对非 API 式的归因平台真校验（whoami），刷新登录态；
      // B 站走 cookie、公众号走凭证/官方 API 判定，都不起浏览器。
      const API_BASED = new Set(['bilibili', 'wechat-oa']);
      verifyStale(ps.filter((p) => !API_BASED.has(p.platform)).map((p) => p.platform), {
        alive: () => alive,
        onUpdate: (platform, r) => {
          if (r.loggedIn) setAnaSel((s) => s || platform);
        },
      });
    }).catch((e: unknown) => { if (alive) setLoadErrors((old) => ({ ...old, '分析': e instanceof Error ? e.message : '请求失败' })); })
      .finally(() => { if (alive) setLoaded((old) => ({ ...old, '分析': true })); });
    return () => { alive = false; };
  }, [refreshKey]);

  const runAna = (platform: string, force = false) => {
    setAnaSel(platform);
    selectAnalyticsPlatform(platform);
    const saved = readAnalyticsCache(platform);
    if (saved) setAnaData(d => ({ ...d, [platform]: saved }));
    const connection = accountConnection(accounts.find(a => a.platform === platform), whoamiMap[platform]);
    if (connection === 'login_required' || connection === 'not_connected' || accountChecks.has(platform)) return;
    if (saved && !force) return;
    if (connection !== 'online') return;
    if (anaPending.current.has(platform)) return;
    const version = dataVersion.current;
    const scope = analyticsScope(platform);
    const isCurrent = () => mounted.current && version === dataVersion.current && scope === analyticsScope(platform);
    anaPending.current.add(platform);
    setAnaBusy(old => new Set(old).add(platform));
    if (!saved) setAnaData((d) => ({ ...d, [platform]: 'loading' }));
    fetchAccountAnalytics(platform, force)
      .then((r) => { if (isCurrent()) setAnaData((d) => ({ ...d, [platform]: r })); })
      .catch((e: unknown) => {
        if (!isCurrent()) return;
        setAnaErrors((old) => ({ ...old, [platform]: e instanceof Error ? e.message : '请求失败' }));
        showToast(`抓取失败：${e instanceof Error ? e.message : '请求失败，请重试。'}`, 'error');
        if (!saved) setAnaData((d) => ({ ...d, [platform]: 'error' as const }));
      }).finally(() => {
        if (mounted.current && version === dataVersion.current) {
          anaPending.current.delete(platform);
          setAnaBusy(old => { const next = new Set(old); next.delete(platform); return next; });
        }
      });
  };

  const submitQuick = () => {
    const submitted = getChatDraft(DASHBOARD_DRAFT_SCOPE);
    const text = submitted.text.trim();
    if (!text || composingQuick.current) return;
    if (gatewayStatus !== 'connected') {
      setChatDraftError(DASHBOARD_DRAFT_SCOPE, gatewayStatus === 'connecting'
        ? '创作助手正在连接，草稿已保留，请连接成功后重试。'
        : '创作助手尚未连接，草稿已保留，请检查设置后重试。');
      return;
    }
    const snapshot = quickSkills.getSnapshot();
    if (!snapshot) return;
    const model = quickModels.getSnapshot();
    if (!model) { setChatDraftError(DASHBOARD_DRAFT_SCOPE, composerModelIssue(quickModels)); return; }
    try {
      const accepted = onQuickPrompt(text, snapshot.selectedSkills, snapshot.skillRequirements, quickThinking, model.modelRef);
      if (accepted !== true) {
        setChatDraftError(DASHBOARD_DRAFT_SCOPE, '本次创作未被接收，草稿和技能已保留，请稍后重试。');
        return;
      }
      // A callback may replace the draft; its newer content is never ours to clear.
      if (getChatDraft(DASHBOARD_DRAFT_SCOPE) !== submitted) return;
      const skillsCleared = quickSkills.clear(snapshot.revision);
      if (skillsCleared === null) return;
      clearChatDraft(DASHBOARD_DRAFT_SCOPE, submitted);
      if (!skillsCleared || !isDashboardDraftTextCleared()) {
        setChatDraftError(DASHBOARD_DRAFT_SCOPE, '创作已开始，但浏览器未能保存工作台草稿的清理；刷新后可能恢复旧内容，请勿重复发送。');
      }
    } catch {
      setChatDraftError(DASHBOARD_DRAFT_SCOPE, '本次创作暂时无法开始，草稿和技能已保留，请稍后重试。');
    }
  };

  const hour = new Date().getHours();
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '上午好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const schedList = schedule || [];
  const upcoming = [...schedList]
    .filter((s) => s.date >= todayStr && s.status !== 'published')
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const recent = (outputs || []).slice(0, 5);
  const pendingIdeas = ideas.filter((i) => i.status === 'pending');
  const loggedIn = accounts.filter((a) => accountConnection(a, whoamiMap[a.platform]) === 'online').length;

  const quick: { label: string; page: Page; Icon: typeof IconChat }[] = [
    { label: '开始对话', page: 'chat', Icon: IconChat },
    { label: '看热点', page: 'trends', Icon: IconFire },
    { label: '拆爆款', page: 'breakdown', Icon: IconSkills },
    { label: '记选题', page: 'ideas', Icon: IconIdea },
    { label: '排日历', page: 'calendar', Icon: IconCalendar },
    { label: '去发布', page: 'publish', Icon: IconPublish },
  ];

  const stats: { label: string; value: string; page: Page; Icon: typeof IconChat }[] = [
    { label: '待做选题', value: loadErrors['选题'] ? '—' : !loaded['选题'] ? '…' : String(pendingIdeas.length), page: 'ideas', Icon: IconIdea },
    { label: '待发排期', value: loadErrors['排期'] ? '—' : !loaded['排期'] ? '…' : String(upcoming.length), page: 'calendar', Icon: IconCalendar },
    { label: '内容项目', value: loadErrors['内容'] ? '—' : !loaded['内容'] ? '…' : String(outputs?.length ?? 0), page: 'outputs', Icon: IconOutputs },
    { label: '已确认在线', value: loadErrors['账号'] ? '—' : !loaded['账号'] ? '…' : `${loggedIn}/${accounts.length}`, page: 'accounts', Icon: IconAccounts },
  ];


  return (
    <div className="page-scroll dash-page">
      <div className="dash-hero">
        <div className="dash-heading">
          <div>
            <p className="dash-eyebrow">你的创作工作室 / OVERVIEW</p>
            <h1 className="page-title">{greet}，让灵感成为作品。</h1>
            <p className="page-subtitle">从发现一个好选题，到发布下一篇内容，在这里开始。</p>
          </div>
          <span className="dash-date">{today.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</span>
        </div>
        <div className="dash-composer">
        <label className="dash-launch-label" htmlFor="quick-create">今天，你想创作什么？</label>
        {/* 直达创作：一句话开干，不用先想「该去哪个页面」 */}
        <div className="dash-launch">
          <ComposerSkillChips skills={quickSkills} />
          <textarea
            className="dash-launch-input"
            id="quick-create"
            rows={2}
            value={quickText}
            placeholder="例如：帮我策划一组秋日咖啡探店笔记…"
            onChange={(e) => setQuickText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !composingQuick.current && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                submitQuick();
              }
            }}
            onCompositionStart={() => { composingQuick.current = true; }}
            onCompositionEnd={() => { composingQuick.current = false; }}
          />
          <ComposerSkillSuggestions text={quickText} skills={quickSkills}/>
          <div className="dash-composer-bar">
            <div className="dash-composer-tools">
            <ComposerSkillPicker skills={quickSkills} setInput={setQuickText} />
            <ComposerModelPicker models={quickModels} onOpenModels={onOpenModels} />
            <ThinkingLevelPicker value={quickPreferredThinking} onChange={changeQuickThinking} disabled={gatewayStatus !== 'connected'} supportedLevels={quickSupportedThinking} />
            </div>
            <button type="button" className="btn btn-primary dash-launch-btn" onClick={submitQuick} disabled={!quickText.trim()}>
              开始创作 →
            </button>
          </div>
          {(persona || gatewayStatus !== 'connected') && <div className="dash-composer-meta">
            <div className="dash-composer-status">
              {persona && <span className="dash-persona" title={`当前画像：${persona}`}>{persona}</span>}
              {gatewayStatus !== 'connected' && <span className="dash-connection" role="status">{gatewayStatus === 'connecting' ? '正在连接…' : '助手未连接'}{gatewayStatus === 'disconnected' && <button type="button" className="link-btn" onClick={() => onNavigate('settings')}>检查设置</button>}</span>}
            </div>
          </div>}
        </div>
        {quickDraft.error && <p className="dash-composer-error" role="alert">{quickDraft.error}</p>}
        {quickSkills.notice && <p className="composer-skills-note" role="status">{quickSkills.notice}
          {quickSkills.restorePending && <button type="button" className="link-btn" onClick={() => quickSkills.retryRestore()}>重试恢复技能</button>}
        </p>}
        </div>
        <div className="dash-quick">
          {quick.map((q) => (
            <button key={q.page} className="dash-quick-btn" onClick={() => onNavigate(q.page)}>
              <q.Icon size={16} /><span>{q.label}</span>
            </button>
          ))}
        </div>
      </div>

      {Object.keys(loadErrors).length > 0 && <div className="dash-load-error" role="alert">
        <span>部分数据未能加载：{Object.entries(loadErrors).map(([key, message]) => `${key}（${message}）`).join('；')}。相关数据暂不可用。</span>
        <button className="btn btn-sm" onClick={() => setRefreshKey((v) => v + 1)}>重新加载</button>
      </div>}

      {/* 概览数字 */}
      <div className="dash-stats-region">
        <div className="dash-stats">
          {stats.map((s) => (
            <button key={s.label} className="card card-hover dash-stat" onClick={() => onNavigate(s.page)}>
              <span className="dash-stat-ic"><s.Icon size={18} /></span>
              <span className="dash-stat-val">{s.value}</span>
              <span className="dash-stat-label">{s.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="dash-grid">
        {/* 创作数据（归因层）：选平台自动拉取登录账号的粉丝/获赞/关注 + 多窗口增长 + 近7日环比 + 最新笔记 */}
        <DashboardCard variant="wide" Icon={IconAccounts} title="账号分析"
          actions={<div className="dash-card-actions">
            {anaSel && (analyticsPending(anaSel) || anaBusy.has(anaSel)) && <span className="ana-refresh-status" role="status" aria-label="正在更新账号数据" title="正在更新账号数据"><PublishSpinner /></span>}
            <button className="dash-more" onClick={openAnalysis}>内容分析 →</button>
            {anaSel && <button className="dash-more" disabled={analyticsPending(anaSel) || anaBusy.has(anaSel) || accountChecks.has(anaSel) || accountConnection(accounts.find(a => a.platform === anaSel), whoamiMap[anaSel]) !== 'online'} onClick={() => runAna(anaSel, true)}>主动分析</button>}
            </div>}>
          {(() => {
            // Availability and online proof are separate: rechecking never removes a platform.
            const cachedPlats = !anaPlats.length && anaSel && readAnalyticsCache(anaSel) ? [{platform:anaSel,name:readAnalyticsCache(anaSel)!.name,loggedIn:false}] : anaPlats;
            const logged = cachedPlats.filter(p => {
              const a = accounts.find(row => row.platform === p.platform);
              return p.loggedIn || a?.hasLocalSession || a?.loggedIn || whoamiMap[p.platform] || readAnalyticsCache(p.platform);
            });
            if (!loaded['分析'] && !readAnalyticsCache(anaSel)) return <AccountAnalysisSkeleton />;
            if (loadErrors['分析'] && !readAnalyticsCache(anaSel)) return <div className="dash-empty">分析服务暂不可用，请点击上方「重新加载」。</div>;
            if (logged.length === 0) {
              return (
                <DashboardEmpty Icon={IconAccounts} title="让每一次发布都有反馈" description="连接平台账号，查看粉丝、内容表现和基于真实数据的创作建议。" action="连接账号" onAction={() => onNavigate('accounts')} />
              );
            }
            const status = anaSel ? anaData[anaSel] : undefined;
            const d = anaSel ? readAnalyticsCache(anaSel) || (status === 'loading' || status === 'error' ? status : undefined) : undefined;
            const connection = accountConnection(accounts.find(a => a.platform === anaSel), whoamiMap[anaSel]);
            const WIN: [typeof anaWin, string][] = [
              ['last', '较上次'], ['day', '较昨日'], ['week', '较上周'], ['month', '较上月'], ['year', '较去年'],
            ];
            const windowLabel = WIN.find(([key]) => key === anaWin)![1];
            const windowData = d && typeof d === 'object' ? d.growth?.[anaWin] : null;
            return (
              <>
                <div className="ana-plats">
                  {logged.map((p) => (
                    <button key={p.platform} className={`chip ${anaSel === p.platform ? 'active' : ''}`}
                      onClick={() => runAna(p.platform)}><PlatformIcon platform={p.platform} name={p.name} className="ana-platform-icon" />{p.name}
                        <span className={'ana-platform-state is-' + (accountChecks.has(p.platform) ? 'unknown' : accountConnection(accounts.find(a => a.platform === p.platform), whoamiMap[p.platform]))} aria-label={accountChecks.has(p.platform) ? '正在核验' : accountConnection(accounts.find(a => a.platform === p.platform), whoamiMap[p.platform]) === 'online' ? '已连接' : accountConnection(accounts.find(a => a.platform === p.platform), whoamiMap[p.platform]) === 'unknown' ? '正在确认连接' : '未登录'} />
                      </button>
                  ))}
                </div>
                {anaSel && (!d || d === 'loading') && (connection === 'unknown' || accountChecks.has(anaSel) || d === 'loading' || analyticsPending(anaSel) || anaBusy.has(anaSel) ? <AccountAnalysisSkeleton /> : (
                  <div className="ana-account-empty">
                    <span className="ana-account-empty-icon" aria-hidden="true"><PlatformIcon platform={anaSel} name={logged.find(p => p.platform === anaSel)?.name || anaSel} /></span>
                    <div className="ana-account-empty-copy"><strong>{logged.find(p => p.platform === anaSel)?.name || anaSel}{connection !== 'online' ? '账号未登录' : '账号已连接'}</strong><span>{connection !== 'online' ? '连接后查看账号与作品表现' : '读取账号与作品表现'}</span></div>
                    <button type="button" className="btn btn-sm ana-account-empty-action" onClick={() => connection !== 'online' ? onNavigate('accounts') : runAna(anaSel)}>{connection !== 'online' && <IconAccounts size={14} />}{connection !== 'online' ? '连接账号' : '获取账号数据'}</button>
                  </div>
                ))}
                {!anaSel && <div className="dash-empty">选择平台查看账号数据</div>}
                {analyticsError(anaSel) && <div className="notice-error" role="alert">{analyticsError(anaSel)}{d && d !== 'loading' && d !== 'error' ? '，保留上次结果。' : ''}</div>}

                {d === 'error' && (
                  <div className="dash-empty" role="alert" style={{ color: 'var(--red)' }}>抓取失败：{anaErrors[anaSel] || '请稍后重试'}。点击平台重试。</div>
                )}
                {d && d !== 'loading' && d !== 'error' && (d.accountRequired ? (
                  <div className="dash-empty">
                    {d.analysisNote || '请先选择账号，再查看该账号的真实数据。'}{' '}
                    <button className="link-btn" onClick={openAnalysis}>查看内容分析 →</button>
                  </div>
                ) : !d.loggedIn ? (
                  <DashboardEmpty Icon={IconAccounts} title="账号状态待确认" description="本次采集未确认登录状态，请到账号中心检测。已有登录资料保留。" action="前往账号页" onAction={() => onNavigate('accounts')} />
                ) : (
                  <div className="ana-result">
                    <div className="ana-result-head">
                      <div className="ana-identity"><PlatformIcon platform={anaSel} name={d.name} className="ana-identity-icon" /><span className="ana-id">{d.nickname ? `@${d.nickname}` : d.name}</span><AccountConnectionDot connection={connection} checking={accountChecks.has(anaSel)} checkedAt={whoamiMap[anaSel]?.checkedAt} /></div>
                      <span className="ana-updated" title={d.fetched_at ? `采集时间：${new Date(d.fetched_at * 1000).toLocaleString('zh-CN')}；平台返回数据，非实时监控` : '平台未提供采集时间'}>{d.fetched_at ? <><time dateTime={new Date(d.fetched_at * 1000).toISOString()}>{new Date(d.fetched_at * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time> 更新</> : '更新时间未提供'}</span>
                    </div>
                    {d.warning && <p className="ana-warning" role="status">{d.warning}</p>}
                    <div className="ana-body">
                      <div className="ana-col ana-col-main">
                        <div className="ana-overview">
                          {([['粉丝', 'followers'], ['获赞', 'likes'], ['作品', 'posts']] as const).map(([label, key]) => {
                            const g = windowData ? growthInfo(windowData[key]) : null;
                            return <div key={key} className="ana-stat"><div className="ana-stat-label">{label}</div><div className="ana-stat-val" title={d[key] == null ? '平台未提供' : `累计${label}：${d[key]!.toLocaleString('zh-CN')}`}>{fmtNum(d[key])}</div><div className="ana-stat-delta" style={{ color: g?.color || 'var(--text-tertiary)' }}><span className="ana-stat-window">{windowLabel}</span> {g?.text || (windowData ? '未提供' : '暂无对比')}</div></div>;
                          })}
                        </div>
                        <div className="ana-wins" role="group" aria-label="增长对比时段">{WIN.map(([k, lab]) => <button key={k} type="button" aria-pressed={anaWin === k} className={`ana-win ${anaWin === k ? 'on' : ''}`} onClick={() => setAnaWin(k)}>{lab}</button>)}</div>
                        <p className="ana-wins-note" role="status" aria-live="polite" aria-atomic="true">{windowLabel} · {windowData?.baseline_at ? `对比 ${new Date(windowData.baseline_at * 1000).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : windowData?.since_days != null ? `对比 ${windowData.since_days} 天前` : '暂无该时段对比'}</p>
                        {d.metricsNeedsRefresh && <section className="ana-refresh-metrics"><h3 className="ana-sub">平台指标</h3><button type="button" className="link-btn" disabled={analyticsPending(anaSel)} onClick={() => runAna(anaSel, true)} title="旧指标来源无法确认，保留账号资料与作品，重新读取平台账号总览">重新采集指标</button></section>}
                        {!!d.metrics?.length && <div className="ana-statistics">
                        <AnalysisMetricChart title={d.metrics_title || '平台指标'} caption={d.metrics_source?.from && d.metrics_source.to ? d.metrics_source.from + ' — ' + d.metrics_source.to : '平台返回的汇总指标'} data={metricData(d.metrics)} />
                        {!!d.metrics?.length && <section className="ana-period" aria-label="平台统计指标" title={d.metrics_source ? `来源：抖音创作者中心 · ${d.metrics_source.section}；统计周期：${d.metrics_source.from} 至 ${d.metrics_source.to}` : undefined}>
                          <h3 className="ana-sub">{d.metrics_title || '平台指标'}</h3>
                          <table className="ana-metrics-table" aria-label={d.metrics_title || '平台指标'}>
                            <thead><tr><th scope="col">指标</th><th scope="col">数值</th><th scope="col">{d.metrics_source?.period === 'last_7_days' || d.metrics_title === '近7日表现' ? '较前7日' : '环比'}</th></tr></thead>
                            <tbody>{d.metrics.map(m => {
                              const vs = String(m.vs ?? '').trim();
                              const has = !!vs && vs !== '-' && vs !== '—';
                              const color = vs.startsWith('+') ? 'var(--trend-up)' : vs.startsWith('-') ? 'var(--trend-down)' : undefined;
                              return <tr key={m.label}><th scope="row">{m.label}</th><td className="ana-metric-val">{m.value}</td><td className="ana-metric-vs" style={{ color }} title={has ? undefined : '平台未提供对比数据'}>{has ? vs : '—'}</td></tr>;
                            })}</tbody>
                          </table>
                        </section>}</div>}
                      </div>
                      <section className="ana-col ana-col-notes" aria-label="最新作品">
                        <div className="ana-notes-head"><h3 className="ana-sub">最新作品</h3><button type="button" className="dash-more" onClick={openAnalysis}>查看全部 →</button></div>
                        {!d.notes?.length ? <p className="ana-notes-empty">暂未读取到作品</p> : <div className="ana-notes">{d.notes.slice(0, 4).map((n, i) => {
                          const body = <>{n.cover ? <img className="ana-note-cover" src={n.cover} alt="" referrerPolicy="no-referrer" /> : <span className="ana-note-rank" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>}<span className="ana-note-main"><span className="ana-note-title">{n.title || '未提供标题'}</span>{n.stat && <span className="ana-note-stat">{n.stat}</span>}</span>{n.url && <span className="ana-note-go" aria-hidden="true">↗</span>}</>;
                          return n.url ? <a key={i} className="ana-note" href={n.url} target="_blank" rel="noreferrer" title={n.title}>{body}</a> : <div key={i} className="ana-note" title={n.title}>{body}</div>;
                        })}</div>}
                      </section>
                    </div>
                  </div>
                ))}
              </>
            );
          })()}
        </DashboardCard>


        {/* 今日热点 */}
        <DashboardCard variant="summary" className="dash-trends-card" Icon={IconFire} title="今日热点"
          actions={<button className="dash-more" onClick={() => onNavigate('trends')}>热点雷达 →</button>}>
          {trends === null && !loadErrors['热点'] && <SkeletonCard rows={6} title={false} />}
          {loadErrors['热点'] && <DashboardEmpty Icon={IconFire} title="热点暂未加载" description="请检查网络连接后重试。" action="重新加载" onAction={() => setRefreshKey((v) => v + 1)} />}
          {trends && !trends.some((g) => g.items.length > 0 || g.error) && <DashboardEmpty Icon={IconFire} title="暂无可用热点" description="稍后刷新，或到热点雷达切换平台。" action="查看热点雷达" onAction={() => onNavigate('trends')} />}
          {trends && trends.some((g) => g.items.length > 0 || g.error) && <div className="dash-trends-grid">
            {trends.map((g) => (
              <section key={g.platform} className="dash-trend-group" aria-label={`${g.label}热点`}>
                <div className="dash-trend-plat">
                  <span aria-hidden="true"><PlatformIcon platform={g.platform} name={g.label} className="dash-trend-icon" /></span>
                  <span>{g.label}</span>
                </div>
                {g.fetchedAt && <div className="dash-trend-time">
                  {g.status === 'stale' ? '上次可用' : g.status === 'cached' ? '缓存' : '获取于'} <time dateTime={new Date(g.fetchedAt * 1000).toISOString()}>{new Date(g.fetchedAt * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
                </div>}
                {g.error && <div className="dash-trend-error" role="status">{g.error.message}</div>}
                {!g.items.length && !g.error && <div className="dash-trend-error">此来源暂未返回热点</div>}
                {g.items.slice(0, 5).map((it, i) => (
                  <button key={`${it.title}-${i}`} className="dash-trend-title" title={`${it.title}（点击做成内容）`}
                    aria-label={`${g.label}热点：${it.title}，点击做成内容`} onClick={() => onUseTopic(it.title)}>
                    <span className={`dash-trend-rank${i < 3 ? ' top' : ''}`} aria-hidden="true">{i + 1}</span>
                    <span className="dash-trend-text">{it.title}</span>
                  </button>
                ))}
              </section>
            ))}
          </div>}
        </DashboardCard>

        {/* 选题库 */}
        <DashboardCard variant="summary" Icon={IconIdea} title="选题库 · 待做" ariaLabel="待做选题"
          actions={<button className="dash-more" onClick={() => onNavigate('ideas')}>全部 →</button>}>
          {!loaded['选题'] && <SkeletonCard rows={5} title={false} />}
          {loadErrors['选题'] && <DashboardEmpty Icon={IconIdea} title="选题暂未加载" description="已有选题保留在选题库，请重试。" action="重新加载" onAction={() => setRefreshKey((v) => v + 1)} />}
          {loaded['选题'] && !loadErrors['选题'] && pendingIdeas.length === 0 && <DashboardEmpty Icon={IconIdea} title="为下一篇攒点灵感" description="记录一个想法，或从热点中收藏选题。" action="添加选题" onAction={() => onNavigate('ideas')} />}
          {pendingIdeas.slice(0, 5).map((it) => (
            <button key={it.id} className="dash-idea"
              onClick={() => onUseTopic(it.title)} title="点击做成内容">
              <span className="dash-idea-title">{it.title}</span>
              {it.source && <span className="badge">{it.source}</span>}
            </button>
          ))}
        </DashboardCard>

        {/* 近期排期 */}
        <DashboardCard variant="summary" Icon={IconCalendar} title="近期排期"
          actions={<button className="dash-more" onClick={() => onNavigate('calendar')}>日历 →</button>}>
          {schedule === null && !loadErrors['排期'] && <SkeletonCard rows={5} title={false} />}
          {loadErrors['排期'] && <DashboardEmpty Icon={IconCalendar} title="排期暂未加载" description="暂时无法读取日历，请重试。" action="重新加载" onAction={() => setRefreshKey((v) => v + 1)} />}
          {schedule !== null && upcoming.length === 0 && <DashboardEmpty Icon={IconCalendar} title="给创作一个时间" description="安排下一篇内容，让发布更有节奏。" action="安排日历" onAction={() => onNavigate('calendar')} />}
          {upcoming.slice(0, 5).map((s) => (
            <button key={s.id} className="dash-sched"
              onClick={() => onNavigate('calendar')}>
              <span className="dash-sched-date">{s.date.slice(5)}</span>
              <span className="dash-sched-title">{s.platform ? `[${s.platform}] ` : ''}{s.title}</span>
              <span className="badge">{STATUS_LABEL[s.status] || s.status}</span>
            </button>
          ))}
        </DashboardCard>

        {/* 最近产物 */}
        <DashboardCard variant="summary" Icon={IconOutputs} title="最近产物"
          actions={<button className="dash-more" onClick={() => onNavigate('outputs')}>内容库 →</button>}>
          {outputs === null && !loadErrors['内容'] && <SkeletonCard rows={5} title={false} />}
          {loadErrors['内容'] && <DashboardEmpty Icon={IconOutputs} title="内容暂未加载" description="暂时无法读取内容库，请重试。" action="重新加载" onAction={() => setRefreshKey((v) => v + 1)} />}
          {outputs !== null && recent.length === 0 && <DashboardEmpty Icon={IconOutputs} title="作品从这里积累" description="开始一段创作，生成的内容会保存到这里。" action="开始对话" onAction={() => onNavigate('chat')} />}
          {recent.map((g) => (
            <button key={g.name} className="dash-output"
              onClick={() => onNavigate('outputs')}>
              <span className="dash-output-name">{g.meta?.title || g.name}</span>
              <span className="badge">{g.meta?.platform || (g.type === 'dir' ? `${g.fileCount ?? 0} 文件` : '单文件')}</span>
            </button>
          ))}
          <button type="button" className="dash-studio-launch" onClick={() => onNavigate('image')}>
            <span className="dash-studio-launch-icon" aria-hidden="true"><IconImage size={20} /></span>
            <span className="dash-studio-launch-copy"><strong>开始生成图片</strong><small>用文字或参考图进入生图工坊，成品会回到这里</small></span>
            <span className="dash-studio-launch-arrow" aria-hidden="true">→</span>
          </button>
        </DashboardCard>
      </div>
    </div>
  );
}
