import { IconInfo } from './icons';
import '../styles/inline-info.css';

export default function InlineInfo({ label, children }: { label: string; children: React.ReactNode }) {
  return <details className="inline-info"><summary aria-label={label} title={label}><IconInfo size={13}/></summary>
    <div className="inline-info-content" role="note">{children}</div>
  </details>;
}
