import { useEffect, useState } from 'react';
import { fetchChatExecution } from '../lib/api';
import { decodeExecution, mergeOperations, type ExecutionSnapshot } from '../lib/execution';
import { collectSources, readPageSources, sourceTurns, type PageObservation } from '../lib/chatSources';
import type { ChatSession } from '../lib/store';

/** Reads only the visible conversation, in bounded batches; never calls a model. */
export function useChatSources(session: ChatSession, active: boolean) {
  const [scope, setScope] = useState({ sessionId: session.id, count: 10 });
  const count = scope.sessionId === session.id ? scope.count : 10;
  const turns = sourceTurns(session);
  const key = JSON.stringify(turns.slice(0, count));
  const [state, setState] = useState<{ sessionId: string; snapshots: Record<string, ExecutionSnapshot>; pages: PageObservation[] }>({ sessionId: '', snapshots: {}, pages: [] });
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const controller = new AbortController();
    const wanted: string[] = JSON.parse(key);
    const update = (value: ExecutionSnapshot) => setState(old => {
      const snapshots = old.sessionId === session.id ? old.snapshots : {};
      const previous = snapshots[value.turnId];
      return { sessionId: session.id, pages: old.sessionId === session.id ? old.pages : [], snapshots: { ...snapshots,
        [value.turnId]: { ...value, operations: mergeOperations(previous?.operations || [], value.operations) } } };
    });
    setState(old => ({ sessionId: session.id, snapshots: old.sessionId === session.id ? old.snapshots : {}, pages: session.importedFromBackup ? [] : readPageSources(session.id) }));
    setLoading(wanted.length > 0); setError('');
    const listen = (event: Event) => {
      const value = decodeExecution((event as CustomEvent).detail);
      if (value?.sessionId === session.id && wanted.includes(value.turnId)) update(value);
    };
    const pages = (event: Event) => {
      const value = (event as CustomEvent<{ sessionId: string }>).detail;
      if (value?.sessionId === session.id && !session.importedFromBackup) setState(old => ({ ...old, pages: readPageSources(session.id) }));
    };
    window.addEventListener('easel:execution', listen); window.addEventListener('easel:page-sources', pages);
    void (async () => {
      const failures: string[] = [];
      // Two readers at most; the existing endpoint bounds each response to 40.
      const queue = [...wanted];
      await Promise.all([0, 1].map(async () => {
        while (queue.length && !controller.signal.aborted) {
          const turn = queue.shift()!;
          let before: number | undefined;
          for (let page = 0; page < 10 && !controller.signal.aborted; page++) {
            const deadline = setTimeout(() => controller.abort(), 15000);
            try {
              const result = await fetchChatExecution(session.id, turn, controller.signal, before);
              if (disposed) return;
              update(result);
              if (result.warnings.length) failures.push(turn);
              if (result.nextBefore == null) break;
              if (result.nextBefore === before || page === 9) { failures.push(turn); break; }
              before = result.nextBefore;
            } catch { if (!disposed) failures.push(turn); break; }
            finally { clearTimeout(deadline); }
          }
        }
      }));
      if (!disposed) { setLoading(false); setError(failures.length ? '部分来源记录暂不可读或未完整加载，已读取的来源仍保留。' : ''); }
    })();
    return () => { disposed = true; controller.abort(); window.removeEventListener('easel:execution', listen); window.removeEventListener('easel:page-sources', pages); };
  }, [session.id, session.importedFromBackup, key, active, revision]);
  const current = state.sessionId === session.id ? state : { snapshots: {} as Record<string, ExecutionSnapshot>, pages: [] };
  const collected = collectSources(turns.slice(0, count).map(turnId => ({ turnId, rows: current.snapshots[turnId]?.operations || [] })), current.pages);
  return { ...collected, loading, error, loadedTurns: Math.min(count, turns.length), totalTurns: turns.length,
    more: count < turns.length, loadMore: () => setScope({ sessionId: session.id, count: count + 10 }), refresh: () => setRevision(value => value + 1) };
}
