import { NativeSelect as Select } from './ui/Select';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { IconCoins } from './icons';
import InlineInfo from './InlineInfo';
import '../styles/usage.css';
import UsagePriceEditor from './UsagePriceEditor';

const METRICS = [
  ['totalTokens', '总 Token'], ['inputTokens', '输入（含缓存）'], ['outputTokens', '输出'],
  ['cacheReadTokens', '缓存读取'], ['cacheWriteTokens', '缓存写入'], ['reasoningTokens', '推理'],
  ['recordedCostUsd', '记录费用 · USD'],
] as const;
type Metric = typeof METRICS[number][0];
type Counts = Record<Metric, number | null>;
type Summary = Counts & { calls: number; reportedCalls: number; missingCalls: number; coverage: Record<Metric, number> & { estimatedCostUsd?: number };
  estimatedCostUsd?: number | null; performance?: Record<string, { calls: number; outputTokensPerSecond: number | null }> };
type Call = Counts & { id: string; timestamp: string; model: string; provider: string;
  channelId?: string; channelName?: string; channelEndpoint?: string | null; channelSource?: string;
  durationMs?: number | null; firstTokenMs?: number | null; outputTokensPerSecond?: number | null;
  speedSource?: string | null; estimatedCostUsd?: number | null;
  costBreakdown?: { pricing: { source: string; multiplier: string }; partsUsd: Record<string, string>; freshInputTokens: number } | null };
type Turn = { id: string; number: number; timestamp: string; unattributed: boolean; summary: Summary; calls: Call[] };
type Usage = {
  sessionId: string; session: Summary; project: Summary; turns: Turn[]; turnCount: number;
  offset: number; limit: number; sessionCount: number; sourceCount: number; updatedAt: number;
  sessions: { sessionId: string; summary: Summary; lastAt: string }[];
  scope: string; note: string; costNote: string; issues: string[];
  performanceNote?: string; pricingNote?: string; channelNote?: string;
  recordUnit?: string;
  channels?: Record<'session' | 'project', { id: string; name: string; endpoint: string | null; source: string; models: string[]; summary: Summary }[]>;
};

const channelId = (call: Call) => call.channelId || call.provider || 'unknown';
const channelLabel = (call: Call) => `${call.channelName || call.provider || '渠道未记录'} · ${call.channelEndpoint || '地址未记录'}`;

function RequestMetrics({ call, onSaved }: { call: Call; onSaved: () => void }) {
  const seconds = (value: number | null | undefined) => value == null ? '未记录' : `${(value / 1000).toFixed(2)} s`;
  return <>
    <dl className="usage-performance"><div><dt>请求耗时（日志）</dt><dd>{seconds(call.durationMs)}</dd></div>
      <div><dt>首个输出延迟</dt><dd>{seconds(call.firstTokenMs)}</dd></div>
      <div><dt>{call.speedSource === 'estimated' ? '估算速度（含等待）' : '流式输出速度'}</dt><dd>{call.outputTokensPerSecond == null ? '无有效样本' : `${call.outputTokensPerSecond.toFixed(2)} tok/s`}</dd></div>
      <div><dt>按渠道报价估算 · USD</dt><dd>{call.estimatedCostUsd == null ? '价格或用量不完整' : `$${call.estimatedCostUsd.toFixed(8)}`}</dd></div></dl>
    {call.costBreakdown && <p className="usage-note">价格来源：{call.costBreakdown.pricing.source} · 倍率 {call.costBreakdown.pricing.multiplier} · 普通输入 {call.costBreakdown.freshInputTokens.toLocaleString()} Token（已扣除缓存） · 四项基础费用：{Object.entries(call.costBreakdown.partsUsd).map(([key, value]) => `${key} $${value}`).join(' / ')}</p>}
    <UsagePriceEditor provider={channelId(call)} channelLabel={channelLabel(call)} model={call.model} onSaved={onSaved} />
  </>;
}

