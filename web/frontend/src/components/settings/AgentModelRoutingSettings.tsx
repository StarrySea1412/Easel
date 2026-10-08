import { NativeSelect as Select } from '../ui/Select';
import { useId, useState } from 'react';
import { OFFICE_MODEL_SCOPE_LABELS, type OfficeModelCapability } from '../../lib/officeControls';
import '../agent-office/office-agent-controls.css';

export interface AgentModelRoutingSettingsProps {
  capability: OfficeModelCapability;
  disabled?: boolean;
  saving?: boolean;
  onSave: (modelRef: string) => void;
  onOpenModelSettings?: () => void;
}

/** Select only exact model references supplied by the backend; provider labels
 * and appearance cards never manufacture a route or override credentials.
 */
export default function AgentModelRoutingSettings(props: AgentModelRoutingSettingsProps) {
  return <ModelRoutingForm key={JSON.stringify([props.capability.currentModelRef, props.capability.options])} {...props} />;
}

function ModelRoutingForm({ capability, disabled = false, saving = false, onSave, onOpenModelSettings }: AgentModelRoutingSettingsProps) {
  const prefix = useId();
  const [selected, setSelected] = useState(capability.currentModelRef || '');
  const chosen = capability.options.find(option => option.id === selected);
  const [provider, setProvider] = useState(chosen?.provider || '');
  const providers = [...new Set(capability.options.filter(option => option.configured).map(option => option.provider))];
  const locked = disabled || saving || !capability.available;
  return <section className="office-model-router" aria-labelledby={`${prefix}-title`}>
    <h4 id={`${prefix}-title`}>渠道与模型</h4>
    <p className="office-control-note">{OFFICE_MODEL_SCOPE_LABELS[capability.scope]}</p>
    {capability.available ? <>
      <label htmlFor={`${prefix}-provider`}>模型渠道</label>
      <Select id={`${prefix}-provider`} value={provider} disabled={locked} onChange={event => { setProvider(event.target.value); setSelected(''); }}>
        <option value="">选择已配置渠道</option>
        {providers.map(value => <option key={value} value={value}>{value}</option>)}
      </Select>
      <label htmlFor={`${prefix}-model`}>使用模型</label>
      <Select id={`${prefix}-model`} value={selected} disabled={locked || !provider} onChange={event => setSelected(event.target.value)}>
        <option value="">选择模型</option>
        {capability.options.filter(option => option.provider === provider && option.configured).map(option => <option key={option.id} value={option.id}>
          {option.label || option.model}
        </option>)}
      </Select>
      {capability.currentModelRef && <p className="office-control-note">已保存：{capability.options.find(option => option.id === capability.currentModelRef)?.label || capability.currentModelRef}</p>}
      {!capability.options.some(option => option.configured) && <p className="office-control-note">还没有可分配的模型，请先配置模型渠道。</p>}
      <button type="button" className="office-button" disabled={locked || !chosen?.configured || chosen.provider !== provider || selected === capability.currentModelRef}
        onClick={() => { if (!locked && chosen?.configured && chosen.provider === provider && selected !== capability.currentModelRef) onSave(chosen.id); }}>{saving ? '保存并确认中…' : '保存模型分配'}</button>
    </> : <p className="office-control-note">{capability.reason}</p>}
    {onOpenModelSettings && <button type="button" className="office-control-link" onClick={onOpenModelSettings}>管理模型渠道 ↗</button>}
  </section>;
}
