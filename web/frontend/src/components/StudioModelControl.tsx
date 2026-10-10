import { useState } from 'react';
import ProviderIcon from './ProviderIcon';
import { IconSpark } from './icons';

export default function StudioModelControl({ model, service, provider = '', baseUrl = '', disabled, saving, error, onSave, onSettings }: {
  model: string; service: string; disabled?: boolean; saving?: boolean; error?: string;
  provider?: string; baseUrl?: string;
  onSave?: (model: string) => Promise<boolean>; onSettings: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);
  return <div className="studio-model-control">
    <div className="studio-model-current"><span className="studio-model-symbol" aria-hidden="true"><ProviderIcon row={{ model, name: provider, baseUrl }} fallback={IconSpark} /></span><div><span>{service}</span><strong>{model || '尚未设置模型'}</strong></div>
      {onSave ? <button type="button" className="link-btn" disabled={disabled || saving} onClick={() => { setDraft(model); setEditing(!editing); setSaved(false); }}>{editing ? '收起' : '自定义模型'}</button>
        : <button type="button" className="link-btn" onClick={onSettings}>设置模型 ↗</button>}
    </div>
    {editing && onSave && <form className="studio-model-editor" onSubmit={async event => { event.preventDefault(); if (await onSave(draft)) { setEditing(false); setSaved(true); } }}>
      <label htmlFor="studio-image-model">模型名称<input id="studio-image-model" autoFocus value={draft} maxLength={200} disabled={disabled || saving} placeholder="填写服务商提供的模型 ID" onChange={event => setDraft(event.target.value)} /></label>
      <button type="submit" className="btn" disabled={disabled || saving || !draft.trim()}>{saving ? '保存中…' : '保存模型'}</button>
      <p>使用已连接的生图服务；模型名称需由该服务支持。<button type="button" className="link-btn" onClick={onSettings}>配置服务 ↗</button></p>
    </form>}
    {saved && <p className="studio-model-note" role="status">模型已保存；下次生成将使用 {model}。</p>}
    {error && <p className="image-error" role="alert">{error}</p>}
  </div>;
}
