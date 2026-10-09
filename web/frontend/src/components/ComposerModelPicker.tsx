import Select from './ui/Select';
import type { useComposerModels } from '../hooks/useComposerModels';
import { modelHealthLabel } from '../lib/modelHealth';

export default function ComposerModelPicker({ models, disabled = false }: { models: ReturnType<typeof useComposerModels>; disabled?: boolean }) {
  const health = models.health?.results.find(result => result.modelRef === models.modelRef && result.mode === 'text');
  return <div className="composer-model-picker">
    <Select aria-label="本轮使用模型" value={models.modelRef} disabled={disabled}
      title="仅用于本轮消息；所选模型不可用时保留草稿" className="composer-model-select"
      options={[{ value: '', label: '会话配置', description: '不指定本轮模型' }, ...models.options.map(option => ({ value: option.id, label: `${option.provider} / ${option.label || option.model}`, description: option.id, disabled: models.loading || !models.capability?.available }))]} onChange={models.choose} />
    {models.modelRef && <span className="composer-model-health" title={health?.detail || '配置登记不代表调用已经验证'}>{modelHealthLabel(health)}</span>}
    {!models.ready && <button type="button" className="link-btn" disabled={disabled || models.loading} onClick={models.refresh}>{models.loading ? '读取中' : '刷新模型'}</button>}
  </div>;
}
