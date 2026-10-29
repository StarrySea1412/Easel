// whoami 登录态：缓存 + 开页后台自愈校验。账号页与工作台「创作数据」卡片共用，
// 避免对同一平台在 TTL 内重复起 headless 浏览器。ts 仅用于未确认检查的退避，checkedAt 才是在线证据时间。
import { useSyncExternalStore } from 'react';
import { accountWhoami, decodeAccountWhoami, type AccountWhoami, type AccountItem } from './api';

const KEY = 'easel_whoami';
const requestVersions = new Map<string, number>();
export const WHOAMI_TTL_MS = 600_000; // 10 分钟；发布前仍强制核验
export const ACCOUNT_REFRESH_MS = 600_000;
export const ACCOUNT_STATE_EVENT = 'easel:account-state';
const ACCOUNT_CHECK_EVENT = 'easel:account-check';
const checking = new Set<string>();

export function setAccountChecking(platform: string, active: boolean): void {
  if (active) checking.add(platform); else checking.delete(platform);
  window.dispatchEvent(new window.Event(ACCOUNT_CHECK_EVENT));
}
const checkSnapshot = () => [...checking].sort().join(',');
const subscribeChecks = (listener: () => void) => {
  window.addEventListener(ACCOUNT_CHECK_EVENT, listener);
  return () => window.removeEventListener(ACCOUNT_CHECK_EVENT, listener);
};
export function useAccountChecks(): Set<string> {
  const value = useSyncExternalStore(subscribeChecks, checkSnapshot);
  return new Set(value ? value.split(',') : []);
}

export type WhoamiEntry = AccountWhoami & { ts: number };

export function getWhoamiCache(): Record<string, WhoamiEntry> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([platform, entry]) => {
      try {
        const account = decodeAccountWhoami(entry);
        const ts = (entry as Record<string, unknown>).ts;
        return [[platform, { ...account, ts: typeof ts === 'number' && Number.isFinite(ts) && ts >= 0 ? ts : 0 }]];
      } catch { return []; } // Ignore only the malformed entry; never erase browser or platform data.
    }));
  } catch { return {}; }
}

/** 写缓存；r 为 null 则删除该平台条目。附带 ts 供 TTL 判定（旧格式无 ts→视为过期）。 */
export function setWhoamiCache(platform: string, r: AccountWhoami | null, options?: { hydrated?: boolean }): void {
  requestVersions.set(platform, (requestVersions.get(platform) || 0) + 1);
  const previous = getWhoamiCache()[platform];
  const compatible = previous?.loggedIn && (!r?.identityKey || r.identityKey === previous.identityKey)
    && (!r?.accountId || !previous.accountId || r.accountId === previous.accountId)
    && (!r?.name || !previous.name || r.name === previous.name);
  const retain = r && compatible && (r.loggedIn || r.verified === false);
  const entry = r ? { ...r, ...(retain ? {
    name: r.name || previous.name, avatar: r.avatar || previous.avatar,
    identityKey: r.identityKey || previous.identityKey, accountId: r.accountId || previous.accountId,
    loggedIn: r.verified === false ? previous.loggedIn : r.loggedIn,
    checkedAt: r.checkedAt ?? previous.checkedAt,
  } : {}), ts: options?.hydrated ? 0 : Date.now() } : null;
  try {
    const c = getWhoamiCache();
    if (entry) c[platform] = entry;
    else delete c[platform];
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch { /* 配额 / 隐私模式：忽略 */ }
  window.dispatchEvent(new window.CustomEvent(ACCOUNT_STATE_EVENT, { detail: { platform, entry } }));
}

export function isWhoamiFresh(e: AccountWhoami & { ts?: number } | undefined, ttlMs = WHOAMI_TTL_MS): boolean {
  const at = e?.checkedAt;
  return !!e && e.verified === true && (e.loggedIn || e.authState === 'login_required' || e.authState === 'not_connected') && typeof at === 'number' && Number.isFinite(at)
    && at <= Date.now() && Date.now() - at < ttlMs;
}

/** Restore display identity without promoting a saved snapshot to an online check. */
export function hydrateAccountIdentities(accounts: AccountItem[]): void {
  for (const account of accounts) {
    if (!account.identityKey) continue;
    let previous: WhoamiEntry | undefined = getWhoamiCache()[account.platform];
    if (account.connection) {
      try {
        const proof = decodeAccountWhoami(account.connection);
        if (proof.identityKey === account.identityKey && isWhoamiFresh(proof)
            && (!previous || (proof.checkedAt || 0) > (previous.checkedAt || 0))) {
          setWhoamiCache(account.platform, proof);
          continue;
        }
      } catch { /* A display snapshot or malformed response is never online proof. */ }
    }
    if (previous && previous.identityKey !== account.identityKey) {
      setWhoamiCache(account.platform, null);
      previous = undefined;
    }
    if (!previous && account.identity) {
      try {
        const identity = decodeAccountWhoami(account.identity);
        if (identity.identityKey === account.identityKey) {
          setWhoamiCache(account.platform, { ...identity, verified: false, authState: 'unknown' }, { hydrated: true });
        }
      } catch { /* Ignore malformed snapshots without replacing a live result. */ }
    }
  }
}

export type AccountConnection = 'online' | 'login_required' | 'not_connected' | 'unknown';

/** All pages use the same evidence rule. A local marker is only a snapshot. */
export function accountConnection(account?: Pick<AccountItem, 'loggedIn' | 'hasLocalSession'>, entry?: WhoamiEntry): AccountConnection {
  if (isWhoamiFresh(entry)) return entry!.loggedIn ? 'online' : entry!.authState === 'not_connected' ? 'not_connected' : 'login_required';
  if (entry || account?.loggedIn || account?.hasLocalSession || !account) return 'unknown';
  return account.hasLocalSession === false ? 'not_connected' : 'unknown';
}

function accountSnapshot(): string {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}
function subscribeAccountState(listener: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) listener(); };
  const timer = window.setInterval(listener, 60_000);
  window.addEventListener(ACCOUNT_STATE_EVENT, listener);
  window.addEventListener('storage', storage);
  window.addEventListener('focus', listener);
  return () => { window.clearInterval(timer); window.removeEventListener(ACCOUNT_STATE_EVENT, listener);
    window.removeEventListener('storage', storage); window.removeEventListener('focus', listener); };
}

