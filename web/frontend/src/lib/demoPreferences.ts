import { readLocalValue, writeLocalValue } from './localPersistence';

export const DEMO_DATA_PREFERENCE_KEY = 'easel:demo-data:v1';

export interface DemoDataPreference {
  enabled: boolean;
  saved: boolean;
  error: string;
}

/** An unreadable preference must not silently re-enable fictional data. */
export function readDemoDataPreference(): DemoDataPreference {
  const stored = readLocalValue(DEMO_DATA_PREFERENCE_KEY);
  if (!stored.ok) return { enabled: false, saved: false, error: '无法读取演示数据设置，已暂时关闭演示。请检查浏览器存储权限后重试。' };
  if (stored.value === null) return { enabled: true, saved: false, error: '' };
  try {
    const value: unknown = JSON.parse(stored.value);
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
      || !('enabled' in value) || typeof value.enabled !== 'boolean') throw new Error('Invalid preference');
    return { enabled: value.enabled, saved: true, error: '' };
  } catch {
    return { enabled: false, saved: false, error: '演示数据设置无法识别，已暂时关闭演示并保留原记录。重新选择可保存设置。' };
  }
}

export function saveDemoDataPreference(enabled: boolean): boolean {
  return writeLocalValue(DEMO_DATA_PREFERENCE_KEY, JSON.stringify({ version: 1, enabled }), { queueOnFailure: false });
}
