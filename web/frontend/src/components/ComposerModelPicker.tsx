import Select from './ui/Select';
import type { useComposerModels } from '../hooks/useComposerModels';
import { modelHealthLabel } from '../lib/modelHealth';
import { IconChevron } from './icons';
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
  const healthHint = `${channelName} · ${connectionLabel}。${connection?.detail || '尚未读取渠道模型列表。'} 模型推理：${healthLabel}${health?.detail ? ` · ${health.detail}` : ''}。${reason || '可从模型设置检查连接或测试。'}`;
  const dotState = health?.state === 'failed' || health?.stale ? 'failed' : health?.state === 'running' || state === 'running' ? 'running' : state === 'failed' ? 'failed' : state === 'success' ? 'success' : 'unverified';
  const id = useId();
  const icon = <span className={`composer-model-health ${dotState}`}><span className="composer-model-status-dot" /></span>;
  return <div className="composer-model-picker">
    <span id={`${id}-status`} className="composer-model-health-label">{healthHint}</span>
    {!models.loading && !models.options.length && onOpenModels ? <button type="button" className="easel-select composer-model-select" aria-label="模型设置" aria-describedby={`${id}-status`} disabled={disabled} onClick={() => onOpenModels(targetRef)}>{icon}<span className="easel-select-value">选择模型</span><IconChevron size={12}/></button> : <Select aria-label="本轮使用模型" aria-describedby={`${id}-status`} value={models.modelRef} disabled={disabled}
      className="composer-model-select" triggerIcon={icon}
      options={[{ value: '', label: '自动沿用' }, ...models.options.map(option => ({ value: option.id, label: option.model,
        description: models.loading ? '正在读取模型状态…' : !models.capability?.available ? '请在模型设置中检查连接'
          : `渠道：${option.channelName || '未命名渠道'} · 仅用于本轮消息`, disabled: models.loading || !models.capability?.available }))]}
      footer={onOpenModels ? { label: '模型设置', description: '配置与测试当前模型', onActivate: () => onOpenModels(targetRef) } : undefined}
      onChange={value => models.choose(value)} />}
  </div>;
}
