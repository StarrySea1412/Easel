import type { WorkspaceOutput } from './workspaceOutputData';

export type OfficeOutputSort = 'recent' | 'name' | 'size';
const names = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/** Search only metadata in the bounded snapshot, without mutating its order. */
export function selectOfficeOutputs(items: readonly WorkspaceOutput[], { query, kind, sort }: { query: string; kind: string; sort: OfficeOutputSort }): WorkspaceOutput[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const selected = items.filter(item => {
    const text = `${item.name}\n${item.path}`.toLocaleLowerCase();
    return (kind === 'all' || item.kind === kind) && terms.every(term => text.includes(term));
  });
  const byName = (a: WorkspaceOutput, b: WorkspaceOutput) => names.compare(a.name, b.name) || names.compare(a.path, b.path);
  return selected.sort((a, b) => {
    if (sort === 'name') return byName(a, b);
    if (sort === 'size') return b.size - a.size || byName(a, b);
    const aTime = Date.parse(a.modifiedAt), bTime = Date.parse(b.modifiedAt);
    // Undated demonstration examples retain their authored order.
    if (!Number.isFinite(aTime) && !Number.isFinite(bTime)) return 0;
    if (!Number.isFinite(aTime)) return 1;
    if (!Number.isFinite(bTime)) return -1;
    return bTime - aTime || byName(a, b);
  });
}
