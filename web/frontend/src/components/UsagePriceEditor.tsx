import { useEffect, useState } from 'react';

const fields = [['input', '普通输入'], ['output', '输出'], ['cacheRead', '缓存读取'], ['cacheWrite', '缓存写入'], ['multiplier', '渠道倍率']] as const;
type Price = Record<typeof fields[number][0], string> & { currency: string; source: string };
const empty: Price = { input: '', output: '', cacheRead: '', cacheWrite: '', multiplier: '1', currency: 'USD', source: '' };
const priceUrl = () => `${window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '')}/api/usage/pricing`;

export default function UsagePriceEditor({ provider, model, onSaved }: { provider: string; model: string; onSaved: () => void }) {
  const [price, setPrice] = useState<Price>(empty);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setFeedback(''); setPrice(empty);
    void fetch(priceUrl(), { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('价格读取失败');
      const data = await response.json();
      if (!controller.signal.aborted) setPrice({ ...empty, ...data.prices?.[`${provider}/${model}`] });
    }).catch(error => { if (!controller.signal.aborted) setFeedback(error.message || '价格读取失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [provider, model, open]);
  const save = async () => {
    setSaving(true); setFeedback('');
    try {
      const response = await fetch(priceUrl(), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, model, pricing: price }) });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '价格保存失败');
      setFeedback('价格已保存；未计价记录将按此价格估算，已有估算保留原价格。'); onSaved();
    } catch (error) { setFeedback(error instanceof Error ? error.message : '价格保存失败'); }
    finally { setSaving(false); }
  };
  return <details className="usage-price-editor" onToggle={event => setOpen(event.currentTarget.open)}><summary>设置此渠道模型的计费价格</summary>
    <p className="usage-note">{provider} / {model} · USD / 百万 Token。按你使用的渠道报价填写，0 仅表示明确免费；不要填写 API Key。</p>
    <div className="usage-request-filters">{fields.map(([key, label]) => <label key={key}>{label}<input type="number" min="0" max="1000000" step="any" value={price[key]} disabled={loading || saving} onChange={event => setPrice({ ...price, [key]: event.target.value })} /></label>)}
      <label>价格来源<input maxLength={100} value={price.source} placeholder="例如：渠道报价 2026-10-09" disabled={loading || saving} onChange={event => setPrice({ ...price, source: event.target.value })} /></label>
      <button type="button" className="btn btn-sm" disabled={loading || saving || fields.some(([key]) => price[key] === '') || !price.source.trim()} onClick={save}>{loading ? '读取中…' : saving ? '保存中…' : '保存价格'}</button>
    </div>{feedback && <p className="usage-note" role="status">{feedback}</p>}
  </details>;
}
