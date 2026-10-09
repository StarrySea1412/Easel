import ModelRoutePicker from '../ui/ModelRoutePicker';
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
  const locked = disabled || saving || !capability.available;
  return <section className="office-model-router" aria-labelledby={`${prefix}-title`}>
    <h4 id={`${prefix}-title`}>渠道与模型</h4>
    <p className="office-control-note">同一渠道可分配给多个 Agent / subagent；每位成员独立保存模型，渠道排序只调整显示顺序。</p>
    <p className="office-control-note">{OFFICE_MODEL_SCOPE_LABELS[capability.scope]}</p>
    {capability.available ? <>
      <ModelRoutePicker options={capability.options} selection={{ provider, modelRef: selected }} disabled={locked}
        onChange={value => { setProvider(value.provider); setSelected(value.modelRef); }} />
      {capability.currentModelRef && <p className="office-control-note">已保存：{capability.options.find(option => option.id === capability.currentModelRef)?.label || capability.currentModelRef}</p>}
      {!capability.options.some(option => option.configured) && <p className="office-control-note">还没有可分配的模型，请先配置模型渠道。</p>}
      <button type="button" className="office-button" disabled={locked || !chosen?.configured || chosen.provider !== provider || selected === capability.currentModelRef}
        onClick={() => { if (!locked && chosen?.configured && chosen.provider === provider && selected !== capability.currentModelRef) onSave(chosen.id); }}>{saving ? '保存并确认中…' : '保存模型分配'}</button>
    </> : <p className="office-control-note">{capability.reason}</p>}
    {onOpenModelSettings && <button type="button" className="office-control-link" onClick={onOpenModelSettings}>管理模型渠道 ↗</button>}
  </section>;
}