/** Shared identity snapshot, including local events, cross-tab changes and TTL expiry. */
export function useAccountIdentities(): Record<string, WhoamiEntry> {
  // The time bucket lets all mounted consumers expire a confirmed state together.
  useSyncExternalStore(subscribeAccountState, () => accountSnapshot() + ':' + Math.floor(Date.now() / 60_000));
  return getWhoamiCache();
}

export function markWhoamiUnverified(platform: string, message: string): void {
  const previous = getWhoamiCache()[platform];
  setWhoamiCache(platform, { ...(previous || { loggedIn: false, name: '', avatar: '' }), verified: false, verificationMessage: message });
}

interface VerifyOpts {
  ttlMs?: number;
  force?: boolean;
  onUpdate?: (platform: string, r: AccountWhoami) => void;
  onChecking?: (platform: string) => void;
  onError?: (platform: string, message: string) => void;
  alive?: () => boolean;
}

/**
 * 对缓存缺失/过期的平台在后台真校验（后端起 headless 浏览器，数秒/个），
 * 每得到一个结果就写缓存 + 回调 onUpdate。逐个串行，避免占满服务器浏览器资源。
 * Cookie 文件和登录成功标记都只是本地快照，不能替代在线检查。
 */
const WHOAMI_CONCURRENCY = 1;

export async function verifyStale(platforms: string[], opts: VerifyOpts = {}): Promise<void> {
  const ttlMs = opts.ttlMs ?? WHOAMI_TTL_MS;
  const due = (p: string) => {
    const entry = getWhoamiCache()[p];
    return !isWhoamiFresh(entry, ttlMs) && !(entry?.verified === false && Date.now() - entry.ts < ACCOUNT_REFRESH_MS);
  };
  const todo = opts.force ? platforms : platforms.filter(due);
  if (!todo.length) return;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      if (opts.alive && !opts.alive()) return;
      const p = todo[next++];
      if (checking.has(p) || (!opts.force && !due(p))) continue;
      const version = requestVersions.get(p) || 0;
      const before = JSON.stringify(getWhoamiCache()[p]);
      opts.onChecking?.(p);
      setAccountChecking(p, true);
      try {
        const r = await accountWhoami(p, opts.force);
        if (version !== (requestVersions.get(p) || 0) || before !== JSON.stringify(getWhoamiCache()[p])) continue;
        if (!isWhoamiFresh(r, ttlMs)) {
          const message = r.verificationMessage || '本次检查未确认登录状态，请重试。';
          setWhoamiCache(p, { ...r, verified: false, verificationMessage: message });
          if (!opts.alive || opts.alive()) opts.onError?.(p, message);
          continue;
        }
        setWhoamiCache(p, r);
        if (!opts.alive || opts.alive()) opts.onUpdate?.(p, getWhoamiCache()[p] || r);
      } catch (cause) {
        if (version !== (requestVersions.get(p) || 0) || before !== JSON.stringify(getWhoamiCache()[p])) continue;
        const message = cause instanceof Error ? cause.message : '登录检查失败，请重试。';
        markWhoamiUnverified(p, message);
        if (!opts.alive || opts.alive()) opts.onError?.(p, message);
        // A different tab or a still-running QR flow may own the only slot.
        // Stop this batch rather than flooding every remaining account with 429.
        if ((cause as { status?: number })?.status === 429) return;
      } finally { setAccountChecking(p, false); }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(WHOAMI_CONCURRENCY, todo.length) }, () => worker()),
  );
}

/** Refresh only the visible page. Each consumer owns its in-flight guard. */
export function watchAccountFreshness(refresh: () => void): () => void {
  const wake = () => { if (document.visibilityState === 'visible') refresh(); };
  const timer = window.setInterval(wake, ACCOUNT_REFRESH_MS);
  window.addEventListener('focus', wake);
  window.addEventListener('online', wake);
  document.addEventListener('visibilitychange', wake);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener('focus', wake);
    window.removeEventListener('online', wake);
    document.removeEventListener('visibilitychange', wake);
  };
}
