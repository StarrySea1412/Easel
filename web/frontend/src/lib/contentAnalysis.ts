export type MetricKey = 'views' | 'likes' | 'comments' | 'collects' | 'shares';
export type Metrics = Partial<Record<MetricKey, number | null>>;
export type AdvancedMetricKey = 'impressions' | 'completions' | 'averageWatchSeconds' | 'durationSeconds' | 'followersAttributed' | 'coins' | 'danmaku';
export type AdvancedMetrics = Partial<Record<AdvancedMetricKey, number | null>>;
export type ExperimentMetric = MetricKey | AdvancedMetricKey;
export interface AnalysisCapability { id:string; question:string; required:string[]; available:number; total:number; status:string; limitation:string }
export interface AnalysisTopic { id:string; label:string; kind:string; status:'exploratory'|'needs_data'|'editorial'; evidenceIds:string[]; counterexampleIds:string[]; sampleCount:number; totalCount:number; metric:ExperimentMetric; metricLabel:string; value:number|null; baselineValue:number|null; period:string|null; comparison:string; missingCount:number; observation:string; hypothesis:string; action:string; reviewAt:string; stopRule:string; limitations:string[] }
export interface TopicEvidence { scope:{platform:string;accountId:string}; topic:AnalysisTopic; capturedAt:string }
export interface ProfessionalAnalysis { scope:{platform:string;accountId:string}; capabilities:AnalysisCapability[]; quality:{total:number;comparable:number;excluded:{id:string;reasons:string[]}[];observedFrom:string|null;observedTo:string|null}; metricDefinitions:{key:string;label:string;unit:string;formula:string;limitation:string}[]; cohorts:{id:string;label:string;contentIds:string[];period:string;ageDays:number|null;format:string;paid:boolean|null}[]; topics:AnalysisTopic[] }
export interface AnalysisPlatformProfile { platform:string; label:string; version:string; focus:string[]; limitations:string[]; materialNeeds:string[] }
export interface AccountInsight { factIds:string[]; observation:string; action:string }
export interface AccountInsights { model:string; at:string; notice:string; facts:{id:string;text:string;contentIds:string[]}[]; insights:AccountInsight[] }
export interface AnalysisContent { id: string; title: string; body?: string; comments?:string[]; coverText?:string; transcript?:string; aiReview?:{model:string;at:string;findings:{evidenceId:string;quote:string;interpretation:string;action:string}[];notice:string}; draft?:{titleOptions:string[];outline:string[];audienceQuestion:string}; tags: string[]; format: string; publishedAt?: string; url?: string; metrics: Metrics; snapshotAt?: string; period: string; snapshots?:{snapshotAt:string;period:string;metrics:Metrics}[]; diagnostics: {id: string; dimension: string; observation: string; evidence: string; action: string; limitation: string}[] }
export interface AnalysisAccount { platform: string; accountId: string; name: string; contentCount: number; lastImportedAt?: string }
export interface AnalysisExperiment { id: string; title: string; hypothesis: string; action: string; metric: ExperimentMetric; contentIds: string[]; reviewAt?: string; status: 'planned'|'running'|'reviewed'; conclusion?: string; baseline: {contentId:string;value:number|null;snapshotAt:string}[]; reviews: {at:string;note:string;observations:{contentId:string;value:number|null;delta:number|null;note?:string;snapshotAt:string}[]}[] }
export interface AnalysisReport { platformProfile?:AnalysisPlatformProfile; accountInsights?:AccountInsights|null; account: AnalysisAccount; contents: AnalysisContent[]; overview: {contentCount:number;metricCoverage:Metrics;totals:Metrics;lastImportedAt?:string}; themes:{tag:string;count:number;contentIds:string[];metrics:Metrics;coverage:Metrics}[]; experiments:AnalysisExperiment[]; quality:{warnings:string[];identity:string}; methodology:unknown }
export interface AnalysisContent { advancedMetrics?:AdvancedMetrics; paid?:boolean|null }
export interface AnalysisReport { professional?:ProfessionalAnalysis }
export interface AnalysisSyncState {
  scope: { platform:string; accountId:string|null };
  status: 'idle'|'syncing'|'ready'|'partial'|'empty'|'logged_out'|'identity_unverified'|'account_mismatch'|'unsupported'|'error';
  supported:boolean; accountName?:string; loadedCount:number; receivedCount?:number; totalCount:number|null; totalKnown:boolean;
  complete:boolean; fetchedAt:string|number|null; message:string; retryable:boolean; report?:AnalysisReport;
  connectedAccountId?:string; connectedAccountName?:string; cached?:boolean;
}
export interface AnalysisExperiment { evidence?:TopicEvidence }
export function validateAnalysisReport(report:AnalysisReport, platform:string, accountId:string):AnalysisReport {
  if (report?.account?.platform !== platform || report.account.accountId !== accountId ||
      (report.professional && (report.professional.scope.platform !== platform || report.professional.scope.accountId !== accountId))) {
    throw new Error('返回的分析记录与当前平台或账号不一致，已阻止展示；请重新读取。');
  }
  return report;
}
export function topicEvidence(report:AnalysisReport, topic:AnalysisTopic):TopicEvidence {
  return JSON.parse(JSON.stringify({scope:{platform:report.account.platform,accountId:report.account.accountId},topic,capturedAt:new Date().toISOString()})) as TopicEvidence;
}
export function topicIdeaNote(evidence:TopicEvidence):string {
  const topic = evidence.topic;
  return [`平台：${evidence.scope.platform} · 账号：${evidence.scope.accountId}`, `题材假设：${topic.hypothesis}`, `单变量行动：${topic.action}`, `比较指标：${topic.metricLabel} · 窗口：${topic.period||'未形成可比窗口'} · 实验主指标字段：${topic.metric}`, `引用样本：${topic.sampleCount}/${topic.totalCount} · 缺失：${topic.missingCount}`, `观察日期：${topic.reviewAt} · 停止规则：${topic.stopRule}`, `局限：${topic.limitations.join('；')}`, '以下证据是保存时的固定快照，后续采集不自动改写：', JSON.stringify(evidence,null,2)].join('\n');
}
const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
export const analysisUrl = (path:string) => `${base}/api/content-analysis${path}`;
export async function analysisRequest<T>(path:string, method='GET', body?:unknown):Promise<T> {
  const response = await fetch(analysisUrl(path), {method, cache:'no-store', headers: body ? {'Content-Type':'application/json'} : undefined, body:body ? JSON.stringify(body) : undefined});
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(typeof data.detail === 'string' ? data.detail : `请求失败 (${response.status})`); }
  return response.json();
}
