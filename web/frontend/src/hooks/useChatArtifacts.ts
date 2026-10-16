import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeArtifacts, decodeImageJobs, decodeExternalMessages } from '../lib/chatArtifacts';
import type { ChatArtifact, ChatImageJob, ExternalChatMessage } from '../lib/chatArtifacts';

export function useChatArtifacts(sessionId: string, enabled: boolean, streaming: boolean) {
  const [state, setState] = useState<{ session: string; items: ChatArtifact[]; jobs: ChatImageJob[]; messages: ExternalChatMessage[]; note: string }>({ session: '', items: [], jobs: [], messages: [], note: '' });
  const [revision, setRevision] = useState(0);
  const current = useRef(sessionId); current.current = sessionId;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let reading = false;
    const read = async () => {
      if (reading || controller.signal.aborted || document.visibilityState === 'hidden') return;
      reading = true;
      try {
        const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
        const response = await fetch(`${base}/api/chat/artifacts/${encodeURIComponent(sessionId)}`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (data.sessionId !== sessionId || controller.signal.aborted) return;
        setState(old => ({ session: sessionId, items: decodeArtifacts(data.artifacts, sessionId).map(item => {
          const previous = old.session === sessionId ? old.items.find(a => a.id === item.id && a.turnId === item.turnId) : undefined;
          return previous && previous.revision > item.revision ? previous : item;
        }), jobs: decodeImageJobs(data.jobs, sessionId), messages: decodeExternalMessages(data.messages), note: Array.isArray(data.warnings) ? data.warnings.filter((v: unknown) => typeof v === 'string').join(' ') : '' }));
      } catch {
        if (!controller.signal.aborted) setState(old => ({ session: sessionId, items: old.session === sessionId ? old.items : [], jobs: old.session === sessionId ? old.jobs : [], messages: old.session === sessionId ? old.messages : [], note: '产物暂时无法读取，已显示的文件保留。' }));
      } finally { reading = false; }
    };
    const poll = async () => { await read(); if (!controller.signal.aborted) timer = setTimeout(poll, streaming ? 1800 : 8000); };
    const focus = () => { void read(); };
    void poll(); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [sessionId, enabled, streaming, revision]);
  const updated = useCallback((value: ChatArtifact) => {
    if (current.current !== value.sessionId) return;
    setState(old => old.session !== value.sessionId ? old : { ...old, items: old.items.map(item => item.id === value.id && value.revision >= item.revision ? { ...item, ...value, turnId: item.turnId } : item) });
  }, []);
  return { messages: enabled && state.session === sessionId ? state.messages : [], jobs: enabled && state.session === sessionId ? state.jobs : [], items: enabled && state.session === sessionId ? state.items : [], note: enabled && state.session === sessionId ? state.note : '', retry: () => setRevision(x => x + 1), updated };
}
