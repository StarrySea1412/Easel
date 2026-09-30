import { Children, cloneElement, isValidElement, useId } from 'react';
import type { ReactNode } from 'react';

/** Shared field layout for provider, image, and notification configuration. */
export function SettingsField({ label, children, horizontal = false }: {
  label: string;
  children: ReactNode;
  horizontal?: boolean;
}) {
  const labelId = useId();
  return (
    <div className={`settings-field${horizontal ? ' settings-field-horizontal' : ''}`} role="group" aria-labelledby={labelId}>
      <span id={labelId} className="settings-field-label">{label}</span>
      <div className="settings-field-control">
        {Children.map(children, (child) => {
          if (isValidElement<{ 'aria-label'?: string; 'aria-labelledby'?: string }>(child)
            && (child.type === 'input' || child.type === 'select' || child.type === 'textarea')
            && !child.props['aria-label'] && !child.props['aria-labelledby']) {
            return cloneElement(child, { 'aria-labelledby': labelId });
          }
          return child;
        })}
      </div>
    </div>
  );
}
