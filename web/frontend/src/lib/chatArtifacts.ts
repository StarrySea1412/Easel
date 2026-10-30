import type { PublishDraft } from './store';
export interface PreparedCreationDraft { id: string; sessionId: string; turnId: string; createdAt: number; state: 'prepared'; draft: PublishDraft }

async function creationRequest(session: string, ident: string, body?: unknown) {
  const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  const response = await fetch(`${base}/api/chat/artifacts/${encodeURIComponent(session)}/drafts/${encodeURIComponent(ident)}${body ? '/accept' : ''}`, {
    cache: 'no-store', ...(body ? {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)} : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '草稿核对失败，请重试');
  return value;
}
export async function checkedCreationDraft(session: string, ident: string): Promise<PreparedCreationDraft> {
  const value = await creationRequest(session, ident);
  const [draft] = decodeCreationDrafts([value], session);
  if (!draft || draft.id !== ident) throw new Error('草稿来源不一致，请刷新');
  return draft;
}
export async function acceptCreationDraft(session: string, ident: string, requestId: string, platform: string, payload: {title:string;body:string;media:string[];tags?:string;persona?:string}, accountIdentity: string): Promise<string> {
  const value = await creationRequest(session, ident, {requestId, platform, payload, accountIdentity});
  if (value.sessionId !== session || value.preparationId !== ident || value.platform !== platform || !/^[a-f0-9]{32}$/.test(value.id)) throw new Error('确认稿来源不一致，请重新确认');
  return value.id;
}
export function decodeCreationDrafts(value: unknown, session: string): PreparedCreationDraft[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PreparedCreationDraft => {
    if (!item || typeof item !== 'object') return false;
    const draft = item.draft;
    return item.sessionId === session && typeof item.id === 'string' && /^[a-f0-9]{32}$/.test(item.id)
      && typeof item.turnId === 'string' && Number.isFinite(item.createdAt) && item.state === 'prepared'
      && draft && typeof draft.title === 'string' && typeof draft.body === 'string' && typeof draft.tags === 'string'
      && Array.isArray(draft.platforms) && draft.platforms.every((x: unknown) => typeof x === 'string')
      && Array.isArray(draft.media) && draft.media.every((x: unknown) => typeof x === 'string')
      && draft.overrides && typeof draft.overrides === 'object' && !Array.isArray(draft.overrides)
      && Object.values(draft.overrides).every(x => typeof x === 'string');
  });
}
export interface ChatArtifact {
  id: string; sessionId: string; turnId: string; path: string; name: string;
  mimeType: string; version: string; size: number; status: 'ready' | 'missing' | 'failed';
  description?: string; error?: string;
  revision: number;
}
export interface ChatImageJob {
  jobId: string; sessionId: string; turnId: string; prompt: string;
  phase: 'queued' | 'running' | 'done' | 'error' | 'unconfirmed'; error?: string;
}
export interface ExternalChatMessage {
  id: string; turnId: string; role: 'assistant'; content: string; source: 'gateway-injected'; timestamp: number;
}
export function decodeExternalMessages(value: unknown): ExternalChatMessage[] {
  return Array.isArray(value) ? value.filter((row): row is ExternalChatMessage => row && /^[a-f0-9]{32}$/.test(row.id)
    && row.turnId === `external-${row.id}` && row.role === 'assistant' && typeof row.content === 'string' && row.source === 'gateway-injected' && Number.isFinite(row.timestamp)) : [];
}
export function decodeImageJobs(value: unknown, session: string): ChatImageJob[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is ChatImageJob => row && row.sessionId === session && /^[a-f0-9]{32}$/.test(row.jobId)
    && typeof row.turnId === 'string' && !row.turnId.startsWith('studio-') && typeof row.prompt === 'string' && ['queued','running','done','error','unconfirmed'].includes(row.phase));
}
export function decodeArtifacts(value: unknown, session: string): ChatArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is ChatArtifact => {
    if (!row || typeof row !== 'object') return false;
    const a = row as Record<string, unknown>;
    return a.sessionId === session && /^[a-f0-9]{32}$/.test(String(a.id))
      && typeof a.turnId === 'string' && !a.turnId.startsWith('studio-') && typeof a.name === 'string' && typeof a.path === 'string'
      && typeof a.version === 'string' && typeof a.mimeType === 'string'
      && typeof a.size === 'number' && ['ready', 'missing', 'failed'].includes(String(a.status));
  });
}
export function artifactUrl(artifact: ChatArtifact, action: 'file' | 'preview' | 'refresh', attempt = 0) {
  const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  return `${base}/api/chat/artifacts/${encodeURIComponent(artifact.sessionId)}/${artifact.id}/${action}?v=${encodeURIComponent(artifact.version)}&attempt=${attempt}`;
}
