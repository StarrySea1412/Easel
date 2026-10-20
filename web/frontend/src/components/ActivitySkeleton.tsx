import '../styles/activity-skeleton.css';

export default function ActivitySkeleton({ label = '正在读取运行记录', rows = 4 }: { label?: string; rows?: number }) {
  return <div className="activity-skeleton" role="status" aria-label={label} aria-busy="true">
    <div className="activity-skeleton-metrics" aria-hidden="true">{[0, 1, 2].map(key => <span key={key} />)}</div>
    <div className="activity-skeleton-lines" aria-hidden="true">{Array.from({length: rows}, (_, key) => <span key={key} />)}</div>
  </div>;
}
