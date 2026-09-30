import type { ComponentType } from 'react';

interface DashboardEmptyProps {
  Icon: ComponentType<{ size?: number }>;
  title: string;
  description: string;
  action: string;
  onAction: () => void;
}

/** Consistent empty and retry states for dashboard sections. */
export default function DashboardEmpty({ Icon, title, description, action, onAction }: DashboardEmptyProps) {
  return (
    <div className="dash-empty-state">
      <span className="dash-empty-icon" aria-hidden="true"><Icon size={22} /></span>
      <strong>{title}</strong>
      <p>{description}</p>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onAction}>{action} →</button>
    </div>
  );
}
