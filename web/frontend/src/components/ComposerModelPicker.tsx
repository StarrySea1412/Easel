import Select from './ui/Select';
import type { useComposerModels } from '../hooks/useComposerModels';
import { modelHealthLabel } from '../lib/modelHealth';
import { IconCheck, IconInfo } from './icons';
import { showToast } from '../lib/toast';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function ComposerModelPicker({ models, disabled = false, onOpenModels }: {
  models: ReturnType<typeof useComposerModels>; disabled?: boolean; onOpenModels?: () => void;
}) {
  const health = models.health?.results.find(result => result.modelRef === models.modelRef && result.mode === 'text');
  const healthLabel = modelHealthLabel(health);
  const connection = models.connection;
  const effective = models.selected || models.options.find(option => option.id === (models.capability?.currentModelRef || models.capability?.defaultModelRef));
  const channelName = effective?.channelName || connection?.channelName || '未命名渠道';
  const [slowLoading, setSlowLoading] = useState(false);
  useEffect(() => {
    if (!models.loading) return;
    const timer = setTimeout(() => setSlowLoading(true), 400);
    return () => { clearTimeout(timer); setSlowLoading(false); };
  }, [models.loading]);
  const state = models.loading && slowLoading ? 'running' : connection?.state || 'unverified';
  const connectionLabel = state === 'running' ? '检测中' : state === 'success' ? '渠道已连通' : state === 'failed' ? '渠道检测失败' : '渠道未验证';
  const healthHint = `${channelName} · ${connectionLabel}。${connection?.detail || '尚未读取渠道模型列表。'} 模型推理：${healthLabel}${health?.detail ? ` · ${health.detail}` : ''}。点击查看渠道状态。`;
  const unavailable = !models.loading && (Boolean(models.error) || !models.capability?.available);
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 12, top: 12 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), id = useId();
  useEffect(() => setOpen(false), [effective?.id, disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const width = panel.current?.offsetWidth || 290, height = panel.current?.offsetHeight || 160;
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(rect.top - height - 8, window.innerHeight - height - 12)) });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, healthHint]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className="composer-model-picker">
    <button ref={trigger} type="button" className={`composer-model-health ${state}`} aria-label={`渠道状态：${healthHint}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(value => !value)} disabled={disabled}>
      {state === 'success' ? <IconCheck size={13}/> : <IconInfo size={13}/>}<span className="composer-model-health-label">{connectionLabel}</span>
    </button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label="渠道状态详情" className="composer-channel-popover" style={position}>
      <header><strong>{channelName}</strong><button type="button" aria-label="关闭渠道状态" onClick={() => { setOpen(false); trigger.current?.focus(); }}>×</button></header>
      <p>{connectionLabel} · {connection?.detail || '尚未读取渠道模型列表。'}</p>
      <p>模型推理：{healthLabel}{health?.detail ? ` · ${health.detail}` : ''}</p>
      <button type="button" className="link-btn" disabled={state === 'running'} onClick={() => { models.refresh(); showToast('正在重新读取渠道模型列表…'); }}>重新读取渠道</button>
    </div>, document.body)}
    <Select aria-label="本轮使用模型" value={models.modelRef} disabled={disabled}
      title="仅用于本轮消息；所选模型不可用时保留草稿" className="composer-model-select"
      options={[{ value: '', label: '沿用会话模型', description: '未单独指定时使用设置中的默认模型' }, ...models.options.map(option => ({ value: option.id, label: option.model,
        description: models.loading ? '正在读取模型状态…' : !models.capability?.available ? '暂不可选，请查看输入框旁的原因'
          : `渠道：${option.channelName || '未命名渠道'} · 仅用于本轮消息`, disabled: models.loading || !models.capability?.available })),
        ...(onOpenModels ? [{value:'__manage_models__',label:'添加或设置模型…',description:'打开模型设置，选择、添加或导入'}] : [])]}
      onChange={value => value === '__manage_models__' ? onOpenModels?.() : models.choose(value)} />
    {!unavailable && !models.ready && !models.loading && <button type="button" className="link-btn" disabled={disabled} onClick={models.refresh}>刷新模型</button>}
  </div>;
}

export function ComposerModelStatus({ models, disabled = false, onOpenModels }: {
  models: ReturnType<typeof useComposerModels>; disabled?: boolean; onOpenModels?: () => void;
}) {
  if (models.loading || (!models.error && models.capability?.available && models.ready)) return null;
  const reason = models.error || (models.modelRef && !models.selected ? '先前选择的模型已不在配置中，请重新选择。草稿会保留。'
    : !models.options.length ? '还没有可选模型。请先添加供应商或导入已有配置。'
    : models.capability?.reason || '暂时无法确认模型状态，请重新读取。');
  const unconfigured = !models.error && !models.options.length;
  return <div className="composer-model-guidance" role="status">
    <span title={reason}>{unconfigured ? '未配置模型' : '模型暂不可用'}</span>
    {onOpenModels && <button type="button" className="link-btn" disabled={disabled} onClick={onOpenModels}>配置模型</button>}
    {!unconfigured && <details className="composer-model-details">
      <summary>查看原因</summary>
      <div><p>{reason}</p><button type="button" className="link-btn" disabled={disabled} onClick={models.refresh}>重新读取</button></div>
    </details>}
    {unconfigured && !onOpenModels && <button type="button" className="link-btn" disabled={disabled} onClick={models.refresh}>重新读取</button>}
  </div>;
}
