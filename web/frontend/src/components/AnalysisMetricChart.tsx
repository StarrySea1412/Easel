import { useEffect, useRef, useState } from 'react';
import type { MetricDatum } from '../lib/analysisVisuals';
import '../styles/analysis-visuals.css';

export default function AnalysisMetricChart({ data, title = '指标对比', caption }: { data: MetricDatum[]; title?: string; caption?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const signature = JSON.stringify(data);
  useEffect(() => {
    const values: MetricDatum[] = JSON.parse(signature);
    if (!host.current || !values.length) return;
    let alive = true;
    let starting = false;
    let chart: import('@antv/g2').Chart | undefined;
    setFailed(false);
    const draw = () => {
      if (starting || chart || !alive || !host.current || host.current.clientWidth < 1) return;
      starting = true;
      void import('@antv/g2').then(async ({ Chart }) => {
      if (!alive || !host.current) return;
      chart = new Chart({ container: host.current, autoFit: true, height: Math.max(175, values.length * 32 + 40) });
      const color = getComputedStyle(host.current).getPropertyValue('--text-secondary').trim() || '#64748b';
      chart.options({ type: 'interval', data: values, encode: { x: 'label', y: 'value' }, coordinate: { transform: [{ type: 'transpose' }] },
        paddingRight: 50, paddingLeft: 12, animate: false,
        style: { fill: '#588b89', radiusTopLeft: 4, radiusTopRight: 4, maxWidth: 18 },
        axis: { x: { title: false, labelFill: color, line: false, tick: false }, y: { title: false, labelFill: color, grid: true, gridStrokeOpacity: .12 } },
        labels: [{ text: 'display', position: 'right', style: { fill: color, fontSize: 11, dx: 5 } }],
        interaction: { tooltip: { shared: false } }, tooltip: { title: 'label', items: [{ channel: 'y', name: '数值' }] },
      });
      await chart.render();
      }).catch(() => { if (alive) setFailed(true); }).finally(() => { starting = false; });
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(draw);
    observer?.observe(host.current);
    draw();
    return () => { alive = false; observer?.disconnect(); chart?.destroy(); };
  }, [signature]);
  if (!data.length) return null;
  return <figure className="analysis-chart" aria-label={title}>
    <figcaption><strong>{title}</strong>{caption && <span>{caption}</span>}</figcaption>
    <div className="analysis-chart-canvas" ref={host} aria-hidden="true" style={{ minHeight: Math.max(175, data.length * 32 + 40) }} />
    {failed && <p className="analysis-chart-fallback" role="status">图表暂不可用，可查看指标明细</p>}
    <span className="sr-only">{data.map(item => item.label + '：' + item.display).join('；')}</span>
  </figure>;
}
