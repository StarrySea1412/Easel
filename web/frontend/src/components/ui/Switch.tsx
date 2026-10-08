import type { AriaAttributes } from 'react';
import './switch.css';

export interface SwitchProps extends Pick<AriaAttributes, 'aria-label' | 'aria-labelledby' | 'aria-describedby'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
  disabled?: boolean;
}

/** A controlled switch; native button semantics provide Space/Enter activation. */
export default function Switch({ checked, onChange, disabled = false, ...attributes }: SwitchProps) {
  return <button {...attributes} type="button" role="switch" aria-checked={checked}
    className="easel-switch" disabled={disabled} onClick={() => onChange(!checked)}>
    <span className="easel-switch-track" aria-hidden="true"><span className="easel-switch-thumb" /></span>
  </button>;
}
