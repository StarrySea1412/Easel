import { useEffect, useSyncExternalStore } from 'react';
import { request, type AccountItem } from './api';
import { getWhoamiCache, hydrateAccountIdentities, markWhoamiUnverified, setWhoamiCache } from './whoami';

export interface AccountHealth {
  key: string; source: 'default' | 'independent'; platform: string; label: string; accountId?: string;
  state: 'online' | 'login_required' | 'identity_changed' | 'unknown';
  checkedAt?: number; lastOnlineAt?: number; nextCheckAt?: number; checking: boolean; busy: boolean;
}
export interface HealthSnapshot {
  accounts: AccountHealth[]; defaultAccounts: AccountItem[]; running: boolean; scanFailed: boolean;
  lastScanAt?: number; intervalSeconds: number; freshForSeconds: number; serverTime: number;
}
const listeners = new Set<() => void>();
let snapshot: HealthSnapshot | null = null;
let unavailable = false;
let receivedAt = 0;
let requestSequence = 0;
let settledSequence = 0;
export const ACCOUNT_HEALTH_EVENT = 'easel:account-health';
export const readAccountHealth = () => ({ snapshot, unavailable, receivedAt });
let current = readAccountHealth();
function changed() {
  current = readAccountHealth(); listeners.forEach(listener => listener());
  window.dispatchEvent(new window.Event(ACCOUNT_HEALTH_EVENT));
}
export async function refreshAccountHealth() {
  const sequence = ++requestSequence;
  const before = getWhoamiCache();
  try {
    const result = await request<HealthSnapshot>('/api/account-health', { signal: AbortSignal.timeout(12_000) });
    if (!Array.isArray(result.accounts) || !Array.isArray(result.defaultAccounts) || typeof result.running !== 'boolean') throw Error('账号巡检响应无效');
    if (sequence < settledSequence) return;
    settledSequence = sequence;
    const cached = getWhoamiCache();
    const accepted = new Set(result.defaultAccounts.filter(row =>
      JSON.stringify(before[row.platform]) === JSON.stringify(cached[row.platform])
      && (cached[row.platform]?.checkedAt || 0) <= result.serverTime
    ).map(row => row.platform));
    const accounts = result.accounts.filter(row => row.source !== 'default' || accepted.has(row.platform)
      && (!cached[row.platform]?.verified || (row.checkedAt || 0) >= (cached[row.platform]?.checkedAt || 0)));
    snapshot = { ...result, accounts }; unavailable = false; receivedAt = Date.now();
    hydrateAccountIdentities(result.defaultAccounts.filter(row => accepted.has(row.platform)));
    for (const account of accounts.filter(row => row.source === 'default')) {
      const previous = getWhoamiCache()[account.platform];
      // The server is authoritative for newer expiry and check failures. A local
      // check completed after this snapshot must not be overwritten by an old GET.
      if (account.checkedAt && account.checkedAt >= (previous?.checkedAt || 0)) {
        if (account.state === 'login_required') setWhoamiCache(account.platform, {
          loggedIn: false, name: '', avatar: '', verified: true, authState: 'login_required', checkedAt: account.checkedAt,
          identityKey: result.defaultAccounts.find(row => row.platform === account.platform)?.identityKey,
        });
        else if (account.state !== 'online') markWhoamiUnverified(account.platform, '后台未能确认在线，请重新核验。');
      }
    }
    changed();
  } catch {
    if (sequence < settledSequence) return;
    settledSequence = sequence;
    unavailable = true; changed();
  }
}
export function useAccountHealth() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current);
}
export function useAccountHealthPolling() {
  useEffect(() => {
    let stopped = false, busy = false;
    const tick = async () => {
      if (stopped || busy || document.visibilityState === 'hidden') return;
      busy = true; try { await refreshAccountHealth(); } finally { busy = false; }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 15_000);
    window.addEventListener('focus', tick); window.addEventListener('online', tick);
    document.addEventListener('visibilitychange', tick);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('focus', tick);
      window.removeEventListener('online', tick); document.removeEventListener('visibilitychange', tick); };
  }, []);
}
