import type { ComponentType, ReactNode } from 'react';

interface DashboardCardProps {
  Icon: ComponentType<{ size?: number }>;
  title: string;
  ariaLabel?: string;
  variant: 'summary' | 'studio' | 'wide';
  actions?: ReactNode;
  children: ReactNode;
}

const VARIANT_CLASS = {
  summary: 'dash-summary',
  studio: 'dash-studio',
  wide: 'dash-card-wide',
};

/** Shared dashboard frame; page-specific data and actions stay in the caller. */
export default function DashboardCard({ Icon, title, ariaLabel, variant, actions, children }: DashboardCardProps) {
  return (
    <section className={`card dash-card ${VARIANT_CLASS[variant]}`} aria-label={ariaLabel || title}>
      <div className="dash-card-head">
        <span><Icon size={16} /> {title}</span>
        {actions}
      </div>
      {variant === 'summary' ? <div className="dash-card-content">{children}</div> : children}
    </section>
  );
}
