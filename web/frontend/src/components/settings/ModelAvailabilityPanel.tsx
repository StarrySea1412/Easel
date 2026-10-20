import { useState } from 'react';
import Select from '../ui/Select';
import ModelHealthPanel from './ModelHealthPanel';
import { DEFAULT_MODEL_CHECK, type ModelAvailabilityController, type ModelCheckDefaults, type ModelCheckState } from '../../hooks/useModelAvailability';
import './model-health.css';

export function ModelCheckFeedback({ check }: { check?: ModelCheckState }) {
  if (!check) return null;
  const { result, error, busy, mode } = check;
  const label = mode === 'vision' ? '图片' : '文本';
  return <div className={`model-check-feedback${error || result?.state === 'failed' ? ' bad' : ''}`} role="status" aria-live="polite">
    <strong>{busy ? `正在检测${label}可用性…` : error ? '检测未完成' : `${label}检测${result?.state === 'success' ? '通过' : '未通过'}`}</strong>
    {!busy && <span>{error || result?.detail}</span>}
    {result?.testedAt && <small>{new Date(result.testedAt * 1000).toLocaleTimeString('zh-CN')} · 本次检测结果</small>}
  </div>;
}

export default function ModelAvailabilityPanel({ controller, models, targetModelRef, saving }: {
  controller: ModelAvailabilityController;
  models: { ref: string; identity?: string; label: string; reason?: string; needsSave?: boolean; onCheck?: () => void }[];
  saving?: boolean;
  targetModelRef?: string;
}) {
  const [draft, setDraft] = useState<ModelCheckDefaults>(controller.defaults);
  const [advanced, setAdvanced] = useState(false);
  return <section className="model-availability-panel">
    <p className="hint">无需配置检测参数，点击即可测试。默认：{controller.defaults.mode === 'vision' ? '图片识别（自动生成测试图）' : '文本响应'}。手动检测会发送模型请求，供应商可能计费。</p>
    <div className="model-availability-list">{models.filter(model => !targetModelRef || model.ref === targetModelRef).map((model, index) => {
      const check = controller.checks[model.identity || model.ref];
      return <div className="model-availability-row" key={`${model.identity || model.ref}:${index}`}><div><strong>{model.label}</strong><small>{model.ref}</small>{model.reason && <small>{model.reason}</small>}<ModelCheckFeedback check={check}/></div>
        <button type="button" className="btn btn-sm" disabled={Boolean(model.reason) || check?.busy || saving} title={model.reason} onClick={() => model.onCheck ? model.onCheck() : void controller.run(model.ref, model.identity)}>{check?.busy ? '测试中…' : '测试'}</button></div>;
    })}</div>
    {!models.length && <p className="hint">先添加并保存供应商，即可使用内置参数检测。</p>}
    <details className="model-check-defaults"><summary>默认检测设置 <small>可选；不修改也能直接检测</small></summary>
      <div className="model-health-fields"><label>检测类型<Select aria-label="默认检测类型" value={draft.mode} options={[{value:'text',label:'文本响应'}, {value:'vision',label:'图片识别'}]} onChange={mode => setDraft(old => ({...old,mode:mode as ModelCheckDefaults['mode']}))}/></label>
      {draft.mode === 'text' ? <label>文本提示词<textarea aria-label="默认检测提示词" rows={2} maxLength={1000} value={draft.prompt} onChange={event => setDraft(old => ({...old,prompt:event.target.value}))}/></label> : <p className="hint">自动生成随机四格图片并核对答案，无需准备图片或提示词。</p>}</div>
      <div className="model-health-actions"><button type="button" className="btn btn-sm" onClick={() => controller.saveDefaults(draft)}>保存默认设置</button><button type="button" className="btn btn-sm" onClick={() => { setDraft(DEFAULT_MODEL_CHECK); controller.saveDefaults(DEFAULT_MODEL_CHECK); }}>恢复内置默认</button></div>
      <p className="hint">只影响此浏览器的一键检测，自动检测保持原设置。</p>{controller.storageNote && <p role="status">{controller.storageNote}</p>}
    </details>
    <details className="model-check-advanced" onToggle={event => setAdvanced(event.currentTarget.open)}><summary>更多检测与自动计划</summary>{advanced && <ModelHealthPanel targetModelRef={targetModelRef}/>}</details>
  </section>;
}
