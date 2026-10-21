import Select from './ui/Select';
import type { useComposerModels } from '../hooks/useComposerModels';
import { modelHealthLabel } from '../lib/modelHealth';
import { IconChevron, IconCube } from './icons';
import { useEffect, useState } from 'react';

export default function ComposerModelPicker({ models, disabled = false, onOpenModels }: {
  models: ReturnType<typeof useComposerModels>; disabled?: boolean; onOpenModels?: (modelRef?: string) => void;
}) {
  const connection = models.connection;
  const effective = models.selected || models.options.find(option => option.id === models.modelRef) || models.options.find(option => option.id === (models.capability?.currentModelRef || models.capability?.defaultModelRef)) || models.options.find(option => option.enabled !== false);
  const targetRef = effective?.id || models.modelRef || undefined;
  const health = models.health?.results.find(result => result.modelRef === targetRef && result.mode === 'text');
  const healthLabel = modelHealthLabel(health);
  const channelName = effective?.channelName || connection?.channelName || '未命名渠道';
  const [slowLoading, setSlowLoading] = useState(false);
  useEffect(() => {
    if (!models.loading) return;
    const timer = setTimeout(() => setSlowLoading(true), 400);
    return () => { clearTimeout(timer); setSlowLoading(false); };
  }, [models.loading]);
  const state = models.loading && slowLoading ? 'running' : connection?.state || 'unverified';
  const connectionLabel = state === 'running' ? '检测中' : state === 'success' ? '渠道已连通' : state === 'failed' ? '渠道检测失败' : '渠道未验证';
  // A passed channel test or inference probe is success even when the gateway
  // cannot verify a per-turn override; those are separate capabilities.
  const tested = health?.state === 'success' || state === 'success';
  const dotState = health?.state === 'failed' || health?.stale ? 'failed'
    : health?.state === 'running' || state === 'running' ? 'running'
      : tested ? 'success' : state === 'failed' ? 'failed' : 'unverified';
  const statusTitle = `${connectionLabel} · ${healthLabel}`;
  // Keep each channel together, including when the gateway interleaves models.
  const channels = new Map<string, typeof models.options>();
  for (const option of models.options) {
    const group = channels.get(option.provider) || [];
    group.push(option); channels.set(option.provider, group);
  }
  const currentOptions = channels.get(effective?.provider || '') || [];
  const enabledChannels = [...channels].filter(([, options]) => options.some(option => option.enabled !== false));
  const icon = <span className={`composer-model-health ${dotState}`} role="img" aria-label={statusTitle} title={statusTitle}><span className="composer-model-status-dot" /></span>;
  return <div className="composer-model-picker">
    <span className="composer-model-health-label">{statusTitle}</span>
    {!models.loading && !models.options.length && onOpenModels ? <button type="button" className="easel-select composer-model-select" aria-label="模型设置" disabled={disabled} onClick={() => onOpenModels(targetRef)}>{icon}<span className="easel-select-value">选择模型</span><IconChevron size={12}/></button> : <Select aria-label="选择模型" title={effective ? `${channelName} · ${effective.model}` : '选择模型'} value={models.modelRef} placeholder={effective?.model || '选择模型'} disabled={disabled}
      className="composer-model-select" triggerIcon={icon}
      options={currentOptions.map(option => ({ value: !models.modelRef && option.id === effective?.id ? '' : option.id,
        label: `${option.channelName || option.provider} · ${option.model}${option.enabled === false ? ' · 已停用' : ''}`,
        menuLabel: `${option.model}${option.enabled === false ? ' · 已停用' : ''}`,
        disabled: option.enabled === false }))}
      header={{ label: channelName, description: 'API', icon: <IconCube size={16}/>, items: enabledChannels.map(([provider, options]) => ({ key: provider, label: options[0].channelName || provider, selected: provider === effective?.provider, onActivate: () => {
          const next = options.find(option => option.enabled !== false && option.model === effective?.model) || options.find(option => option.enabled !== false);
          if (next) models.choose(next.id);
        } }))}}
      {...(onOpenModels ? { footer: { label: '管理模型', onActivate: () => onOpenModels(targetRef) } } : {})}
      onChange={value => models.choose(value)} />}
  </div>;
}
