import type { OfficeModelOption } from './officeControls';

export interface CodexRuntime {
  available: boolean; version?: string; auth?: string; source?: string; error?: string;
  options: (OfficeModelOption & {defaultEffort: string; isDefault: boolean})[];
  defaultModelRef?: string;
}
export interface CodexPending {
  requestId: string; method: string;
  params: { reason?: string; command?: string; cwd?: string; grantRoot?: string; permissions?: unknown;
    questions?: {id: string; header: string; question: string; isSecret?: boolean; options?: {label: string; description: string}[]}[] };
}
export interface CodexTurn {
  sessionId: string; turn_id: string; status: string; outcome: string; threadId?: string; codexTurnId?: string;
  requestedModelRef: string; actualModel?: string; requestedThinkingLevel?: string;
  thinkingStatus: 'waiting'|'available'|'unavailable'|'partial'; webSearch: string; tokenUsage?: unknown;
  items: {id: string; type: string; status?: string; command?: string; cwd?: string; aggregatedOutput?: string;
    changes?: unknown; query?: string; action?: {type?: string; url?: string; pattern?: string}; server?: string; tool?: string; result?: unknown; error?: unknown}[];
  pending: CodexPending[];
  recovery?: {status: 'adopted'|'unconfirmed'|'observing'; message?: string; checkedAt: number};
}
const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
export async function codexRequest<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${base}/api/codex/${path}`, {
    signal, cache: 'no-store', ...(body ? {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)} : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Codex 请求失败。');
  return data as T;
}

export const fetchCodexRuntime = (signal?: AbortSignal) => codexRequest<CodexRuntime>('runtime', undefined, signal);
