import { useEffect, useState } from 'react';
import type { ChatSession } from '../lib/store';
import { fetchShareAppends, pendingShareAppends, type ShareAppend } from '../lib/conversationShare';
import { showToast } from '../lib/toast';

// ChatPage remounts on conversation switches; keep toast deduplication for this tab.
const announced = new Set<string>();

/** Read-only discovery; importing messages still requires the user's click. */
export function useShareAppends(session: ChatSession) {
  const token = session.importedFromBackup ? undefined : session.share?.token;
  const [state, setState] = useState<{ token?: string; appends: ShareAppend[] }>({ appends: [] });
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let reading = false;
    const read = async () => {
      if (reading || controller.signal.aborted || document.visibilityState === 'hidden') return;
      reading = true;
      const request = new AbortController();
      const cancel = () => request.abort();
      controller.signal.addEventListener('abort', cancel, { once: true });
      const timeout = setTimeout(cancel, 10000);
      try {
        const result = await fetchShareAppends(token, request.signal);
        if (!request.signal.aborted) setState({ token, appends: result.appends });
      } catch { /* Preserve discovered entries; explicit loading reports errors. */ }
      finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', cancel); reading = false; }
    };
    const focus = () => { void read(); };
    void read();
    const timer = setInterval(focus, 15000);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      controller.abort(); clearInterval(timer);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [session.id, token]);
  const pending = token && state.token === token ? pendingShareAppends(session, state.appends) : [];
  const signature = pending.map(append => append.appendId).sort().join(',');
  useEffect(() => {
    if (!token || !signature) return;
    const keys = signature.split(',').map(id => `${token}:${id}`);
    if (keys.every(key => announced.has(key))) return;
    keys.forEach(key => announced.add(key));
    while (announced.size > 1000) announced.delete(announced.values().next().value!);
    showToast('有新的接管内容，点击「加载接管内容」查看', 'info');
  }, [token, signature]);
  return pending.reduce((count, append) => count + append.messages.filter(message => message.content?.trim()).length, 0);
}
