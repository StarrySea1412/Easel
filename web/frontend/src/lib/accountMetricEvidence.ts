import type { AccountAnalytics } from './api';

export function verifiedDouyinMetrics(source: AccountAnalytics['metrics_source']): boolean {
  if (source?.schema !== 'douyin-account-overview-v2' || source.section !== '账号总览' || source.period !== 'last_7_days' || source.url !== 'https://creator.douyin.com/creator-micro/home') return false;
  const validDate = (value: string | undefined) => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : NaN;
  };
  return validDate(source.to) - validDate(source.from) === 6 * 86400000;
}

/** Keep identity and works; obsolete course counters must never become account metrics. */
export function sanitizeAccountMetrics(data: AccountAnalytics): AccountAnalytics {
  if (data.platform !== 'douyin' || verifiedDouyinMetrics(data.metrics_source) || (!data.metrics?.length && !data.analysis?.metrics?.length)) return data;
  return { ...data, metrics: [], metricsNeedsRefresh: true, analysis: undefined };
}
