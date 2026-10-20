// whoami 登录态：缓存 + 开页后台自愈校验。账号页与工作台「创作数据」卡片共用，
// 避免对同一平台在 TTL 内重复起 headless 浏览器。缓存落 localStorage，条目带 ts。
import { accountWhoami, decodeAccountWhoami, type AccountWhoami } from './api';

const KEY = 'easel_whoami';
const requestVersions = new Map<string, number>();
export const WHOAMI_TTL_MS = 120_000; // 2 分钟，与后端 WHOAMI_TTL 对齐
export const ACCOUNT_REFRESH_MS = 60_000;
export const ACCOUNT_STATE_EVENT = 'easel:account-state';

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
export function setWhoamiCache(platform: string, r: AccountWhoami | null): void {
  requestVersions.set(platform, (requestVersions.get(platform) || 0) + 1);
  const entry = r ? { ...r, ts: Date.now() } : null;
  try {
    const c = getWhoamiCache();
    if (entry) c[platform] = entry;
    else delete c[platform];
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch { /* 配额 / 隐私模式：忽略 */ }
  window.dispatchEvent(new window.CustomEvent(ACCOUNT_STATE_EVENT, { detail: { platform, entry } }));
}

export function isWhoamiFresh(e: AccountWhoami & { ts?: number } | undefined, ttlMs = WHOAMI_TTL_MS): boolean {
  const at = e?.checkedAt ?? e?.ts;
  return !!e && e.verified !== false && typeof at === 'number' && Number.isFinite(at)
    && at <= Date.now() && Date.now() - at < ttlMs;
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
  const cache = getWhoamiCache();
  const todo = opts.force ? platforms : platforms.filter((p) => !isWhoamiFresh(cache[p], ttlMs));
  if (!todo.length) return;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      if (opts.alive && !opts.alive()) return;
      const p = todo[next++];
      if (!opts.force && isWhoamiFresh(getWhoamiCache()[p], ttlMs)) continue;
      const version = requestVersions.get(p) || 0;
      const before = JSON.stringify(getWhoamiCache()[p]);
      opts.onChecking?.(p);
      try {
        const r = await accountWhoami(p, opts.force);
        if (version !== (requestVersions.get(p) || 0) || before !== JSON.stringify(getWhoamiCache()[p])) continue;
        if (r.verified === false) {
          const message = r.verificationMessage || '本次检查未确认登录状态，请重试。';
          markWhoamiUnverified(p, message);
          if (!opts.alive || opts.alive()) opts.onError?.(p, message);
          continue;
        }
        setWhoamiCache(p, r);
        if (!opts.alive || opts.alive()) opts.onUpdate?.(p, r);
      } catch (cause) {
        if (version !== (requestVersions.get(p) || 0) || before !== JSON.stringify(getWhoamiCache()[p])) continue;
        const message = cause instanceof Error ? cause.message : '登录检查失败，请重试。';
        markWhoamiUnverified(p, message);
        if (!opts.alive || opts.alive()) opts.onError?.(p, message);
        // A different tab or a still-running QR flow may own the only slot.
        // Stop this batch rather than flooding every remaining account with 429.
        if ((cause as { status?: number })?.status === 429) return;
      }
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
