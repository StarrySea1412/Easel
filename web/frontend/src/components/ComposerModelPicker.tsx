import Select from './ui/Select';
import type { useComposerModels } from '../hooks/useComposerModels';
import { modelHealthLabel } from '../lib/modelHealth';
import { IconCheck, IconInfo } from './icons';

export default function ComposerModelPicker({ models, disabled = false, onOpenModels }: {
  models: ReturnType<typeof useComposerModels>; disabled?: boolean; onOpenModels?: () => void;
}) {
  const health = models.health?.results.find(result => result.modelRef === models.modelRef && result.mode === 'text');
  const healthLabel = modelHealthLabel(health);
  const healthHint = `${healthLabel} · ${health?.detail || '配置登记不代表调用已经验证；可在模型设置中检测。'}`;
  const unavailable = !models.loading && (Boolean(models.error) || !models.capability?.available);
  return <div className="composer-model-picker">
    <Select aria-label="本轮使用模型" value={models.modelRef} disabled={disabled}
      title="仅用于本轮消息；所选模型不可用时保留草稿" className="composer-model-select"
      options={[{ value: '', label: '沿用会话模型', description: '未单独指定时使用设置中的默认模型' }, ...models.options.map(option => ({ value: option.id, label: option.model,
        description: models.loading ? '正在读取模型状态…' : !models.capability?.available ? '暂不可选，请查看输入框旁的原因'
          : `渠道：${option.provider} · 仅用于本轮消息`, disabled: models.loading || !models.capability?.available })),
        ...(onOpenModels ? [{value:'__manage_models__',label:'添加或设置模型…',description:'打开模型设置，选择、添加或导入'}] : [])]}
      onChange={value => value === '__manage_models__' ? onOpenModels?.() : models.choose(value)} />
    {models.modelRef && <span className={`composer-model-health ${health?.state || 'unverified'}`} role="img" tabIndex={0} aria-label={`模型测活：${healthHint}`} title={healthHint} data-tooltip={healthHint}>{health?.state === 'success' && !health.stale ? <IconCheck size={13} /> : <IconInfo size={13} />}<span className="composer-model-health-label">{healthLabel}</span></span>}
    {!unavailable && !models.ready && <button type="button" className="link-btn" disabled={disabled || models.loading} onClick={models.refresh}>{models.loading ? '读取中' : '刷新模型'}</button>}
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
