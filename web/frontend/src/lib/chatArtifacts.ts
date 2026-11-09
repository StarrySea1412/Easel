export interface ChatArtifact {
  id: string; sessionId: string; turnId: string; path: string; name: string;
  mimeType: string; version: string; size: number; status: 'ready' | 'missing' | 'failed';
  description?: string; error?: string;
  revision: number;
}
export interface ChatImageJob {
  jobId: string; sessionId: string; turnId: string; prompt: string;
  phase: 'queued' | 'running' | 'done' | 'error' | 'unconfirmed'; error?: string;
  artifactIds?: string[];
  paths?: string[];
}
/** Only explicit job attribution is evidence; never pair by arrival order or similar names. */
export function groupImageArtifacts(artifacts: ChatArtifact[], jobs: ChatImageJob[]) {
  const groups = jobs.map(job => ({ job, artifacts: [] as ChatArtifact[] }));
  const other: ChatArtifact[] = [];
  for (const artifact of artifacts) {
    const owners = groups.filter(({ job }) => artifact.mimeType.startsWith('image/') && job.sessionId === artifact.sessionId && job.turnId === artifact.turnId
      && (Array.isArray(job.artifactIds) && job.artifactIds.length ? job.artifactIds.includes(artifact.id) : Array.isArray(job.paths) && job.paths.includes(artifact.path)));
    if (owners.length === 1) owners[0].artifacts.push(artifact);
    else other.push(artifact);
  }
  return { groups, other };
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
    && typeof row.turnId === 'string' && typeof row.prompt === 'string' && ['queued','running','done','error','unconfirmed'].includes(row.phase));
}
export function decodeArtifacts(value: unknown, session: string): ChatArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is ChatArtifact => {
    if (!row || typeof row !== 'object') return false;
    const a = row as Record<string, unknown>;
    return a.sessionId === session && /^[a-f0-9]{32}$/.test(String(a.id))
      && typeof a.turnId === 'string' && typeof a.name === 'string' && typeof a.path === 'string'
      && typeof a.version === 'string' && typeof a.mimeType === 'string'
      && typeof a.size === 'number' && ['ready', 'missing', 'failed'].includes(String(a.status));
  });
}
export function artifactUrl(artifact: ChatArtifact, action: 'file' | 'preview' | 'refresh', attempt = 0) {
  const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  return `${base}/api/chat/artifacts/${encodeURIComponent(artifact.sessionId)}/${artifact.id}/${action}?v=${encodeURIComponent(artifact.version)}&attempt=${attempt}`;
}
