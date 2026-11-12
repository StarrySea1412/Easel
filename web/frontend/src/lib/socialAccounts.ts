import { request } from './api';
import type { PublishOutcome, PublishRequest } from './api';

export interface SocialAccount {
  accountId: string; platform: string; label: string; name: string;
  externalAccountId: string; status: string; busy: boolean; attemptId: string;
  checkedAt?: string; updatedAt: string; generation?: number;
}
export interface PublishAccountFocus { accountId: string; platform: string; nonce: number; workspaceId: string }
export function socialAccountStatus(account: SocialAccount, now = Date.now()): string {
  if (account.status !== 'ready') return account.status;
  const checked = account.checkedAt ? Date.parse(account.checkedAt) : NaN;
  return Number.isFinite(checked) && checked <= now && now - checked < 600_000 ? 'ready' : 'unverified';
}
export const socialAccountReady = (account: SocialAccount) => socialAccountStatus(account) === 'ready' && !account.busy;
export interface LoginEvent {
  id: number; accountId?: string; platform?: string; attemptId: string;
  action: string; state: string; message: string; at: string;
}
export interface AccountLogin { accountId: string; attemptId: string; state: string; qr: string; qrKind?: 'qr' | 'page'; message?: string }
export type AccountPayload = PublishRequest['payload'] & { mediaHashes?: Record<string, string> };
export interface AccountTarget { accountId: string; payload: AccountPayload }
export interface DistributionJob {
  jobId: string; platform: string; accountId: string; accountLabel: string; externalAccountId: string;
  payload: AccountPayload; state: string; outcome: PublishOutcome | null; message: string; receiptId: string;
  mediaHashes?: Record<string, string>;
}
export interface DistributionBatch { batchId: string; createdAt: string; state: string; jobs: DistributionJob[] }
const root = '/api/social-accounts';
const post = <T>(path: string, body = {}) => request<T>(root + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
export const socialAccounts = {
  list: async (signal?: AbortSignal) => {
    const rows = await request<SocialAccount[]>(root, { signal });
    if (!Array.isArray(rows)) throw Error('账号列表格式不正确');
    return rows.map(row => ({ ...row, status: socialAccountStatus(row) }));
  },
  create: (label: string, platform: string) => post<SocialAccount>('', { label, platform }),
  history: (id: string) => request<LoginEvent[]>(`${root}/${id}/history`),
  defaults: () => request<LoginEvent[]>(root + '/default-history'),
  login: (id: string) => post<AccountLogin>(`/${id}/login`),
  progress: (id: string) => request<AccountLogin>(`${root}/${id}/login`),
  cancel: (id: string, attemptId: string) => post<SocialAccount>(`/${id}/cancel`, { attemptId }),
  sms: (id: string, attemptId: string, code: string) => post<{ ok: boolean }>(`/${id}/sms`, { attemptId, code }),
  check: (id: string) => post<SocialAccount>(`/${id}/check`),
  logout: (id: string) => post<SocialAccount>(`/${id}/logout`),
  batches: () => request<DistributionBatch[]>(root + '/batches'),
  submit: (requestKey: string, requests: AccountTarget[]) => post<DistributionBatch>('/batches', { requestKey, requests, confirmed: true }),
};
export const socialPlatforms = [
  { value: 'xiaohongshu', label: '小红书' }, { value: 'douyin', label: '抖音' },
  { value: 'kuaishou', label: '快手' }, { value: 'weixin-channels', label: '视频号' },
  { value: 'zhihu', label: '知乎' }, { value: 'bilibili', label: 'B站' }, { value: 'wechat-oa', label: '公众号（草稿）' },
];
export const accountState: Record<string, string> = {
  analyzing: '分析读取中', logged_out: '未登录', connecting: '登录中', checking: '核验中', logging_out: '退出中',
  ready: '身份已核验', unverified: '待在线核验', login_required: '需重新登录', error: '操作未完成',
  identity_changed: '身份不一致', starting: '启动中', qr_ready: '请扫码', scanned: '已扫码，等待确认',
  verifying: '等待平台验证', sms_required: '需在官方页面额外验证',
};
