import { useCallback, useEffect, useState } from 'react';
import '../styles/usage.css';

const METRICS = [
  ['totalTokens', '总 Token'], ['inputTokens', '输入（含缓存）'], ['outputTokens', '输出'],
  ['cacheReadTokens', '缓存读取'], ['cacheWriteTokens', '缓存写入'], ['reasoningTokens', '推理'],
  ['recordedCostUsd', '记录费用 · USD'],
] as const;
type Metric = typeof METRICS[number][0];
type Counts = Record<Metric, number | null>;
type Summary = Counts & { calls: number; reportedCalls: number; missingCalls: number; coverage: Record<Metric, number> };
type Call = Counts & { id: string; timestamp: string; model: string; provider: string };
type Turn = { id: string; number: number; timestamp: string; unattributed: boolean; summary: Summary; calls: Call[] };
type Usage = {
  sessionId: string; session: Summary; project: Summary; turns: Turn[]; turnCount: number;
  offset: number; limit: number; sessionCount: number; sourceCount: number; updatedAt: number;
  sessions: { sessionId: string; summary: Summary; lastAt: string }[];
  scope: string; note: string; costNote: string; issues: string[];
};

function display(value: number | null, field: Metric) {
  if (value === null) return '未上报';
  return field === 'recordedCostUsd' ? `$${value.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : value.toLocaleString('zh-CN');
}

function timeLabel(value: string) {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? '时间未上报' : timestamp.toLocaleString('zh-CN', { hour12: false });
}

function MetricCards({ summary }: { summary: Summary }) {
  return <div className="usage-metrics">{METRICS.map(([field, label]) => (
    <div className="usage-metric" key={field}>
      <span>{label}</span><strong>{display(summary[field], field)}</strong>
      <small>{summary.coverage[field] < summary.calls && summary[field] !== null
        ? `部分合计 · ${summary.coverage[field]}/${summary.calls} 次已上报` : summary[field] === null ? '没有可用记录' : '已记录合计'}</small>
    </div>
  ))}</div>;
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
  const [scope, setScope] = useState<'session' | 'project'>('session');
  const [data, setData] = useState<Usage | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setOffset(0); setData(null); setError(''); }, [sessionId]);
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
  const current = data?.sessionId === sessionId ? data : null;
  const summary = current?.[scope];
  return (
    <section className={`usage-panel${open ? ' is-open' : ''}`} style={embedded ? { margin: 0 } : undefined} aria-label="Token 用量统计">
      {!embedded && <button type="button" className="usage-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span aria-hidden="true">◫</span><span>Token 用量</span>
        {current?.session.totalTokens != null && <span className="usage-toggle-value">本会话 {current.session.totalTokens.toLocaleString('zh-CN')}</span>}
        <span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>}
      {open && <div className="usage-body" style={embedded ? { maxHeight: 'none', overflow: 'visible', paddingTop: 14 } : undefined}>
        <div className="usage-toolbar">
          <div className="usage-tabs" role="tablist" aria-label="用量范围">
            <button type="button" role="tab" aria-selected={scope === 'session'} onClick={() => setScope('session')}>本次会话</button>
            <button type="button" role="tab" aria-selected={scope === 'project'} onClick={() => setScope('project')}>整个项目</button>
          </div>
          <button type="button" className="btn btn-sm" onClick={refresh} disabled={loading}>{loading ? '读取中…' : '刷新用量'}</button>
        </div>
        {error && <p className="usage-error" role="alert">{error}</p>}
        {isStreaming && <p className="usage-note">对话进行中，当前显示已落盘用量；本轮完成后自动刷新。</p>}
        {summary && current ? <>
          <MetricCards summary={summary} />
          <p className="usage-note">{summary.calls} 次模型调用 · {summary.reportedCalls} 次有 Token 记录 · {summary.missingCalls} 次未上报
            {scope === 'project' ? ` · ${current.sessionCount} 个会话` : ''}</p>
          {!summary.calls && <p className="usage-empty">尚无可读取的模型用量记录。对话完成并写入 OpenClaw 记录后可刷新；这里不会把未上报用量当成 0。</p>}
          {scope === 'session' ? <div className="usage-turns">
            {current.turns.map((turn) => <details className="usage-turn" key={turn.id}>
              <summary><span>{turn.unattributed ? '未关联轮次' : `第 ${turn.number} 轮`}</span><span>{timeLabel(turn.timestamp)}</span>
                <strong>{display(turn.summary.totalTokens, 'totalTokens')} Token</strong><span>{turn.calls.length} 次调用</span></summary>
              <MetricCards summary={turn.summary} />
              <div className="usage-table-scroll"><table><caption>本轮模型调用明细</caption><thead><tr>
                <th>模型 / 服务商</th>{METRICS.map(([field, label]) => <th key={field}>{label}</th>)}
              </tr></thead><tbody>{turn.calls.map((call) => <tr key={call.id}>
                <td><strong>{call.model}</strong><small>{call.provider} · {timeLabel(call.timestamp)}</small></td>
                {METRICS.map(([field]) => <td key={field}>{display(call[field], field)}</td>)}
              </tr>)}</tbody></table></div>
            </details>)}
            {current.turnCount > current.limit && <div className="usage-pagination">
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
          {current.issues.map((issue) => <p className="usage-note" key={issue}>{issue}</p>)}
          <p className="usage-note">{current.note}</p><p className="usage-note">{current.costNote}</p>
          <p className="usage-note">{current.scope}</p>
        </> : !error && <p className="usage-note" role="status">正在读取本项目的用量记录…</p>}
      </div>}
    </section>
  );
}
