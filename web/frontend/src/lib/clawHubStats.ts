import type { ClawHubStats } from './api';

/** Public counters only — the registry exposes no GitHub-style issue tracker. */
const LABELS: Record<keyof ClawHubStats, string> = { downloads: '下载', installs: '安装', stars: '星标', versions: '版本', comments: '评论' };
const ORDER: (keyof ClawHubStats)[] = ['downloads', 'installs', 'stars', 'versions', 'comments'];

export function formatClawHubCount(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return value >= 10000 ? `${Number((value / 10000).toFixed(1))}万` : value.toLocaleString('zh-CN');
}

export function clawHubStatItems(stats: ClawHubStats | null | undefined, keys: (keyof ClawHubStats)[] = ORDER) {
  if (!stats) return [];
  return keys.flatMap(key => {
    const text = formatClawHubCount(stats[key]);
    return text === null ? [] : [{ key, label: LABELS[key], text }];
  });
}

export function formatClawHubStatLine(stats: ClawHubStats | null | undefined, keys: (keyof ClawHubStats)[] = ORDER): string {
  return clawHubStatItems(stats, keys).map(item => `${item.label} ${item.text}`).join(' · ');
}
