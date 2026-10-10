// whoami 登录态：缓存 + 开页后台自愈校验。账号页与工作台「创作数据」卡片共用，
// 避免对同一平台在 TTL 内重复起 headless 浏览器。缓存落 localStorage，条目带 ts。
import { accountWhoami, type AccountWhoami } from './api';

const KEY = 'easel_whoami';
const requestVersions = new Map<string, number>();
export const WHOAMI_TTL_MS = 600_000; // 10 分钟，与后端 WHOAMI_TTL 对齐
export const ACCOUNT_STATE_EVENT = 'easel:account-state';

export type WhoamiEntry = AccountWhoami & { ts: number };

export function getWhoamiCache(): Record<string, WhoamiEntry> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
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
 * 每得到一个结果就写缓存 + 回调 onUpdate。**并发 2 个**（比逐个串行快近一倍，又不至同时起太多
 * 浏览器打满资源）；每个平台仍独立、失败只跳过该平台，不影响其它，也不改任何登录/检测逻辑。
 * Cookie 文件和登录成功标记都只是本地快照，不能替代在线检查。
 */
const WHOAMI_CONCURRENCY = 2;

export function verifyStale(platforms: string[], opts: VerifyOpts = {}): void {
  const ttlMs = opts.ttlMs ?? WHOAMI_TTL_MS;
  const cache = getWhoamiCache();
  const todo = opts.force ? platforms : platforms.filter((p) => !isWhoamiFresh(cache[p], ttlMs));
  if (!todo.length) return;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      if (opts.alive && !opts.alive()) return;
      const p = todo[next++];
      const version = requestVersions.get(p) || 0;
      const before = JSON.stringify(getWhoamiCache()[p]);
      opts.onChecking?.(p);
      try {
        const r = await accountWhoami(p);
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
      }
    }
  };
  void Promise.all(
    Array.from({ length: Math.min(WHOAMI_CONCURRENCY, todo.length) }, () => worker()),
  );
}
