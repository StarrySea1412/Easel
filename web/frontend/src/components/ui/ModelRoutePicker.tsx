import { useId, useState } from 'react';
import { orderedChannels, readChannelOrder } from '../../lib/channelOrder';
import ChannelOrderEditor from './ChannelOrderEditor';
import { NativeSelect as Select } from './Select';
import type { OfficeModelOption } from '../../lib/officeControls';
import './model-route-picker.css';

export interface ModelRouteSelection { provider: string; modelRef: string }

/** Both office entry points select exact references from the same configured catalog. */
export default function ModelRoutePicker({ options, selection, onChange, disabled = false }: {
  options: OfficeModelOption[];
  selection: ModelRouteSelection;
  onChange: (selection: ModelRouteSelection) => void;
  disabled?: boolean;
}) {
  const prefix = useId();
  const [order,setOrder]=useState(readChannelOrder);
  const providers = orderedChannels([...new Set(options.filter(option => option.configured).map(option => option.provider))],order);
  const names = Object.fromEntries(options.map(option => [option.provider, option.channelName || '未命名渠道']));
  return <div className="model-route-fields"><ChannelOrderEditor providers={providers} names={names} onChange={setOrder} disabled={disabled} />
    <div className="model-route-field">
      <label htmlFor={`${prefix}-provider`}>模型渠道</label>
      <Select id={`${prefix}-provider`} value={selection.provider} disabled={disabled}
        onChange={event => onChange({ provider: event.target.value, modelRef: '' })}>
        <option value="">选择已配置渠道</option>
        {providers.map(provider => <option key={provider} value={provider}>{names[provider]}</option>)}
      </Select>
    </div>
    <div className="model-route-field">
      <label htmlFor={`${prefix}-model`}>使用模型</label>
      <Select id={`${prefix}-model`} value={selection.modelRef} disabled={disabled || !selection.provider}
        onChange={event => onChange({ ...selection, modelRef: event.target.value })}>
        <option value="">选择模型</option>
        {options.filter(option => option.provider === selection.provider && option.configured).map(option =>
          <option key={option.id} value={option.id}>{option.label || option.model}</option>)}
      </Select>
    </div>
  </div>;
}
