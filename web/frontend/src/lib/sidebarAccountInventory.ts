import type { AccountItem } from './api';
import { defaultAccountInventory } from './accountInventory';
import { accountState, socialAccountStatus, type SocialAccount } from './socialAccounts';
import type { WhoamiEntry } from './whoami';

export const snapshotPlatforms = [
  ['xiaohongshu', '小红书'], ['kuaishou', '快手'], ['weixin-channels', '视频号'],
  ['zhihu', '知乎'], ['bilibili', '哔哩哔哩'], ['douyin', '抖音'], ['wechat-oa', '微信公众号'],
] as const;
export type SnapshotState = 'online' | 'attention' | 'unknown' | 'busy';
export interface SnapshotAccount {
  key: string; target: string; platform: string; source: 'default' | 'independent';
  name: string; detail: string; state: SnapshotState; status: string; checkedAt?: number;
}
export interface SnapshotGroup {
  platform: string; name: string; accounts: SnapshotAccount[]; online: number; attention: number; unknown: number; busy: number;
}

/** The same managed records as account center. Never infer login from a directory
 * or merge two distinct local profile bindings because their nicknames match. */
export function sidebarAccountInventory(defaults: AccountItem[], independent: SocialAccount[],
  identities: Record<string, WhoamiEntry>, checking: Set<string>, hidden = false, now = Date.now()): SnapshotGroup[] {
  const rows: SnapshotAccount[] = defaultAccountInventory(defaults, identities).map(account => {
    const busy = checking.has(account.platform);
    return { key: 'default:' + account.platform, target: 'default:' + account.platform, platform: account.platform,
      source: 'default', name: hidden ? '默认账号' : account.name || '默认账号', detail: '', checkedAt: account.checkedAt,
      state: busy ? 'busy' : account.connection === 'online' ? 'online' : account.connection === 'unknown' ? 'unknown' : 'attention',
      status: busy ? '核验中' : account.connection === 'online' ? '在线' : account.connection === 'unknown' ? '待确认'
        : account.connection === 'not_connected' ? '未连接' : '需重连' };
  });
  for (const [index, account] of independent.entries()) {
    if (!snapshotPlatforms.some(([platform]) => platform === account.platform)) continue;
    const status = socialAccountStatus(account, now);
    const busy = account.busy || ['connecting', 'checking', 'logging_out', 'analyzing'].includes(status);
    const state: SnapshotState = busy ? 'busy' : status === 'ready' ? 'online'
      : ['login_required', 'identity_changed', 'logged_out'].includes(status) ? 'attention' : 'unknown';
    rows.push({ key: account.accountId, target: account.accountId, platform: account.platform, source: 'independent',
      name: hidden ? `独立账号 ${index + 1}` : account.label || account.name || '独立账号',
      detail: !hidden && account.name && account.name !== account.label ? account.name : '',
      state, status: busy ? (['connecting', 'checking', 'logging_out', 'analyzing'].includes(status) ? accountState[status] : '操作中') : status === 'ready' ? '在线'
        : status === 'identity_changed' ? '身份变化' : status === 'logged_out' ? '未连接'
          : status === 'login_required' ? '需重连' : '待确认',
      checkedAt: account.checkedAt ? Date.parse(account.checkedAt) : undefined });
  }
  return snapshotPlatforms.flatMap(([platform, name]) => {
    const accounts = rows.filter(row => row.platform === platform);
    if (!accounts.length) return [];
    // Only duplicate names need an extra discriminator. A profile key remains
    // the navigation target even when the display identity is hidden.
    for (const account of accounts) {
      if (account.source === 'independent' && accounts.filter(row => row.name === account.name).length > 1) {
        let length = 6;
        while (length < account.key.length && accounts.some(row => row.key !== account.key && row.key.slice(0, length) === account.key.slice(0, length))) length++;
        account.detail = [account.detail, `编号 ${account.key.slice(0, length)}`].filter(Boolean).join(' · ');
      }
    }
    return [{ platform, name, accounts, online: accounts.filter(row => row.state === 'online').length,
      attention: accounts.filter(row => row.state === 'attention').length, unknown: accounts.filter(row => row.state === 'unknown').length,
      busy: accounts.filter(row => row.state === 'busy').length }];
  });
}

export function snapshotGroupSummary(group: SnapshotGroup): string {
  return [group.online ? `${group.online} 在线` : '', group.attention ? `${group.attention} 需处理` : '',
    group.unknown ? `${group.unknown} 待确认` : '', group.busy ? `${group.busy} 处理中` : ''].filter(Boolean).join(' · ');
}
