import { readLocalValue, writeLocalValue } from './localPersistence';

export const TREND_SOURCES = [
  { key: 'weibo', label: '微博' }, { key: 'douyin', label: '抖音' },
  { key: 'zhihu', label: '知乎' }, { key: 'bilibili', label: 'B站' },
  { key: 'baidu', label: '百度' }, { key: 'toutiao', label: '头条' },
  { key: 'ithome', label: 'IT之家' }, { key: 'v2ex', label: 'V2EX' },
  { key: 'hackernews', label: 'Hacker News' },
] as const;
export const DEFAULT_TREND_SOURCES = ['weibo', 'douyin', 'zhihu'];
export const TREND_PREFERENCES_KEY = 'easel:trends:sources:v1';
const allowed = new Set<string>(TREND_SOURCES.map(source => source.key));

export function readTrendPreferences(): { sources: string[]; saved: boolean; error: string } {
  const stored = readLocalValue(TREND_PREFERENCES_KEY);
  if (!stored.ok) return { sources: [...DEFAULT_TREND_SOURCES], saved: false, error: '无法读取已保存的热榜，当前使用默认选择。' };
  if (stored.value === null) return { sources: [...DEFAULT_TREND_SOURCES], saved: false, error: '' };
  try {
    const value: unknown = JSON.parse(stored.value);
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
      || !('sources' in value) || !Array.isArray(value.sources) || !value.sources.every(item => typeof item === 'string')) throw new Error();
    const sources = [...new Set<string>(value.sources.filter(item => allowed.has(item)))];
    if (value.sources.length && !sources.length) throw new Error();
    return { sources, saved: true, error: '' };
  } catch {
    return { sources: [...DEFAULT_TREND_SOURCES], saved: false, error: '已保存的热榜配置无法识别，原记录已保留；可重新选择后保存。' };
  }
}

export function saveTrendPreferences(sources: string[]): boolean {
  if (sources.some(source => !allowed.has(source))) return false;
  return writeLocalValue(TREND_PREFERENCES_KEY, JSON.stringify({ version: 1, sources: [...new Set(sources)] }), { queueOnFailure: false });
}
