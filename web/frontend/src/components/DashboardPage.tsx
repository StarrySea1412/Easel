import { useState, useEffect, useRef } from 'react';
import {
  fetchTrends, fetchSchedule, fetchOutputs, fetchAccounts, fetchIdeas,
  fetchAnalyticsPlatforms, fetchAccountAnalytics,
} from '../lib/api';
import type {
  TrendGroup, ScheduleItem, OutputNode, AccountItem, Idea,
  AnalyticsPlatform, AccountAnalytics, AccountWhoami,
} from '../lib/api';
import type { Page } from './Sidebar';
import { verifyStale } from '../lib/whoami';
import { SkeletonCard } from './Skeleton';
import { IconText } from './icons';
import DashboardCard from './ui/DashboardCard';
import DashboardEmpty from './ui/DashboardEmpty';
import { IconImage } from './settingsIcons';
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
  onUseTopic: (title: string) => void;
  /** 工作台输入框直达创作：新开会话把这句话发给 Agent */
  onQuickPrompt: (text: string) => void;
}

const STATUS_LABEL: Record<string, string> = { idea: '选题', draft: '草稿', scheduled: '待发', published: '已发' };

export default function DashboardPage({ persona, gatewayStatus, onNavigate, onUseTopic, onQuickPrompt }: DashboardProps) {
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
  const [anaSel, setAnaSel] = useState('');
  // Account identity can change between visits. Never restore a platform-only cache.
  const [anaData, setAnaData] = useState<Record<string, AccountAnalytics | 'loading' | 'error'>>({});
  const [anaErrors, setAnaErrors] = useState<Record<string, string>>({});
  const anaPending = useRef(new Set<string>());
  const [anaWin, setAnaWin] = useState<'last' | 'day' | 'week' | 'month' | 'year'>('week');
  // whoami 自愈：登录态以真实 profile 为准（与账号页共享 localStorage 缓存）
  const [whoamiMap, setWhoamiMap] = useState<Record<string, AccountWhoami>>({});

  // ── 直达创作 ──
  const [quickText, setQuickText] = useState('');

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
    setAnaData({});
    setAnaErrors({});
    setWhoamiMap({});
    anaPending.current.clear();
    const load = <T,>(key: string, request: Promise<T>, apply: (data: T) => void) => {
      request.then((data) => { if (alive) apply(data); })
        .catch((e: unknown) => { if (alive) setLoadErrors((old) => ({ ...old, [key]: e instanceof Error ? e.message : '请求失败' })); })
        .finally(() => { if (alive) setLoaded((old) => ({ ...old, [key]: true })); });
    };
    load('热点', fetchTrends('weibo,douyin', 6), (d) => setTrends(d.trends));
    load('排期', fetchSchedule(), setSchedule);
    load('内容', fetchOutputs(), setOutputs);
    load('账号', fetchAccounts(), setAccounts);
    load('选题', fetchIdeas(), setIdeas);
    fetchAnalyticsPlatforms().then((ps) => {
      if (!alive) return;
      setAnaPlats(ps);
      const first = ps.find((p) => p.loggedIn);
      if (first) setAnaSel((s) => s || first.platform);
      // 开页后台自愈：对非 API 式的归因平台真校验（whoami），刷新登录态；
      // B 站走 cookie、公众号走凭证/官方 API 判定，都不起浏览器。
      const API_BASED = new Set(['bilibili', 'wechat-oa']);
      verifyStale(ps.filter((p) => !API_BASED.has(p.platform)).map((p) => p.platform), {
        alive: () => alive,
        onUpdate: (platform, r) => {
          setWhoamiMap((m) => ({ ...m, [platform]: r }));
          if (r.loggedIn) setAnaSel((s) => s || platform);
        },
      });
    }).catch((e: unknown) => { if (alive) setLoadErrors((old) => ({ ...old, '分析': e instanceof Error ? e.message : '请求失败' })); })
      .finally(() => { if (alive) setLoaded((old) => ({ ...old, '分析': true })); });
    return () => { alive = false; };
  }, [refreshKey]);

  const runAna = (platform: string) => {
    setAnaSel(platform);
    if (anaPending.current.has(platform)) return;
    const version = dataVersion.current;
    const isCurrent = () => mounted.current && version === dataVersion.current;
    anaPending.current.add(platform);
    setAnaData((d) => ({ ...d, [platform]: 'loading' }));
    fetchAccountAnalytics(platform)
      .then((r) => { if (isCurrent()) setAnaData((d) => ({ ...d, [platform]: r })); })
      .catch((e: unknown) => {
        if (!isCurrent()) return;
        setAnaErrors((old) => ({ ...old, [platform]: e instanceof Error ? e.message : '请求失败' }));
        setAnaData((d) => ({ ...d, [platform]: 'error' as const }));
      }).finally(() => { if (isCurrent()) anaPending.current.delete(platform); });
  };

  const submitQuick = () => {
    const t = quickText.trim();
    if (t) { onQuickPrompt(t); setQuickText(''); }
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
  const loggedIn = accounts.filter((a) => a.loggedIn).length;

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
    { label: '已登录账号', value: loadErrors['账号'] ? '—' : !loaded['账号'] ? '…' : `${loggedIn}/${accounts.length}`, page: 'accounts', Icon: IconAccounts },
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
          <input
            className="dash-launch-input"
            id="quick-create"
            value={quickText}
            placeholder="例如：帮我策划一组秋日咖啡探店笔记…"
            onChange={(e) => setQuickText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitQuick(); }}
          />
          <button className="btn btn-primary dash-launch-btn" onClick={submitQuick} disabled={!quickText.trim()}>
            开始创作 →
          </button>
        </div>
        <p className="dash-composer-note">{persona ? `当前画像 · ${persona}` : '通用创作模式'}<span> · {gatewayStatus === 'connected' ? '创作助手已连接' : gatewayStatus === 'connecting' ? '正在连接创作助手' : '网关离线，请先检查设置'}</span></p>
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
      <div className="dash-stats">
        {stats.map((s) => (
          <button key={s.label} className="card card-hover dash-stat" onClick={() => onNavigate(s.page)}>
            <span className="dash-stat-ic"><s.Icon size={18} /></span>
            <span className="dash-stat-val">{s.value}</span>
            <span className="dash-stat-label">{s.label}</span>
          </button>
        ))}
      </div>

      <div className="dash-grid">
        <DashboardCard variant="studio" Icon={IconImage} title="生图工坊" ariaLabel="生图工坊入口">
          <DashboardEmpty Icon={IconImage} title="给想象一块独立画布" description="描述画面、选择比例，生成封面与配图。任务进度和历史图片都在工坊里。" action="打开生图工坊" onAction={() => onNavigate('image')} />
        </DashboardCard>

        {/* 今日热点 */}
        <DashboardCard variant="summary" Icon={IconFire} title="今日热点"
          actions={<button className="dash-more" onClick={() => onNavigate('trends')}>热点雷达 →</button>}>
          {trends === null && !loadErrors['热点'] && <SkeletonCard rows={6} title={false} />}
          {loadErrors['热点'] && <DashboardEmpty Icon={IconFire} title="热点暂未加载" description="请检查网络连接后重试。" action="重新加载" onAction={() => setRefreshKey((v) => v + 1)} />}
          {trends && !trends.some((g) => g.items.length > 0) && <DashboardEmpty Icon={IconFire} title="暂无可用热点" description="稍后刷新，或到热点雷达切换平台。" action="查看热点雷达" onAction={() => onNavigate('trends')} />}
          {trends?.map((g) => (
            <div key={g.platform} className="dash-trend-group">
              <div className="dash-trend-plat">{g.label}
                {g.fetchedAt && <span> · {g.status === 'stale' ? '上次可用' : g.status === 'cached' ? '缓存' : '获取于'} {new Date(g.fetchedAt * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}
              </div>
              {g.error && <div className="dash-empty">{g.error.message}</div>}
              {g.items.slice(0, 3).map((it, i) => (
                <div key={i} className="dash-trend-item" title={`${it.title}（点击做成内容）`}>
                  <button className="dash-trend-title" onClick={() => onUseTopic(it.title)}>{it.title}</button>
                </div>
              ))}
            </div>
          ))}
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
        </DashboardCard>

        {/* 创作数据（归因层）：选平台自动拉取登录账号的粉丝/获赞/关注 + 多窗口增长 + 近7日环比 + 最新笔记 */}
        <DashboardCard variant="wide" Icon={IconAccounts} title="账号分析"
          actions={<div className="dash-card-actions">
            <button className="dash-more" onClick={() => onNavigate('analysis')}>内容分析 →</button>
            {anaSel && anaData[anaSel] && anaData[anaSel] !== 'loading' && (
              <button className="dash-more" onClick={() => runAna(anaSel)}>刷新 →</button>
            )}
            </div>}>
          {(() => {
            const logged = anaPlats.filter((p) => whoamiMap[p.platform]?.loggedIn ?? p.loggedIn);
            if (!loaded['分析']) return <SkeletonCard rows={3} title={false} />;
            if (loadErrors['分析']) return <div className="dash-empty">分析服务暂不可用，请点击上方「重新加载」。</div>;
            if (logged.length === 0) {
              return (
                <DashboardEmpty Icon={IconAccounts} title="让每一次发布都有反馈" description="连接平台账号，查看粉丝、内容表现和基于真实数据的创作建议。" action="连接账号" onAction={() => onNavigate('accounts')} />
              );
            }
            const d = anaSel ? anaData[anaSel] : undefined;
            const WIN: [typeof anaWin, string][] = [
              ['last', '较上次'], ['day', '较昨日'], ['week', '较上周'], ['month', '较上月'], ['year', '较去年'],
            ];
            return (
              <>
                <div className="ana-plats">
                  {logged.map((p) => (
                    <button key={p.platform} className={`chip ${anaSel === p.platform ? 'active' : ''}`}
                      onClick={() => runAna(p.platform)}>{p.name}</button>
                  ))}
                </div>
                {!d && <div className="dash-empty">点上方平台查看该账号数据</div>}
                {d === 'loading' && (
                  <div className="loading" style={{ padding: '28px 0' }}><div className="spinner" />抓取中…（起浏览器，约数秒）</div>
                )}
                {d === 'error' && (
                  <div className="dash-empty" role="alert" style={{ color: 'var(--red)' }}>抓取失败：{anaErrors[anaSel] || '请稍后重试'}。点击平台重试。</div>
                )}
                {d && d !== 'loading' && d !== 'error' && (d.accountRequired ? (
                  <div className="dash-empty">
                    {d.analysisNote || '请先选择账号，再查看该账号的真实数据。'}{' '}
                    <button className="link-btn" onClick={() => onNavigate('analysis')}>查看内容分析 →</button>
                  </div>
                ) : !d.loggedIn ? (
                  <DashboardEmpty Icon={IconAccounts} title="账号需要重新登录" description="登录状态已失效，请前往账号页重新连接。" action="前往账号页" onAction={() => onNavigate('accounts')} />
                ) : (
                  <div className="ana-body">
                    {/* 概览 + 增长对比 */}
                    <div className="ana-col ana-col-main">
                      <div className="ana-id">{d.nickname ? `@${d.nickname}` : d.name}</div>
                      <p className="ana-wins-note">采集时间：{d.fetched_at ? new Date(d.fetched_at * 1000).toLocaleString('zh-CN') : '平台未提供'} · 平台返回数据，非实时监控</p>
                      <div className="ana-overview">
                        {([['粉丝', 'followers'], ['获赞', 'likes'], ['作品', 'posts']] as const).map(([label, key]) => {
                          const w = d.growth?.[anaWin] ?? null;
                          const g = w ? growthInfo(w[key]) : null;
                          return (
                            <div key={key} className="ana-stat">
                              <div className="ana-stat-val">{fmtNum(d[key])}</div>
                              <div className="ana-stat-label">{label}</div>
                              {g ? <div className="ana-stat-delta" style={{ color: g.color }}>{g.text}</div>
                                 : <div className="ana-stat-delta ana-muted">—</div>}
                            </div>
                          );
                        })}
                      </div>
                      <div className="ana-wins">
                        {WIN.map(([k, lab]) => (
                          <button key={k} className={`ana-win ${anaWin === k ? 'on' : ''}`}
                            onClick={() => setAnaWin(k)}>{lab}</button>
                        ))}
                      </div>
                      <div className="ana-wins-note">
                        {d.growth?.[anaWin]?.since_days != null
                          ? `对比 ${d.growth[anaWin]!.since_days} 天前的快照`
                          : '缺少该时段的历史快照。需跨对应时间段采集，短时间重复刷新不会生成历史增长。'}
                      </div>
                    </div>

                    {/* 近7日平台指标 + 环比 */}
                    <div className="ana-col ana-col-metrics">
                      <div className="ana-sub">近 7 日 · 环比</div>
                      {(d.metrics ?? []).length === 0 ? (
                        <div className="dash-empty">该平台未提供近 7 日指标</div>
                      ) : (
                        <div className="ana-metrics">
                          {(d.metrics ?? []).map((m) => {
                            const vs = m.vs ?? '';
                            const up = vs.startsWith('+');
                            const has = vs && vs !== '-';
                            return (
                              <div key={m.label} className="ana-metric">
                                <div className="ana-metric-val">{m.value}</div>
                                <div className="ana-metric-label">{m.label}</div>
                                {has && <div className="ana-metric-vs" style={{ color: up ? 'var(--trend-up)' : 'var(--trend-down)' }}>环比{vs}</div>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* 最新笔记（可点进原文） */}
                    <div className="ana-col ana-col-notes">
                      <div className="ana-sub">最新笔记</div>
                      {(d.notes ?? []).length === 0 ? (
                        <div className="dash-empty">该账号暂无可读取的已发布笔记</div>
                      ) : (
                        <div className="ana-notes">
                          {(d.notes ?? []).slice(0, 6).map((n, i) => (
                            <a key={i} className="ana-note" href={n.url} target="_blank" rel="noreferrer" title={n.title}>
                              {n.cover
                                ? <img className="ana-note-cover" src={n.cover} alt="" referrerPolicy="no-referrer" />
                                : <span className="ana-note-cover ana-note-cover-ph" aria-hidden={true}><IconText size={18} /></span>}
                              <span className="ana-note-main">
                                <span className="ana-note-title">{n.title || '(无标题)'}</span>
                                {n.stat && <span className="ana-note-stat">{n.stat}</span>}
                              </span>
                              <span className="ana-note-go">↗</span>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </>
            );
          })()}
        </DashboardCard>
      </div>
    </div>
  );
}
