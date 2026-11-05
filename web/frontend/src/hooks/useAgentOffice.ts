import { useCallback, useEffect, useState } from 'react';
import { fetchAgentOffice, type OfficeSnapshot } from '../lib/agentOffice';

interface Observation extends OfficeSnapshot { sessionId: string | null; requestedTurn?: string; loading: boolean; error: string | null }
const EMPTY: OfficeSnapshot = { turnId: null, agents: [], events: [], observedAt: null, observedAgentCount: 0, identityScanLimited: false, coverage: '选择会话后，仅展示该会话中已观察到的 Agent。' };

/** Bounded, non-overlapping polling, with identity isolation and stale-result protection. */
export function useAgentOffice(sessionId: string | null, enabled: boolean, requestedTurn?: string, poll = true) {
  const [revision, setRevision] = useState(0);
  const [observation, setObservation] = useState<Observation>({ ...EMPTY, sessionId: null, loading: false, error: null });
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    const read = async () => {
      if (document.hidden || disposed) return;
      request = new AbortController();
      const currentRequest = request;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; currentRequest.abort(); }, 12_000);
      deadline = timeout;
      const same = (previous: Observation) => previous.sessionId === sessionId && previous.requestedTurn === requestedTurn;
      setObservation(previous => ({ ...(same(previous) ? previous : EMPTY), sessionId, requestedTurn, loading: true, error: same(previous) ? previous.error : null }));
      try {
        const snapshot = await fetchAgentOffice(sessionId, currentRequest.signal, requestedTurn);
        if (timedOut) throw new Error('观测请求超时');
        if (!disposed && !currentRequest.signal.aborted) setObservation({ ...snapshot, sessionId, requestedTurn, loading: false, error: null });
      } catch (cause) {
        if (!disposed && (timedOut || !currentRequest.signal.aborted)) setObservation(previous => ({
          ...(same(previous) ? previous : EMPTY), sessionId, requestedTurn, loading: false,
          error: timedOut ? 'Agent 观测请求超时，画面保留上次快照。' : cause instanceof Error ? cause.message : 'Agent 观测更新中断。',
        }));
      } finally {
        clearTimeout(timeout);
        if (deadline === timeout) deadline = undefined;
        if (request === currentRequest) request = undefined;
        if (poll && !disposed && !document.hidden) timer = setTimeout(() => void read(), 2000);
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden && !request) void read();
    };
    document.addEventListener('visibilitychange', visibility);
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      request?.abort();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [sessionId, enabled, revision, requestedTurn, poll]);

  return {
    ...(enabled && sessionId && observation.sessionId === sessionId && observation.requestedTurn === requestedTurn
      ? observation : { ...EMPTY, loading: Boolean(enabled && sessionId), error: null }),
    refresh,
  };
}
