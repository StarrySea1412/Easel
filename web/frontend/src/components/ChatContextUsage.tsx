import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPanel } from '../hooks/useAnchoredPanel';
import ChatUsageDialog from './ChatUsageDialog';
import InlineInfo from './InlineInfo';
import '../styles/context-usage.css';

type Snapshot = {
  sessionId: string; modelRef: string; observedModelRef: string; capacity: number | null;
  capacitySource: string; usedTokens: number | null; usageSource: string; updatedAt: number | string | null;
  stale: boolean; breakdownStatus: string; note: string; breakdownNote: string;
  runtimeStore?: string; readWarning?: string;
  configuredWindow?: number | null; configuredLimit?: number | null; recordedLimit?: number | null;
  contextReference?: { tokens: number; label: string; source: string; url: string; checkedAt: string; note: string } | null;
  skills?: { installedCount: number | null; availableCount: number | null; listedCount: number | null; promptChars: number | null; source: string; note: string };
  previousSnapshot?: { modelRef: string; usedTokens: number; updatedAt: number | string | null } | null;
  breakdown: { key: string; label: string; tokens: number | null; percent: number | null; chars?: number | null; source?: string }[];
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
    if (!open || !streaming) return;
    const timer = setInterval(() => setRevision(value => value + 1), 15000);
    return () => clearInterval(timer);
  }, [open, streaming, engine]);
  const used = data?.usedTokens;
  const capacity = data?.capacity;
  const percent = used != null && capacity ? used / capacity * 100 : null;
  const known = percent != null && Number.isFinite(percent);
  const capacitySource = data?.capacitySource;
  const referenceOnly = capacitySource === 'official_reference';
  const runtimeLimited = capacitySource === 'runtime_config';
  const recordedOnly = capacitySource === 'session_snapshot';
  const basis = referenceOnly ? '原厂标称窗口' : recordedOnly ? '会话记录额度' : runtimeLimited ? '配置的会话额度' : '配置的模型窗口';
  const capacityNote = capacity == null ? null
    : runtimeLimited ? '容量为运行器会话额度（达到即触发压缩），不是模型上限；可在渠道设置中补齐模型窗口'
    : recordedOnly ? '容量仅取自旧会话记录，不是模型上限'
    : referenceOnly ? '容量为原厂标称窗口，尚未对本渠道核验' : null;
  const label = known ? `上下文容量，${percent.toFixed(1)}% 已用，按${basis}计算` : used != null ? '上下文容量，容量尚未提供' : '上下文容量，占用尚未提供';
  const tone = known && percent >= 90 ? 'danger' : known && percent >= 75 ? 'warn' : '';
  const updated = data?.updatedAt ? new Date(data.updatedAt) : null;
  const skills = data?.skills;
  return <>
    <button ref={button} type="button" className={`context-usage-trigger ${tone}${known ? '' : ' is-unknown'}`} aria-label={label} title={label}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>
      <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true"><circle className="context-ring-track" cx="12" cy="12" r="8" />
        {known && <circle className="context-ring-value" cx="12" cy="12" r="8" pathLength="100" strokeDasharray={`${Math.min(100, Math.max(0, percent))} 100`} transform="rotate(-90 12 12)" />}
      </svg><span className="context-trigger-percent">{known ? `${Math.round(percent)}%` : '—'}</span>
    </button>
    {open && createPortal(<section ref={panel} id={id} className={`context-usage-panel ${tone}`} role="dialog" aria-label="上下文容量" tabIndex={-1} style={position}>
      <header><h2>上下文容量<InlineInfo label="统计口径说明" hover wide>
        <p>{data?.note || '尚未收到本会话的上下文快照，不使用累计Token推算占用。'}</p>
        <p>{data?.breakdownStatus === 'estimated' || data?.breakdownStatus === 'partial' ? data.breakdownNote : data?.breakdownStatus === 'inconsistent' ? '已知字符数保留；分类报告与总量不一致，暂不计算占比。' : '当前运行时未提供可对应的分类报告，不能精确拆分上下文。'}</p>
        <p>字符数是本地记录值，Token按字符数÷4粗估；不同模型、中文和代码的分词会有差异。缺少分类只影响该项，已知项仍单独显示；未读的技能全文不计入。{data?.runtimeStore === 'sqlite' ? '当前会话读取 SQLite 存储。' : ''}</p>
        {skills && <p>{skills.note}</p>}
        <p>容量{data?.capacitySource === 'model_config' ? '取自所选模型配置' : referenceOnly ? '取自有出处的原厂参考资料，未经渠道验证' : data?.capacitySource === 'runtime_config' ? '取自显式运行器会话限制' : recordedOnly ? '仅取自旧会话记录，不等同模型上限' : '未提供'}。未提交的草稿不计入；上次快照不等于下一次请求。</p>
      </InlineInfo></h2><button type="button" className="context-close" aria-label="关闭上下文容量" onClick={() => { dismiss(); button.current?.focus(); }}>×</button></header>
      <div className="context-usage-total" title={used == null ? '占用未提供' : `${used.toLocaleString()} / ${capacity?.toLocaleString() || '容量未知'} Token`}>
        <strong>{compact(used)} <span>/ {compact(capacity)}</span></strong><span className="context-total-right"><b>{known ? `${percent.toFixed(1)}%` : used != null ? '容量未知' : '占用未知'}</b>{engine !== 'codex' && data && <InlineInfo label="容量依据说明" hover wide><p>{capacity ? `占比按${basis}计算` : '模型窗口尚未配置'}{referenceOnly && ' · 渠道支持尚未核验'}</p>{data.contextReference && <p>原厂标称 <strong>{data.contextReference.label}</strong> · 来源 {data.contextReference.url}{data.configuredWindow ? `；本渠道配置 ${compact(data.configuredWindow)} Token` : '；尚未写入运行器模型配置'}</p>}{data.configuredLimit != null && <p>运行器会话限制：{compact(data.configuredLimit)} Token（显式配置）</p>}{data.recordedLimit != null && <p>最近会话记录额度：{compact(data.recordedLimit)} Token{data.recordedLimit === 200000 && !data.configuredWindow && !data.configuredLimit ? '，与运行器通用默认值一致' : ''}。</p>}{(referenceOnly || recordedOnly || (data.recordedLimit != null && data.configuredWindow != null && data.recordedLimit !== data.configuredWindow)) && <p>{referenceOnly ? '标称窗口不代表当前渠道已开放；未补齐模型配置时，运行器仍可能按较小额度提前压缩。' : recordedOnly ? '会话记录可能来自默认值，不作为模型真实上限。' : '配置与旧会话记录不同；旧记录不会被改写，等待后续请求更新。'}</p>}</InlineInfo>}</span>
      </div>
      {capacityNote && <p className="context-capacity-source warn">{capacityNote}</p>}
      <div className="context-capacity-track" role={known ? 'progressbar' : undefined} aria-label="上下文已用比例" aria-valuenow={known ? Math.min(100, percent) : undefined} aria-valuemin={known ? 0 : undefined} aria-valuemax={known ? 100 : undefined}>
        <span style={{ width: known ? `${Math.min(100, percent)}%` : '0%' }} />
      </div>
      <div className="context-snapshot-line"><span>{data?.usageSource === 'model_changed' ? '模型已切换，等待新请求快照' : data?.usageSource === 'last_request' ? '上次请求输入' : data?.usageSource === 'runtime' ? '最近运行时快照' : '尚无可用快照'}{data?.stale ? ' · 快照参考' : ''}{streaming ? ' · 生成中' : ''}</span>
        {updated && !Number.isNaN(updated.getTime()) && <time dateTime={updated.toISOString()}>{updated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>}</div>
      {data?.modelRef && <p className="context-model" title={data.modelRef}>{data.modelRef}</p>}
      {engine !== 'codex' && onOpenModels && <button type="button" className="context-configure" onClick={() => { dismiss(); onOpenModels(data?.modelRef || modelRef || undefined); }}>{capacity ? '核对模型上下文设置 ↗' : '设置模型上下文容量 ↗'}</button>}
      {engine === 'codex' ? <p className="context-note">Codex 尚未提供上下文分类快照；未提供不代表零消耗。</p>
        : <>
          {error && <p role="alert" className="context-error">{error}{data ? ' · 下方保留上次快照' : ''}</p>}
          {data?.readWarning && <p className="context-note">{data.readWarning}</p>}
          {data?.previousSnapshot && <p className="context-previous">上次会话快照：{compact(data.previousSnapshot.usedTokens)} Token <span>{data.previousSnapshot.modelRef}</span><small>切换模型后不沿用旧占比，等待新模型的请求快照。</small></p>}
          <div className="context-breakdown-heading"><span>上下文构成</span><small>{data?.breakdownStatus === 'estimated' ? '估算占比' : data?.breakdownStatus === 'partial' ? '已知项估算' : data?.breakdownStatus === 'inconsistent' ? '报告待核对' : '等待分类报告'}</small></div>
          <dl className="context-breakdown">{(data?.breakdown || ['消息', '系统工具', 'MCP 工具', '系统提示词', '技能', '其它'].map((label, index) => ({ key: String(index), label, tokens: null, percent: null, chars: null, source: 'unavailable' }))).map((part, index) => <div key={part.key}>
            <dt><i className={`context-category context-category-${index}`} /><span>{part.label}{part.key === 'skills' && skills && <small>{skills.listedCount != null ? `${skills.listedCount} 项目录` : skills.availableCount != null ? `${skills.availableCount} 项会话登记` : skills.installedCount != null ? `${skills.installedCount} 项已安装` : ''}</small>}</span></dt>
            <dd>{part.tokens == null ? <span>{part.key === 'skills' && skills?.installedCount != null ? '待会话加载' : '待运行时上报'}</span> : <><strong>{part.percent != null ? `≈${part.percent.toFixed(1)}%` : `≈${compact(part.tokens)} Token`}</strong><small>{part.percent != null ? `≈${compact(part.tokens)} Token` : used != null ? '不计算占比' : '总占用待上报'}</small></>}
              {part.chars != null && <small className="context-part-source">{part.chars.toLocaleString('zh-CN')} 字符 · {part.source === 'session_skills' ? '会话技能快照' : '运行时报告'}</small>}</dd>
          </div>)}</dl>
          {skills && skills.source !== 'unavailable' && <p className="context-skills-fact">{skills.promptChars != null ? <>已知技能目录 {skills.promptChars.toLocaleString('zh-CN')} 字符{skills.availableCount != null ? `，会话登记 ${skills.availableCount} 项` : ''}。{skills.listedCount == null ? '目录来自会话缓存，尚未确认本轮实际注入。' : '目录已由运行时上报。'}</> : skills.installedCount != null ? <>本机提供 {skills.installedCount} 项技能；会话尚未返回注入目录。</> : '会话技能目录等待运行时记录。'}正文按需读取，计入消息与工具回执。</p>}
        </>}
      <footer><button type="button" className="context-details" onClick={() => { dismiss(); setDetails(true); }}>消耗与费用明细 <span aria-hidden="true">↗</span></button>
        {engine !== 'codex' && <button type="button" disabled={pending} onClick={() => setRevision(value => value + 1)}>{pending ? '读取中…' : '刷新'}</button>}</footer>
    </section>, document.body)}
    <ChatUsageDialog sessionId={sessionId} refreshKey={refreshKey} streaming={streaming} engine={engine} open={details} onOpenChange={setDetails} returnFocusRef={button} />
  </>;
}
