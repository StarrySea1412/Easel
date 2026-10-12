import { useEffect, useRef, useState } from 'react';
import Select from '../ui/Select';
import { fetchModelReasoning, saveModelReasoning } from '../../lib/api';
import type { ModelReasoningConfiguration } from '../../lib/api';

const declaration = (value: boolean | null) => value === null ? 'unknown' : value ? 'yes' : 'no';

export default function ModelReasoningSettings({ disabled, revision, onSaving }: {
  disabled: boolean; revision: unknown; onSaving: (value: boolean) => void;
}) {
  const [config, setConfig] = useState<ModelReasoningConfiguration | null>(null);
  const [selected, setSelected] = useState(''), [value, setValue] = useState('unknown');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [reload, setReload] = useState(0);
  const pending = useRef(false), alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setConfig(null); setMessage('');
    fetchModelReasoning().then(result => {
      if (!active) return;
      setConfig(result); setSelected(''); setValue('unknown');
    }).catch(cause => { if (active) setMessage(cause instanceof Error ? cause.message : '读取推理能力配置失败。'); });
    return () => { active = false; };
  }, [revision, reload]);
  const entry = config?.options.find(option => option.id === selected);
  const dirty = Boolean(entry && value !== declaration(entry.reasoning));
  async function save() {
    if (pending.current || disabled || !config || !dirty) return;
    pending.current = true; setBusy(true); setMessage(''); onSaving(true);
    try {
      const result = await saveModelReasoning(selected, value === 'unknown' ? null : value === 'yes', config.fingerprint);
      if (!alive.current) return;
      setConfig(result); setMessage(result.note || '已保存推理能力声明。');
      window.dispatchEvent(new window.Event('easel:model-capabilities-changed'));
    } catch (cause) { if (alive.current) setMessage(cause instanceof Error ? cause.message : '保存失败，请刷新后重试。'); }
    finally { pending.current = false; onSaving(false); if (alive.current) setBusy(false); }
  }
  return <details className="model-settings-details model-reasoning-settings">
    <summary>模型推理能力</summary>
    <p className="hint">服务支持推理但强度不可选时，检查该模型的能力声明。仅在服务明确支持时启用；思考内容是否返回仍取决于服务，强度以网关提供的档位为准。</p>
    <div className="quick-add-grid">
      <label>已配置模型<Select aria-label="推理能力模型" value={selected} disabled={disabled || busy || !config}
        placeholder="选择需要设置的模型" options={config?.options.map(option => ({ value: option.id, label: option.label })) || []}
        onChange={id => { setSelected(id); setValue(declaration(config?.options.find(option => option.id === id)?.reasoning ?? null)); setMessage(''); }}/></label>
      <label>推理声明<Select aria-label="模型推理声明" value={value} disabled={disabled || busy || !entry}
        options={[{ value: 'unknown', label: '未声明（由网关决定）' }, { value: 'yes', label: '支持推理' }, { value: 'no', label: '不支持推理' }]}
        onChange={setValue}/></label>
    </div>
    <div className="model-picker-actions">
      <button type="button" className="btn btn-sm btn-primary" disabled={disabled || busy || !dirty} onClick={() => void save()}>{busy ? '保存中…' : '保存推理声明'}</button>
      <button type="button" className="btn btn-sm" disabled={disabled || busy} onClick={() => setReload(v => v + 1)}>刷新配置</button>
    </div>
    {message && <p role="status" className="hint">{message}</p>}
  </details>;
}
