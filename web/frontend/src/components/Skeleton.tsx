/** 骨架屏：数据加载期间的占位微光条/卡片，替代"加载中…"文本，消除白屏突兀感。 */
export function Sk({ w = '100%', h = 14, r = 'var(--radius-sm)', style }: {
  w?: number | string; h?: number | string; r?: number | string; style?: React.CSSProperties;
}) {
  return <span className="sk" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

/** 卡片级骨架：标题条 + 若干内容行。 */
export function SkeletonCard({ rows = 3, title = true, style }: { rows?: number; title?: boolean; style?: React.CSSProperties }) {
  return (
    <div className="sk-card" style={style}>
      {title && <Sk w="38%" h={15} style={{ marginBottom: 14 }} />}
      {Array.from({ length: rows }).map((_, i) => (
        <Sk key={i} w={i === rows - 1 ? '62%' : '92%'} h={12} style={{ marginBottom: 10 }} />
      ))}
    </div>
  );
}

/** 生图等待态：按图片比例的微光占位（生成可能要 1-8 分钟）。 */
export function SkeletonImage({ ratio = '1 / 1', label }: { ratio?: string; label?: string }) {
  return (
    <div className="sk-image" style={{ aspectRatio: ratio }}>
      <span className="sk-image-glow" />
      {label && <span className="sk-image-label">{label}</span>}
    </div>
  );
}

/** Mirrors the account overview and recent works, without inventing data. */
export function AccountAnalysisSkeleton() {
  return <div className="ana-skeleton" role="status" aria-label="正在读取账号分析" aria-busy="true">
    <div className="ana-body" aria-hidden="true">
      <div className="ana-col">
        <Sk w="38%" h={14} /><Sk w="65%" h={10} style={{ marginTop: 10, marginBottom: 16 }} />
        <div className="ana-skeleton-metrics">{[0, 1, 2].map(i => <div key={i}><Sk w="54%" h={22} /><Sk w="36%" h={10} style={{ marginTop: 8 }} /></div>)}</div>
      </div>
      <div className="ana-col ana-skeleton-works"><Sk w="32%" h={14} />{[0, 1, 2].map(i => <div key={i}><Sk w={i === 1 ? '70%' : '88%'} h={12} /><Sk w="46%" h={9} style={{ marginTop: 8 }} /></div>)}</div>
    </div>
  </div>;
}
