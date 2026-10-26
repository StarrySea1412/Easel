import type { MemoryExtraction } from './profileMemory';
export interface AnalysisBinding {
  id: string; platform: string; accountId: string; accountName: string; sessionId: string;
  kind: 'account-analysis' | 'content-analysis'; contentIds: string[]; sourceHash: string;
  persona?:string; personaId?:string; experienceExtraction?:MemoryExtraction;
  markdown: string; createdAt: string; status: 'prepared' | 'completed'; stale?: boolean;
  result: { versionHash?:string; markdown: string; turnId: string; at: string; notice: string } | null;
}
export type AnalysisChatRequest = { platform: string; accountId: string; contentId?: string; sessionId?: string };
export function isAnalysisBinding(value: unknown): value is AnalysisBinding {
  if (!value || typeof value !== 'object') return false;
  const v = value as AnalysisBinding;
  return ['account-analysis', 'content-analysis'].includes(v.kind) &&
    ['xiaohongshu','douyin','kuaishou','zhihu','weixin-channels','bilibili','wechat-oa'].includes(v.platform) &&
    ['id','accountId','sessionId','sourceHash','markdown','createdAt','accountName'].every(k => typeof v[k as keyof AnalysisBinding] === 'string') &&
    ['prepared', 'completed'].includes(v.status) && (v.stale === undefined || typeof v.stale === 'boolean') &&
    Array.isArray(v.contentIds) && v.contentIds.every(id => typeof id === 'string') &&
    (v.result === null || Boolean(v.result && ['markdown','turnId','at','notice'].every(k => typeof v.result![k as keyof NonNullable<AnalysisBinding['result']>] === 'string')));
}
