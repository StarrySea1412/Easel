import type { AccountAnalytics } from "./api";
import { publishWorkbenchChange } from "./workbenchEvents";
import { sanitizeAccountMetrics } from './accountMetricEvidence';

const storageKey = "easel:analytics-cache:v1";
type Entry = { scope: string; at: number; data: AccountAnalytics };
const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<AccountAnalytics>>();
const errors = new Map<string, string>();
const listeners = new Set<() => void>();
let revision = 0;
const keyFor = (platform: string) => platform + ':' + analyticsScope(platform);
function changed(platform: string) {
  revision++;
  listeners.forEach(listener => listener());
  publishWorkbenchChange({ domain: 'analysis', platform, source: 'account-analytics' });
}
export const subscribeAnalytics = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const analyticsRevision = () => revision;
export const analyticsPending = (platform: string) => pending.has(keyFor(platform));
export const analyticsError = (platform: string) => errors.get(keyFor(platform)) || '';
export function selectedAnalyticsPlatform(): string {
  try { return sessionStorage.getItem('easel:analytics-platform') || ''; } catch { return ''; }
}
export function selectAnalyticsPlatform(platform: string) {
  try { sessionStorage.setItem('easel:analytics-platform', platform); } catch { /* Selection remains usable in the current view. */ }
}
export function analyticsScope(platform: string): string {
  try {
    const identity = JSON.parse(localStorage.getItem("easel_whoami") || "{}")[platform];
    return JSON.stringify([identity?.identityKey || "", identity?.accountId || ""]);
  } catch { return "[]"; }
}
function restore() {
  try {
    const rows = JSON.parse(sessionStorage.getItem(storageKey) || "{}");
    for (const [platform, row] of Object.entries(rows)) {
      const entry = row as Entry;
      if (entry?.data) entry.data = sanitizeAccountMetrics(entry.data);
      if ((!entries.has(platform) || entries.get(platform)?.scope !== analyticsScope(platform)) && entry?.scope === analyticsScope(platform) && Number.isFinite(entry.at) && entry.data?.platform === platform && entry.data.loggedIn) entries.set(platform, entry);
    }
  } catch { /* Memory remains usable without browser storage. */ }
}
export function readAnalyticsCache(platform: string): AccountAnalytics | null {
  restore();
  if (analyticsScope(platform) === '["",""]') return null;
  const entry = entries.get(platform);
  return entry?.scope === analyticsScope(platform) ? entry.data : null;
}
export function restoreAnalyticsSnapshot(platform: string, data: AccountAnalytics, expectedScope: string): void {
  data = sanitizeAccountMetrics(data);
  if (expectedScope !== analyticsScope(platform) || expectedScope === '["",""]' || data.platform !== platform || !data.loggedIn) return;
  const previous = readAnalyticsCache(platform);
  if (previous && previous.fetched_at >= data.fetched_at) return;
  entries.set(platform, {scope:expectedScope, at:Date.now(), data});
  try { sessionStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries))); } catch { /* In-memory fallback. */ }
  changed(platform);
}
export async function collectAnalytics(platform: string, capture: () => Promise<AccountAnalytics>, force = false): Promise<AccountAnalytics> {
  restore();
  const scope = analyticsScope(platform), key = platform + ":" + scope;
  const active = pending.get(key);
  if (active) return active;
  const entry = entries.get(platform);
  if (!force && entry?.scope === scope) return entry.data;
  const task = capture().then(data => {
    data = sanitizeAccountMetrics(data);
    if (analyticsScope(platform) !== scope) throw new Error("账号已切换，已丢弃旧采集结果");
    if (data.loggedIn && scope !== '["",""]') {
      entries.set(platform, {scope, at:Date.now(), data});
      try { sessionStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries))); } catch { /* Keep this tab's successful snapshot in memory. */ }
    }
    return data;
  });
  pending.set(key, task);
  errors.delete(key);
  changed(platform);
  try { return await task; }
  catch (reason) {
    if (analyticsScope(platform) === scope) errors.set(key, reason instanceof Error ? reason.message : '读取失败，请重试');
    throw reason;
  } finally {
    if (pending.get(key) === task) pending.delete(key);
    changed(platform);
  }
}
