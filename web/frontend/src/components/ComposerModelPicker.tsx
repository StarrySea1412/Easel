import Select from './ui/Select';
import type { useComposerModels } from '../hooks/useComposerModels';
import { modelHealthLabel } from '../lib/modelHealth';
import { IconChevron, IconInfo } from './icons';
import { useEffect, useId, useState } from 'react';

export default function ComposerModelPicker({ models, disabled = false, onOpenModels }: {
  models: ReturnType<typeof useComposerModels>; disabled?: boolean; onOpenModels?: (modelRef?: string) => void;
}) {
  const connection = models.connection;
  const effective = models.selected || models.options.find(option => option.id === (models.capability?.currentModelRef || models.capability?.defaultModelRef));
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
  const reason = models.error || (!models.capability?.available ? models.capability?.reason : '');
  // A passed channel test or inference probe is success even when the gateway
  // cannot verify a per-turn override; those are separate capabilities.
  const tested = health?.state === 'success' || state === 'success';
  const hint = `${channelName} · ${connectionLabel}。${connection?.detail || '尚未读取渠道模型列表。'} 模型推理：${healthLabel}${health?.detail ? ` · ${health.detail}` : ''}。${reason || '可从模型设置检查连接或测试。'}`;
  const dotState = health?.state === 'failed' || health?.stale ? 'failed'
    : health?.state === 'running' || state === 'running' ? 'running'
      : tested ? 'success' : state === 'failed' ? 'failed' : 'unverified';
  const blockedHint = models.loading || !models.capability ? '模型状态暂未读到，可查看右侧详情。'
    : !models.capability.available ? '本轮暂不能指定模型，改用「自动沿用」仍可发送。' : '';
  const id = useId();
  // Keep each channel together, including when the gateway interleaves models.
  const channels = new Map<string, typeof models.options>();
  for (const option of models.options) {
    const group = channels.get(option.provider) || [];
    group.push(option); channels.set(option.provider, group);
  }
  const groupedOptions = [...channels.values()].flat();
  const icon = <span className={`composer-model-health ${dotState}`}><span className="composer-model-status-dot" /></span>;
  return <div className="composer-model-picker">
    <span id={`${id}-status`} className="composer-model-health-label">{hint}</span>
    {!models.loading && !models.options.length && onOpenModels ? <button type="button" className="easel-select composer-model-select" aria-label="模型设置" aria-describedby={`${id}-status`} disabled={disabled} onClick={() => onOpenModels(targetRef)}>{icon}<span className="easel-select-value">选择模型</span><IconChevron size={12}/></button> : <Select aria-label="本轮使用模型" aria-describedby={`${id}-status`} value={models.modelRef} disabled={disabled}
      className="composer-model-select" triggerIcon={icon}
      options={[{ value: '', label: '自动沿用' }, ...groupedOptions.map(option => ({ value: option.id,
        // The channel nickname disambiguates identical model ids served by different channels.
        label: `${option.channelName || option.provider} · ${option.model}${option.enabled === false ? ' · 已停用' : ''}`,
        group: option.channelName || option.provider, groupKey: option.provider,
        menuLabel: `${option.model}${option.enabled === false ? ' · 已停用' : ''}`,
        description: option.enabled === false ? '在模型设置中启用后即可使用' : blockedHint || `渠道 ${option.channelName || option.provider} · ${option.model} · 仅用于本轮消息`, disabled: option.enabled === false || models.loading || !models.capability?.available }))]}
      footer={onOpenModels ? { label: '模型设置', description: '配置与测试当前模型', onActivate: () => onOpenModels(targetRef) } : undefined}
      onChange={value => models.choose(value)} />}
    <span className="composer-model-info" role="img" aria-label="模型状态详情" title={hint}>
      <IconInfo size={13} strokeWidth={2} />
    </span>
  </div>;
}
