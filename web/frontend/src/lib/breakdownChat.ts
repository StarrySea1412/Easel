import { createSession, loadSessions, saveSessions } from './store';
import type { ChatSession } from './store';
import type { ThinkingLevel } from './api';
import { buildBreakdownReportPrompt, ideaTitleFromReport } from './breakdownReport';
import { addBreakdownRecord, clearActiveRun, loadActiveRun, loadBreakdownHistory } from './breakdownStore';
import type { ActiveRun } from './breakdownStore';

export function createBreakdownSession(material: string, persona?: string, modelRef?: string, thinkingLevel?: ThinkingLevel, base?: ChatSession): ChatSession {
  const session = base ?? createSession(persona);
  const turnId = `${session.id}-breakdown-${Date.now().toString(36)}`;
  // With a base the breakdown merges into the selected conversation: the
  // existing title and engine stay, only the turn is appended.
  return { ...session, engine: base ? session.engine : 'openclaw',
    title: base ? session.title : `拆解 · ${material.trim().split(/\r?\n/)[0].slice(0, 28)}`,
    pendingTurnId: turnId,
    messages: [...session.messages, { role: 'user', kind: 'breakdown', content: material, agentContent: buildBreakdownReportPrompt(material, persona),
      requestedModelRef: modelRef, requestedThinkingLevel: thinkingLevel, startedAt: Date.now() }] };
}

/** Adopt the existing identity and turn. Never send a replacement request. */
export function adoptBreakdownRun(sessions: ChatSession[], run: ActiveRun): ChatSession[] {
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(run.sessionId) || !/^[A-Za-z0-9_.-]{1,180}$/.test(run.turnId)
    || !run.material.trim() || !Number.isFinite(run.startedAt) || run.startedAt <= 0
    || sessions.some(session => session.id === run.sessionId)) return sessions;
  const session = createBreakdownSession(run.material);
  return [{ ...session, id: run.sessionId, created: run.startedAt, pendingTurnId: run.turnId,
    messages: session.messages.map(message => ({ ...message, startedAt: run.startedAt })) }, ...sessions];
}

export function loadSessionsWithBreakdown(): ChatSession[] {
  const sessions = loadSessions();
  const run = loadActiveRun();
  if (!run) return sessions;
  const next = adoptBreakdownRun(sessions, run);
  return next !== sessions && saveSessions(next) ? next : sessions;
}

export function rememberBreakdownReport(session: ChatSession | undefined, report: string, turnId?: string): void {
  const material = session?.messages.at(-1);
  if (!session || material?.role !== 'user' || material.kind !== 'breakdown' || !report.trim()) return;
  addBreakdownRecord(loadBreakdownHistory(), { id: `${session.id}:${turnId || session.pendingTurnId || 'report'}`,
    title: ideaTitleFromReport(report), at: Date.now(), material: material.content, report });
  const legacy = loadActiveRun();
  if (legacy?.sessionId === session.id && legacy.turnId === (turnId || session.pendingTurnId)) clearActiveRun();
}
