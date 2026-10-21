export interface MetricDatum { label: string; value: number; display: string }
export function numericMetric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.trim().replaceAll(',', '').match(/^(-?\d+(?:\.\d+)?)\s*(万|亿|[kKmM])?$/);
  if (!match) return null;
  return Number(match[1]) * ({ '万': 10000, '亿': 100000000, k: 1000, K: 1000, m: 1000000, M: 1000000 }[match[2]] || 1);
}
export function metricData(metrics: { label: string; value: unknown }[]): MetricDatum[] {
  return metrics.flatMap(metric => {
    const value = numericMetric(metric.value);
    return value === null ? [] : [{ label: metric.label, value, display: String(metric.value) }];
  });
}
export interface EvidenceWork {
  id: string; title: string; body?: string; transcript?: string; coverText?: string; url?: string;
  publishedAt?: string; snapshotAt?: string; period?: string; metrics?: Record<string, number | null>;
}
export function frozenEvidence(markdown: string, allowedIds: string[]): EvidenceWork[] {
  const start = markdown.indexOf('## 真实材料');
  if (start < 0) return [];
  const block = markdown.slice(start).match(/\x60{3}json\s*([\s\S]*?)\x60{3}/);
  if (!block) return [];
  try {
    const value: unknown = JSON.parse(block[1]);
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !allowedIds.includes(item.id) || typeof item.title !== 'string') return [];
      const result: EvidenceWork = {id:item.id,title:item.title};
      for (const field of ['body','transcript','coverText','url','publishedAt','snapshotAt','period'] as const) if(typeof item[field] === 'string') result[field] = item[field];
      if(item.metrics && typeof item.metrics === 'object' && !Array.isArray(item.metrics)) result.metrics = Object.fromEntries(Object.entries(item.metrics).filter(([,v])=>v===null || typeof v === 'number' && Number.isFinite(v))) as Record<string,number|null>;
      return [result];
    });
  } catch { return []; }
}
export const WORK_METRICS: Record<string, string> = { views: '观看', likes: '点赞', comments: '评论', collects: '收藏', shares: '分享' };
