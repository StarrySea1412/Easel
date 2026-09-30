export type MetricKey = 'views' | 'likes' | 'comments' | 'collects' | 'shares';
export type Metrics = Partial<Record<MetricKey, number | null>>;
export interface AnalysisContent { id: string; title: string; body?: string; comments?:string[]; coverText?:string; transcript?:string; aiReview?:{model:string;at:string;findings:{evidenceId:string;quote:string;interpretation:string;action:string}[];notice:string}; draft?:{titleOptions:string[];outline:string[];audienceQuestion:string}; tags: string[]; format: string; publishedAt?: string; url?: string; metrics: Metrics; snapshotAt?: string; period: string; snapshots?:{snapshotAt:string;period:string;metrics:Metrics}[]; diagnostics: {id: string; dimension: string; observation: string; evidence: string; action: string; limitation: string}[] }
export interface AnalysisAccount { platform: string; accountId: string; name: string; contentCount: number; lastImportedAt?: string }
export interface AnalysisExperiment { id: string; title: string; hypothesis: string; action: string; metric: MetricKey; contentIds: string[]; reviewAt?: string; status: 'planned'|'running'|'reviewed'; conclusion?: string; baseline: {contentId:string;value:number|null;snapshotAt:string}[]; reviews: {at:string;note:string;observations:{contentId:string;value:number|null;delta:number|null;note?:string;snapshotAt:string}[]}[] }
export interface AnalysisReport { account: AnalysisAccount; contents: AnalysisContent[]; overview: {contentCount:number;metricCoverage:Metrics;totals:Metrics;lastImportedAt?:string}; themes:{tag:string;count:number;contentIds:string[];metrics:Metrics;coverage:Metrics}[]; experiments:AnalysisExperiment[]; quality:{warnings:string[];identity:string}; methodology:unknown }
const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
export const analysisUrl = (path:string) => `${base}/api/content-analysis${path}`;
export async function analysisRequest<T>(path:string, method='GET', body?:unknown):Promise<T> {
  const response = await fetch(analysisUrl(path), {method, cache:'no-store', headers: body ? {'Content-Type':'application/json'} : undefined, body:body ? JSON.stringify(body) : undefined});
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(typeof data.detail === 'string' ? data.detail : `请求失败 (${response.status})`); }
  return response.json();
}
