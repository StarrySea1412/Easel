import { request } from './api';
import { validateAnalysisReport, type AnalysisReport, type AnalysisSyncState } from './contentAnalysis';
import type { SocialAccount } from './socialAccounts';
import { publishWorkbenchChange } from './workbenchEvents';

export interface AccountOverview {
  fetchedAt: string | number; followers: number | null; likes: number | null; posts: number | null;
  metrics: {label:string;value:string;vs:string}[];
}
export interface AccountAnalysis {
  account: SocialAccount; sync: AnalysisSyncState & {overview?:AccountOverview}; report: AnalysisReport | null;
}
async function load(id:string, platform:string, externalId?:string, collect=false):Promise<AccountAnalysis> {
  const value=await request<AccountAnalysis>(`/api/social-accounts/${encodeURIComponent(id)}/analysis`, collect?{method:'POST'}:undefined);
  if(value.account.accountId!==id||value.account.platform!==platform||value.sync.scope.platform!==platform||
    (externalId&&value.account.externalAccountId!==externalId)||value.sync.scope.accountId!==(value.account.externalAccountId||null))throw new Error('返回的分析归属与所选独立账号不一致，已阻止展示。');
  if(value.report)validateAnalysisReport(value.report,platform,value.account.externalAccountId);
  if(collect)publishWorkbenchChange({domain:'analysis',platform,accountId:value.account.externalAccountId});
  return value;
}
export const readAccountAnalysis=(id:string,platform:string,externalId?:string)=>load(id,platform,externalId);
export const collectAccountAnalysis=(id:string,platform:string,externalId?:string)=>load(id,platform,externalId,true);
