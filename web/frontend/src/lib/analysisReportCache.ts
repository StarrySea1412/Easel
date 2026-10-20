import type { AnalysisReport } from './contentAnalysis';

// Identity-scoped page snapshots; a page refresh reads SQLite again in the background.
const saved = new Map<string, AnalysisReport>();
const key = (platform: string, identity: string) => JSON.stringify([platform, identity]);
export function readAnalysisReport(platform: string, identity: string): AnalysisReport | null {
  if (!identity || identity === ':') return null;
  return saved.get(key(platform, identity)) || null;
}
export function rememberAnalysisReport(platform: string, identity: string, report: AnalysisReport): void {
  if (!identity || identity === ':' || report.account.platform !== platform) return;
  saved.set(key(platform, identity), report);
}
