/**
 * Live-view transport: a JPEG frame stream plus batched pointer/keyboard input.
 * Both stay on the existing session-owned browser API; no page script is injected.
 */
export type LiveInputEvent =
  | { type: 'click'; x: number; y: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'wheel'; deltaY: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string };

function basePath(): string {
  return window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
}

function tabPath(sessionId: string, tabId: string, suffix: string): string {
  return `${basePath()}/api/browser/sessions/${encodeURIComponent(sessionId)}/tabs/${encodeURIComponent(tabId)}/${suffix}`;
}

export function browserCastUrl(sessionId: string, tabId: string): string {
  return tabPath(sessionId, tabId, 'cast');
}

export interface LiveInputChannel {
  send(event: LiveInputEvent): void;
  onError(listener: (message: string) => void): () => void;
  close(): void;
}

/** Coalesce fast pointer/keyboard events into small batches (one request in flight). */
export function createLiveInput(sessionId: string, tabId: string, fetcher: typeof fetch = (...args) => fetch(...args)): LiveInputChannel {
  let queue: LiveInputEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let closed = false;
  const listeners = new Set<(message: string) => void>();

  const fail = (message: string) => { for (const listener of listeners) listener(message); };

  const flush = async () => {
    timer = null;
    if (inFlight || closed || !queue.length) return;
    const batch = queue.splice(0, 20);
    inFlight = true;
    try {
      const response = await fetcher(tabPath(sessionId, tabId, 'input'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch }), cache: 'no-store',
      });
      if (!response.ok) {
        let detail = '';
        try {
          const data = await response.json();
          detail = typeof data?.detail === 'string' ? data.detail : '';
        } catch { /* non-JSON errors still surface below */ }
        fail(detail || '实时输入未被接受，请重新观察页面后再试。');
      }
    } catch {
      fail('实时输入连接中断，请重新连接浏览器。');
    } finally {
      inFlight = false;
      if (!closed && queue.length) timer = setTimeout(() => void flush(), 40);
    }
  };

  const schedule = () => {
    if (!closed && !inFlight && !timer) timer = setTimeout(() => void flush(), 40);
  };

  return {
    send(event) {
      if (closed) return;
      queue.push(event);
      if (queue.length > 60) queue.splice(0, queue.length - 60);
      schedule();
    },
    onError(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {
      closed = true;
      queue = [];
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
