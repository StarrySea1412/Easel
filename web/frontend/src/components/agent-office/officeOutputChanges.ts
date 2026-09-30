import type { WorkspaceOutput } from './workspaceOutputData';

export type OfficeOutputChange = 'new' | 'updated';
interface ObservedOutput {
  modifiedAt: string;
  size: number;
  change?: OfficeOutputChange;
}
export interface OfficeOutputChanges {
  initialized: boolean;
  files: ReadonlyMap<string, ObservedOutput>;
}

export function createOfficeOutputChanges(): OfficeOutputChanges {
  return { initialized: false, files: new Map() };
}

/** Accept successful snapshots only. Missing paths say nothing about deletion. */
export function observeOfficeOutputs(previous: OfficeOutputChanges, items: readonly WorkspaceOutput[]): OfficeOutputChanges {
  const files = new Map(previous.files);
  for (const item of items) {
    const known = files.get(item.path);
    const metadataChanged = known && (known.modifiedAt !== item.modifiedAt || known.size !== item.size);
    // Keep an unread new path marked new until it is acknowledged, even if its
    // metadata changes again. Retain observed paths for this mounted session.
    const change = !previous.initialized ? undefined : !known ? 'new'
      : known.change === 'new' ? 'new' : metadataChanged ? 'updated' : known.change;
    files.set(item.path, { modifiedAt: item.modifiedAt, size: item.size, change });
  }
  return { initialized: true, files };
}

export function acknowledgeOfficeOutputs(previous: OfficeOutputChanges, paths?: string | readonly string[]): OfficeOutputChanges {
  const files = new Map(previous.files);
  const selected = paths === undefined ? undefined : new Set(typeof paths === 'string' ? [paths] : paths);
  for (const [key, value] of files) {
    if (value.change && (selected === undefined || selected.has(key))) files.set(key, { ...value, change: undefined });
  }
  return { ...previous, files };
}

/** Count only rows in the current (possibly filtered) bounded list. */
export function countOfficeOutputChanges(state: OfficeOutputChanges, items: readonly WorkspaceOutput[]) {
  return items.reduce((counts, item) => {
    const change = state.files.get(item.path)?.change;
    if (change) counts[change]++;
    return counts;
  }, { new: 0, updated: 0 });
}
