import { IconCheck } from '../icons';
import '../../styles/steps.css';

export interface StepItem {
  key: string;
  label: string;
  description?: string;
  completed?: boolean;
  disabled?: boolean;
}

/** Controlled navigation. Completion is explicit, never inferred from visiting a later step. */
export default function Steps({ items, current, onChange, label }: {
  items: StepItem[]; current: string; onChange: (key: string) => void; label: string;
}) {
  return <nav className="workflow-steps" aria-label={label}>
    <ol>{items.map((item, index) => <li key={item.key} className={item.completed ? 'is-complete' : ''}>
      <button type="button" aria-current={item.key === current ? 'step' : undefined} disabled={item.disabled}
        onClick={() => onChange(item.key)} onKeyDown={event => {
          const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (!direction && !['Home', 'End'].includes(event.key)) return;
          const available = items.map((item, i) => !item.disabled ? i : -1).filter(i => i >= 0);
          const next = event.key === 'Home' ? available[0] : event.key === 'End' ? available.at(-1)
            : available[(available.indexOf(index) + direction + available.length) % available.length];
          if (next == null) return;
          event.preventDefault();
          event.currentTarget.closest('ol')?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
        }}>
        <span className="workflow-step-icon" aria-hidden="true">{item.completed && item.key !== current ? <IconCheck size={14}/> : index + 1}</span>
        <span className="workflow-step-copy"><span className="workflow-step-title">{item.label}</span>{item.description && <span className="workflow-step-description">{item.description}</span>}</span>
      </button>
      {index < items.length - 1 && <span className="workflow-step-connector" aria-hidden="true"/>}
    </li>)}</ol>
  </nav>;
}