function display(value: number | null, field: Metric) {
  if (value == null) return '未上报';
  return field === 'recordedCostUsd' ? `$${value.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : value.toLocaleString('zh-CN');
}

function timeLabel(value: string) {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? '时间未上报' : timestamp.toLocaleString('zh-CN', { hour12: false });
}

function switchTab(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next]?.click(); tabs[next]?.focus();
}

function MetricCards({ summary, compact=false }: { summary: Summary; compact?:boolean }) {
  const cards = (metrics: typeof METRICS[number][]) => metrics.map(([field, label]) => (
    <div className={`usage-metric ${['totalTokens','inputTokens','outputTokens','recordedCostUsd'].includes(field)?'primary':'secondary'}`} key={field}>
      <span>{label}</span><strong>{display(summary[field], field)}</strong>
      <small>{field === 'recordedCostUsd' && summary[field] === 0 ? `记录返回 0 · 不代表免费 · ${summary.coverage[field]}/${summary.calls} 次上报` : summary.coverage[field] < summary.calls && summary[field] !== null
        ? `部分合计 · ${summary.coverage[field]}/${summary.calls} 次已上报` : summary[field] === null ? '没有可用记录' : '已记录合计'}</small>
    </div>
  ));
  if (compact) return <div className="usage-metrics is-compact">{cards([...METRICS])}</div>;
  return <>
    <div className="usage-metrics">{cards(METRICS.filter(([field])=>['totalTokens','inputTokens','outputTokens','recordedCostUsd'].includes(field)))}</div>
    <details className="usage-extra-metrics"><summary>缓存与推理用量</summary><div className="usage-metrics is-compact">{cards(METRICS.filter(([field])=>['cacheReadTokens','cacheWriteTokens','reasoningTokens'].includes(field)))}</div></details>
  </>;
}

/** Collapsible current-chat and whole-project usage. No prompt text is fetched. */
export default function UsagePanel({ sessionId, refreshKey, isStreaming = false, embedded = false, sessionTitles = {} }: {
  sessionId: string;
  refreshKey?: number;
  isStreaming?: boolean;
  embedded?: boolean;
  sessionTitles?: Record<string, string>;
}) {
  const [expanded, setOpen] = useState(false);
  const open = embedded || expanded;
  const [providerFilter,setProviderFilter]=useState('');
  const [modelFilter,setModelFilter]=useState('');
  const [fromDate,setFromDate]=useState('');
  const [toDate,setToDate]=useState('');
  const [scope, setScope] = useState<'session' | 'project'>('session');
  const [view, setView] = useState<'overview' | 'requests'>('overview');
  const [data, setData] = useState<Usage | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setOffset(0); setData(null); setError(''); setProviderFilter(''); setModelFilter(''); setFromDate(''); setToDate(''); setView('overview'); }, [sessionId]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
    const query = new URLSearchParams({ sessionId, offset: String(offset), limit: '30' });
    fetch(`${base}/api/usage?${query}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : '用量读取失败');
        return result as Usage;
      })
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '用量读取失败');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId, refreshKey, isStreaming, open, offset, revision]);
  useEffect(()=>{if(!isStreaming||!open||loading)return;const timer=setTimeout(refresh,5000);return()=>clearTimeout(timer);},[isStreaming,open,loading,revision,refresh]);
  const current = data?.sessionId === sessionId ? data : null;
  const unit = current?.recordUnit === 'usage_events' ? '用量事件' : '调用';
  const summary = current?.[scope];
  const trend = current?.turns.slice().reverse()||[];
  const allCalls = current?.turns.flatMap(turn=>turn.calls)||[];
  const providers = [...new Map(allCalls.map(call=>[channelId(call), channelLabel(call)])).entries()];
  const models = [...new Set(allCalls.filter(call=>!providerFilter||channelId(call)===providerFilter).map(call=>call.model))];
  const matchedCalls = allCalls.filter(call=>(!providerFilter||channelId(call)===providerFilter)&&(!modelFilter||call.model===modelFilter)&&(!fromDate||new Date(call.timestamp).getTime()>=new Date(`${fromDate}T00:00:00`).getTime())&&(!toDate||new Date(call.timestamp).getTime()<new Date(`${toDate}T23:59:59.999`).getTime()));
  const trendMax = Math.max(1,...trend.map(t=>t.summary.totalTokens||0));
  return (
    <section className={`usage-panel${open ? ' is-open' : ''}${embedded ? ' is-embedded' : ''}`} aria-label="Token 用量统计">
      {!embedded && <button type="button" className="usage-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span aria-hidden="true">◫</span><span>Token 用量</span>
        {current?.session.totalTokens != null && <span className="usage-toggle-value">本会话 {current.session.totalTokens.toLocaleString('zh-CN')}</span>}
        <span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>}
      {open && <div className="usage-body" aria-busy={loading}>
        <div className="usage-toolbar">
          <div className="usage-tabs" role="tablist" aria-label="用量范围" onKeyDown={switchTab}>
            <button type="button" role="tab" tabIndex={scope === 'session' ? 0 : -1} aria-selected={scope === 'session'} onClick={() => { setScope('session'); setView('overview'); }}>本次会话</button>
            <button type="button" role="tab" tabIndex={scope === 'project' ? 0 : -1} aria-selected={scope === 'project'} onClick={() => { setScope('project'); setView('overview'); }}>整个项目</button>
          </div>
          <div className="usage-refresh"><span>{current ? `更新于 ${new Date(current.updatedAt * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}</span><button type="button" className="btn btn-sm" onClick={refresh} disabled={loading}>{loading ? '读取中…' : '刷新用量'}</button></div>
        </div>
        {error && <p className="usage-error" role="alert">{error}</p>}
        {isStreaming && <p className="usage-note">对话进行中，定时读取已落盘用量；当前数字不包含服务尚未上报的使用量。</p>}
        {summary && current ? <>
          {!summary.calls ? <div className="usage-empty-state" role="status"><span className="usage-empty-icon" aria-hidden="true"><IconCoins size={26} /></span><h3>{scope === 'session' ? '本次会话暂无用量记录' : '项目暂无用量记录'}</h3><p>模型调用完成、用量写入后，就能在这里查看。<br />尚未上报的 Token 和费用不会记为 0。</p>{scope === 'session' && current.project.calls > 0 && <button type="button" className="btn" onClick={() => setScope('project')}>查看整个项目 · {current.project.calls} 次调用 <span aria-hidden="true">→</span></button>}</div> : <>
          <div className="usage-coverage"><div><strong>{summary.calls} 次调用</strong><span>{summary.reportedCalls} 次有 Token 记录{scope === 'project' ? ` · ${current.sessionCount} 个会话` : ''}</span></div><span className={`usage-coverage-badge${summary.missingCalls ? ' is-partial' : ''}`}>{summary.missingCalls ? `${summary.missingCalls} 次未上报` : 'Token 记录已覆盖'}</span><span className="usage-coverage-track" role="img" aria-label={`${summary.calls} 次模型调用 · ${summary.reportedCalls} 次有 Token 记录 · ${summary.missingCalls} 次未上报`}><span style={{ width: `${Math.min(100, summary.reportedCalls / summary.calls * 100)}%` }} /></span></div>
          {scope === 'session' && <div className="usage-view-tabs" role="tablist" aria-label="用量内容" onKeyDown={switchTab}><button type="button" role="tab" tabIndex={view === 'overview' ? 0 : -1} aria-selected={view === 'overview'} onClick={() => setView('overview')}>消耗总览</button><button type="button" role="tab" tabIndex={view === 'requests' ? 0 : -1} aria-selected={view === 'requests'} onClick={() => setView('requests')}>请求明细 <span>{summary.calls}</span></button></div>}
          <div hidden={scope === 'session' && view !== 'overview'}>
          <MetricCards summary={summary} />
          <div className="usage-performance-summary"><div><span>渠道估算 · 非账单</span><strong>{summary.estimatedCostUsd == null ? '待补充报价或用量' : `$${summary.estimatedCostUsd.toFixed(8)}`}</strong><small>{summary.estimatedCostUsd == null ? '价格或用量不完整，暂不估算' : `${(summary.coverage.estimatedCostUsd ?? 0) < summary.calls ? '部分合计 · ' : ''}${summary.coverage.estimatedCostUsd ?? 0}/${summary.calls} 次已计价`}</small></div>
            {(['stream', 'estimated'] as const).map(source => <div key={source}><span>{source === 'stream' ? '流式速度' : '估算速度（含等待）'}</span><strong>{summary.performance?.[source]?.outputTokensPerSecond == null ? '—' : `${summary.performance[source].outputTokensPerSecond?.toFixed(2)} tok/s`}</strong><small>{summary.performance?.[source]?.calls ? `${summary.performance[source].calls} 个有效样本` : '暂无有效样本'}</small></div>)}</div>
          {!!current.channels?.[scope]?.length && <div className="usage-table-scroll"><table><caption>按消耗渠道汇总 · {scope === 'session' ? '本次会话' : '整个项目'}</caption><thead><tr><th>渠道 / 地址</th><th>模型</th><th>调用</th><th>总 Token</th><th>记录费用 · USD</th><th>渠道估算 · USD</th></tr></thead><tbody>{current.channels[scope].map(channel=><tr key={channel.id}><td><strong>{channel.name}</strong><small>{channel.endpoint || '地址未记录'}</small></td><td>{channel.models.join(' / ')}</td><td>{channel.summary.calls}</td><td>{display(channel.summary.totalTokens,'totalTokens')}{channel.summary.coverage.totalTokens < channel.summary.calls && channel.summary.totalTokens != null ? '（部分）' : ''}</td><td>{display(channel.summary.recordedCostUsd,'recordedCostUsd')}</td><td>{channel.summary.estimatedCostUsd == null ? '价格或用量不完整' : `$${channel.summary.estimatedCostUsd.toFixed(8)}`} · {channel.summary.coverage.estimatedCostUsd ?? 0}/{channel.summary.calls} 次已计价</td></tr>)}</tbody></table></div>}
          {scope === 'session' && trend.length>0 && <section className="usage-trend" aria-label="当前分页轮次Token分布"><div className="usage-trend-heading"><h3>轮次用量分布</h3><span>当前分页 {trend.length} 轮 · 从较早到较新</span></div><div className="usage-bars">{trend.map(t=><div className="usage-bar-item" key={t.id} title={`${t.unattributed?'未关联轮次':`第 ${t.number} 轮`}：${display(t.summary.totalTokens,'totalTokens')}`}><span className="usage-bar-value">{t.summary.totalTokens===null?'—':t.summary.totalTokens.toLocaleString()}</span><div className="usage-bar-track"><div style={{height:`${t.summary.totalTokens===null?0:t.summary.totalTokens/trendMax*100}%`}}/></div><span>{t.unattributed?'未关联':t.number}</span></div>)}</div><p className="usage-note">仅展示当前分页已记录用量，不是全历史趋势；— 表示未上报，部分上报轮次详见下方。</p></section>}
          </div>
          {scope==='session'&&<section hidden={view !== 'requests'} className="usage-request-browser"><div className="usage-trend-heading"><h3>每次请求</h3><span>筛选当前页 · {matchedCalls.length} / {allCalls.length} 次</span></div><div className="usage-request-filters"><label>消耗渠道<Select value={providerFilter} onChange={e=>{setProviderFilter(e.target.value);setModelFilter('');}}><option value="">全部渠道</option>{providers.map(([id,label])=><option key={id} value={id}>{label}</option>)}</Select></label><label>模型<Select value={modelFilter} onChange={e=>setModelFilter(e.target.value)}><option value="">全部模型</option>{models.map(m=><option key={m} value={m}>{m||'未记录模型'}</option>)}</Select></label><label>起始日期<input type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)}/></label><label>截止日期<input type="date" value={toDate} min={fromDate||undefined} onChange={e=>setToDate(e.target.value)}/></label><button className="btn btn-sm" onClick={()=>{setProviderFilter('');setModelFilter('');setFromDate('');setToDate('');}}>清除筛选</button></div><p className="usage-note">筛选仅作用于当前页请求，总览仍为本会话完整统计。展开请求可查看缓存、推理、费用和耗时。</p>{!matchedCalls.length?<p className="usage-empty">没有匹配的请求。可清除筛选，或在下方翻页查看更多记录。</p>:<div className="usage-request-list">{matchedCalls.map(call=><details key={call.id}><summary><strong>{call.model||'未记录模型'}</strong><span>{channelLabel(call)} · {timeLabel(call.timestamp)}</span><span>{display(call.totalTokens,'totalTokens')} Token</span></summary><dl><div><dt>请求记录 ID</dt><dd>{call.id}</dd></div>{METRICS.map(([k,label])=><div key={k}><dt>{label}</dt><dd>{display(call[k],k)}</dd></div>)}</dl><RequestMetrics call={call} onSaved={refresh} /><p className="usage-note">费用取自服务记录；未上报时不按模型报价猜算。输入包含缓存，缓存字段不再额外加到输入总量。</p></details>)}</div>}</section>}
          {scope === 'session' ? <div hidden={view !== 'requests'} className="usage-turns"><details className="usage-turn-group"><summary>按轮次查看 <span>{current.turns.length} 轮 · 当前页</span></summary>
            {current.turns.map((turn) => <details className="usage-turn" key={turn.id}>
              <summary><span>{turn.unattributed ? '未关联轮次' : `第 ${turn.number} 轮`}</span><span>{timeLabel(turn.timestamp)}</span>
                <strong>{display(turn.summary.totalTokens, 'totalTokens')} Token</strong><span>{turn.calls.length} 条{unit}记录</span></summary>
              <MetricCards summary={turn.summary} compact />
              <div className="usage-table-scroll"><table><caption>本轮模型调用明细</caption><thead><tr>
                <th>模型 / 消耗渠道</th>{METRICS.map(([field, label]) => <th key={field}>{label}</th>)}
              </tr></thead><tbody>{turn.calls.map((call) => <tr key={call.id}>
                <td><strong>{call.model}</strong><small>{channelLabel(call)} · {timeLabel(call.timestamp)}</small></td>
                {METRICS.map(([field]) => <td key={field}>{display(call[field], field)}</td>)}
              </tr>)}</tbody></table></div>
            </details>)}
            </details>{current.turnCount > current.limit && <div className="usage-pagination">
              <button type="button" className="btn btn-sm" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - current.limit))}>较新轮次</button>
              <span>{offset + 1}–{Math.min(offset + current.limit, current.turnCount)} / {current.turnCount}</span>
              <button type="button" className="btn btn-sm" disabled={loading || offset + current.limit >= current.turnCount} onClick={() => setOffset(offset + current.limit)}>更早轮次</button>
            </div>}
          </div> : <div className="usage-table-scroll"><table><caption>项目会话汇总（最近 100 个有记录的会话）</caption>
            <thead><tr><th>会话</th><th>模型调用</th><th>总 Token</th><th>记录费用 · USD</th><th>最后记录</th></tr></thead>
            <tbody>{current.sessions.map((session) => <tr key={session.sessionId}>
              <td title={session.sessionId}>{sessionTitles[session.sessionId] || (session.sessionId === sessionId ? '当前会话' : session.sessionId)}</td><td>{session.summary.calls}</td>
              <td>{display(session.summary.totalTokens, 'totalTokens')}{session.summary.coverage.totalTokens < session.summary.calls && session.summary.totalTokens != null ? '（部分）' : ''}</td>
              <td>{display(session.summary.recordedCostUsd, 'recordedCostUsd')}</td><td>{timeLabel(session.lastAt)}</td>
            </tr>)}</tbody></table></div>}
          </>}
          <div className="usage-source-notes">
            <p className="usage-source-line">数据来源与统计口径 <span>OpenClaw / Codex · 非服务商账单</span><InlineInfo label="数据来源与统计口径" hover wide>
              <p className="usage-note">未上报字段保留未知，记录费用与渠道估算均不代表服务商账单。输入包含缓存，缓存与推理不会重复累加到总量。Codex 按用量事件统计，一条记录可能包含多次请求。</p>
              <p className="usage-note">{current.channelNote}</p><p className="usage-note">{current.note}</p><p className="usage-note">{current.costNote}</p><p className="usage-note">{current.performanceNote}</p><p className="usage-note">{current.pricingNote}</p>
              <p className="usage-note">{current.scope}</p>
            </InlineInfo></p>
            {current.issues.map((issue) => <p className="usage-note" key={issue}>{issue}</p>)}
            <p className="usage-note">更新于 {new Date(current.updatedAt*1000).toLocaleString('zh-CN')}</p>
          </div>
        </> : !error && <p className="usage-note" role="status">正在读取本项目的用量记录…</p>}
      </div>}
    </section>
  );
}
