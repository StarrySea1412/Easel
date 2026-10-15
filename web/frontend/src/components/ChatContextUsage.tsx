import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPanel } from '../hooks/useAnchoredPanel';
import ChatUsageDialog from './ChatUsageDialog';
import '../styles/context-usage.css';

type Snapshot = {
  sessionId: string; modelRef: string; observedModelRef: string; capacity: number | null;
  capacitySource: string; usedTokens: number | null; usageSource: string; updatedAt: number | string | null;
  stale: boolean; breakdownStatus: string; note: string; breakdownNote: string;
  breakdown: { key: string; label: string; tokens: number | null; percent: number | null }[];
};
function compact(value: number | null | undefined) {
  if (value == null) return '—';
  return value >= 10000 ? `${Number((value / 10000).toFixed(1))}万` : value.toLocaleString('zh-CN');
}
export default function ChatContextUsage({ sessionId, modelRef = '', engine = 'openclaw', refreshKey = 0, streaming = false, onOpenModels }: {
  sessionId: string; modelRef?: string; engine?: 'openclaw' | 'codex'; refreshKey?: number; streaming?: boolean;
  onOpenModels?: (modelRef?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{ key: string; data: Snapshot } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [pending, setPending] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const id = useId();
  const dismiss = useCallback(() => setOpen(false), []);
  const position = useAnchoredPanel(open, dismiss, button, panel, 'above', 360);
  const requestKey = `${engine}:${sessionId}:${modelRef}`;
  const data = snapshot?.key === requestKey ? snapshot.data : null;
  const error = failure?.key === requestKey ? failure.message : '';
  useEffect(() => { setOpen(false); setDetails(false); }, [sessionId, engine]);
  useEffect(() => {
    if (engine === 'codex') { setPending(false); return; }
    const controller = new AbortController();
    setPending(true); setFailure(null);
    const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
    const query = new URLSearchParams({ sessionId, modelRef });
    fetch(`${base}/api/usage/context?${query}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const value = await response.json();
        if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '上下文快照暂不可读');
        if (!controller.signal.aborted) setSnapshot({ key: requestKey, data: value });
      }).catch(cause => {
        if (!controller.signal.aborted) setFailure({ key: requestKey, message: cause instanceof Error ? cause.message : '上下文快照暂不可读' });
      }).finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [sessionId, modelRef, engine, requestKey, refreshKey, streaming, revision]);
  useEffect(() => {
    if (!open || !streaming || engine === 'codex') return;
    const timer = setInterval(() => setRevision(value => value + 1), 15000);
    return () => clearInterval(timer);
  }, [open, streaming, engine]);
  const used = data?.usedTokens;
  const capacity = data?.capacity;
  const percent = used != null && capacity ? used / capacity * 100 : null;
  const known = percent != null && Number.isFinite(percent);
  const label = known ? `上下文容量，${percent.toFixed(1)}% 已用` : used != null ? '上下文容量，容量尚未提供' : '上下文容量，占用尚未提供';
  const tone = known && percent >= 90 ? 'danger' : known && percent >= 75 ? 'warn' : '';
  const updated = data?.updatedAt ? new Date(data.updatedAt) : null;
  return <>
    <button ref={button} type="button" className={`context-usage-trigger ${tone}${known ? '' : ' is-unknown'}`} aria-label={label} title={label}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>
      <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true"><circle className="context-ring-track" cx="12" cy="12" r="8" />
        {known && <circle className="context-ring-value" cx="12" cy="12" r="8" pathLength="100" strokeDasharray={`${Math.min(100, Math.max(0, percent))} 100`} transform="rotate(-90 12 12)" />}
      </svg><span className="context-trigger-percent">{known ? `${Math.round(percent)}%` : '—'}</span>
    </button>
    {open && createPortal(<section ref={panel} id={id} className={`context-usage-panel ${tone}`} role="dialog" aria-label="上下文容量" tabIndex={-1} style={position}>
      <header><h2>上下文容量</h2><button type="button" className="context-close" aria-label="关闭上下文容量" onClick={() => { dismiss(); button.current?.focus(); }}>×</button></header>
      <div className="context-usage-total" title={used == null ? '占用未提供' : `${used.toLocaleString()} / ${capacity?.toLocaleString() || '容量未知'} Token`}>
        <strong>{compact(used)} <span>/ {compact(capacity)}</span></strong><b>{known ? `${percent.toFixed(1)}%` : used != null ? '容量未知' : '占用未知'}</b>
      </div>
      <div className="context-capacity-track" role={known ? 'progressbar' : undefined} aria-label="上下文已用比例" aria-valuenow={known ? Math.min(100, percent) : undefined} aria-valuemin={known ? 0 : undefined} aria-valuemax={known ? 100 : undefined}>
        <span style={{ width: known ? `${Math.min(100, percent)}%` : '0%' }} />
      </div>
      <div className="context-snapshot-line"><span>{data?.usageSource === 'model_changed' ? '模型已切换，等待新请求快照' : data?.usageSource === 'last_request' ? '上次请求输入' : data?.usageSource === 'runtime' ? '最近运行时快照' : '尚无可用快照'}{streaming ? ' · 生成中' : ''}</span>
        {updated && !Number.isNaN(updated.getTime()) && <time dateTime={updated.toISOString()}>{updated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>}</div>
      {data?.modelRef && <p className="context-model" title={data.modelRef}>{data.modelRef}</p>}
      {engine !== 'codex' && !capacity && onOpenModels && <button type="button" className="context-configure" onClick={() => { dismiss(); onOpenModels(data?.modelRef || modelRef || undefined); }}>设置模型上下文容量 ↗</button>}
      {engine === 'codex' ? <p className="context-note">Codex 尚未提供上下文分类快照；未提供不代表零消耗。</p>
        : <>
          {error && <p role="alert" className="context-error">{error}{data ? ' · 下方保留上次快照' : ''}</p>}
          <div className="context-breakdown-heading"><span>上下文构成</span><small>{data?.breakdownStatus === 'estimated' ? '估算占比' : '分类未提供'}</small></div>
          <dl className="context-breakdown">{(data?.breakdown || ['消息', '系统工具', 'MCP 工具', '系统提示词', '技能', '其它'].map((label, index) => ({ key: String(index), label, tokens: null, percent: null }))).map((part, index) => <div key={part.key}>
            <dt><i className={`context-category context-category-${index}`} />{part.label}</dt><dd>{part.percent == null ? <span>未提供</span> : <><strong>≈{part.percent.toFixed(1)}%</strong><small>≈{compact(part.tokens)} Token</small></>}</dd>
          </div>)}</dl>
          <details className="context-source"><summary>统计口径{data?.stale ? ' · 快照参考' : ''}</summary><p>{data?.note || '尚未收到本会话的上下文快照，不使用累计Token推算占用。'}</p>
            <p>{data?.breakdownStatus === 'estimated' ? data.breakdownNote : data?.breakdownStatus === 'inconsistent' ? '分类报告与快照不一致，暂不计算占比。' : '当前运行时未提供可对应的分类报告，不能精确拆分上下文。'}</p>
            <p>容量{data?.capacitySource === 'model_config' ? '取自所选模型配置' : data?.capacitySource === 'runtime' ? '取自运行时配置' : '未提供'}。未提交的草稿不计入；上次快照不等于下一次请求。</p></details>
        </>}
      <footer><button type="button" className="context-details" onClick={() => { dismiss(); setDetails(true); }}>消耗与费用明细 <span aria-hidden="true">↗</span></button>
        {engine !== 'codex' && <button type="button" disabled={pending} onClick={() => setRevision(value => value + 1)}>{pending ? '读取中…' : '刷新'}</button>}</footer>
    </section>, document.body)}
    <ChatUsageDialog sessionId={sessionId} refreshKey={refreshKey} streaming={streaming} engine={engine} open={details} onOpenChange={setDetails} returnFocusRef={button} />
  </>;
}
