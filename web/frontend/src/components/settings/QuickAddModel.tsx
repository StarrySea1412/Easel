import { useEffect, useRef, useState } from 'react';
import Select from '../ui/Select';
import { addModelChannel, discoverModels } from '../../lib/api';
import type { ModelPreset, ModelSaveResponse } from '../../lib/api';

export default function QuickAddModel({ presets, disabled, onSaved, onSaving }: { presets: ModelPreset[]; disabled: boolean; onSaved: (value: ModelSaveResponse) => void; onSaving?: (value: boolean) => void }) {
  const [name, setName] = useState(''), [base, setBase] = useState(''), [key, setKey] = useState(''), [model, setModel] = useState('');
  const [protocol, setProtocol] = useState('openai'), [preset, setPreset] = useState('');
  const [models, setModels] = useState<string[]>([]), [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'' | 'discover' | 'save'>(''), [makeDefault, setMakeDefault] = useState(true);
  const pending = useRef(false), version = useRef(0), alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function resetDiscovery() { version.current++; setModels([]); setModel(''); setMessage(''); }
  async function discover() {
    if (pending.current || disabled || !base.trim() || !key.trim()) return;
    pending.current = true; setBusy('discover'); setMessage(''); const request = ++version.current;
    try {
      const result = await discoverModels({ channel: 'chat', baseUrl: base.trim(), apiKey: key.trim(), protocol });
      if (!alive.current || request !== version.current) return;
      setModels(result.ok ? result.models : []); setMessage(result.message);
      if (result.ok && result.models.length === 1) setModel(result.models[0]);
    } catch (cause) { if (alive.current && request === version.current) setMessage(cause instanceof Error ? cause.message : '获取模型失败，可手动填写模型 ID。'); }
    finally { pending.current = false; if (alive.current) setBusy(''); }
  }
  async function save() {
    if (pending.current || disabled) return;
    pending.current = true; setBusy('save'); setMessage('');
    onSaving?.(true);
    try {
      const result = await addModelChannel({ name: name.trim(), baseUrl: base.trim(), apiKey: key.trim(), model: model.trim(), protocol, makeDefault });
      if (!alive.current) return;
      onSaved(result); setKey(''); setModel(''); setModels([]); setMessage(makeDefault ? '已添加并设为默认模型。' : '已添加渠道，可在默认模型列表中选择。');
    } catch (cause) { if (alive.current) setMessage(cause instanceof Error ? cause.message : '添加失败，请检查配置。'); }
    finally { pending.current = false; if (alive.current) { setBusy(''); onSaving?.(false); } }
  }
  return <form className="quick-add-model" onSubmit={event => { event.preventDefault(); void save(); }}>
    <h3>快速添加渠道</h3><p className="hint">选择服务商、粘贴 Key，再选模型即可。自定义服务只需填写地址。</p>
    <fieldset disabled={disabled || !!busy}>
      <div className="quick-add-grid">
        <label>服务商<Select aria-label="快速添加服务商" value={preset} disabled={disabled || !!busy}
          options={[{ value: '', label: '自定义服务' }, ...presets.filter(item => ['openai', 'anthropic', 'openai-responses'].includes(item.protocol)).map(item => ({ value: item.id, label: item.name }))]}
          onChange={value => { resetDiscovery(); setPreset(value); const item = presets.find(item => item.id === value); if (item) { setBase(item.baseUrl); setProtocol(item.protocol); setName(item.name); } }}/></label>
        <label>渠道名称（可选）<input aria-label="快速添加渠道名称" value={name} maxLength={80} placeholder="例如：我的中转" onChange={e => setName(e.target.value)}/></label>
        <label>服务地址<input aria-label="快速添加服务地址" required type="url" value={base} placeholder="https://服务地址/v1" onChange={e => { resetDiscovery(); setBase(e.target.value); setPreset(''); }}/></label>
        <label>API Key<input aria-label="快速添加 API Key" required type="password" autoComplete="off" value={key} placeholder="粘贴服务商提供的 Key" onChange={e => { resetDiscovery(); setKey(e.target.value); }}/></label>
      </div>
      <div className="quick-add-model-row">
        <label>模型 ID<input aria-label="快速添加模型 ID" required value={model} maxLength={120} placeholder="获取后选择，或直接填写" onChange={e => setModel(e.target.value)}/></label>
        <button type="button" className="btn btn-sm" disabled={disabled || !!busy || !base.trim() || !key.trim()} onClick={() => void discover()}>{busy === 'discover' ? '获取中…' : '获取模型列表'}</button>
      </div>
      {models.length > 0 && <Select aria-label="快速添加可用模型" value={models.includes(model) ? model : ''} disabled={disabled || !!busy} placeholder="选择一个模型" options={models.map(value => ({ value, label: value }))} onChange={setModel}/>}
      <details><summary>协议设置</summary><Select aria-label="快速添加协议" value={protocol} disabled={disabled || !!busy} options={[{ value: 'openai', label: 'OpenAI Chat Completions' }, { value: 'openai-responses', label: 'OpenAI Responses（Codex 渠道）' }, { value: 'anthropic', label: 'Anthropic Messages' }]} onChange={value => { resetDiscovery(); setProtocol(value); }}/></details>
      <label className="quick-add-default"><input type="checkbox" checked={makeDefault} onChange={e => setMakeDefault(e.target.checked)}/>添加后设为默认模型</label>
      <button type="submit" className="btn btn-primary" disabled={disabled || !!busy || !base.trim() || !key.trim() || !model.trim()}>{busy === 'save' ? '保存中…' : makeDefault ? '添加并使用' : '添加渠道'}</button>
    </fieldset>
    {message && <p role="status" className="hint">{message}</p>}
  </form>;
}
