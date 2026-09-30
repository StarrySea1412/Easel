/** 骨架屏：数据加载期间的占位微光条/卡片，替代"加载中…"文本，消除白屏突兀感。 */
export function Sk({ w = '100%', h = 14, r = 7, style }: {
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
