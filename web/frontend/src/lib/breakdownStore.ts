/**
 * 拆解的本地持久化：草稿与历史报告。
 *
 * 复用项目既有 localPersistence（存储不可用时只上报状态，不抛错、不阻断渲染）。
 * 服务端/跨设备持久化与任务恢复属后续 P0；这里先解决「切页/刷新不丢」。
 */
import { readLocalValue, writeLocalValue } from './localPersistence';

export interface BreakdownRecord {
  id: string;
  title: string;
  at: number;
  material: string;
  report: string;
}

const DRAFT_KEY = 'easel_breakdown_draft';
const HISTORY_KEY = 'easel_breakdown_history';
export const BREAKDOWN_HISTORY_LIMIT = 20;

export function loadBreakdownDraft(): string {
  const result = readLocalValue(DRAFT_KEY);
  return result.ok && typeof result.value === 'string' ? result.value : '';
}

export function saveBreakdownDraft(input: string): boolean {
  return writeLocalValue(DRAFT_KEY, input);
}

function isRecord(value: unknown): value is BreakdownRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<BreakdownRecord>;
  return typeof item.id === 'string'
    && typeof item.title === 'string'
    && typeof item.material === 'string'
    && typeof item.report === 'string'
    && typeof item.at === 'number';
}

export function loadBreakdownHistory(): BreakdownRecord[] {
  const result = readLocalValue(HISTORY_KEY);
  if (!result.ok || !result.value) return [];
  try {
    const parsed: unknown = JSON.parse(result.value);
    return Array.isArray(parsed) ? parsed.filter(isRecord).slice(0, BREAKDOWN_HISTORY_LIMIT) : [];
  } catch { return []; }
}

function writeHistory(items: BreakdownRecord[]): BreakdownRecord[] {
  const capped = items.slice(0, BREAKDOWN_HISTORY_LIMIT);
  writeLocalValue(HISTORY_KEY, JSON.stringify(capped));
  return capped;
}

export function newBreakdownRecord(material: string, report: string, title: string): BreakdownRecord {
  return { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, title, at: Date.now(), material, report };
}

/** 新报告置顶；同内容报告去重（重新生成同一篇时替换旧记录）。 */
export function addBreakdownRecord(items: BreakdownRecord[], record: BreakdownRecord): BreakdownRecord[] {
  return writeHistory([record, ...items.filter(item => item.id !== record.id && item.report !== record.report)]);
}

export function removeBreakdownRecord(items: BreakdownRecord[], id: string): BreakdownRecord[] {
  return writeHistory(items.filter(item => item.id !== id));
}
