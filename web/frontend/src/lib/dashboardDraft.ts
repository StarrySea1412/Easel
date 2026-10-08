import { readLocalValue } from './localPersistence';

/** Home's quick creation draft is separate from every conversation. */
export const DASHBOARD_DRAFT_SCOPE = 'dashboard-quick';

/** Clearing the visible draft is not proof that its saved copy was cleared. */
export function isDashboardDraftTextCleared(): boolean {
  const saved = readLocalValue(`easel:chat-draft:${DASHBOARD_DRAFT_SCOPE}`);
  if (!saved.ok || saved.value === null) return false;
  try {
    const value: unknown = JSON.parse(saved.value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const draft = value as Record<string, unknown>;
    return draft.version === 1 && draft.text === '' && Array.isArray(draft.attachmentNames) && draft.attachmentNames.length === 0;
  } catch { return false; }
}
