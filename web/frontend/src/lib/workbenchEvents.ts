/** Domain changes invalidate shared reads; toast history is not application state. */
export const WORKBENCH_EVENT = "easel:workbench-changed";
export type WorkbenchChange = { domain: "analysis" | "models" | "model-health" | "profile-memory"; platform?: string; accountId?: string; profileId?: string; name?: string; revision?: number; reason?: string; source?: string };
export function publishWorkbenchChange(change: WorkbenchChange): void {
  window.dispatchEvent(new window.CustomEvent(WORKBENCH_EVENT, { detail: change }));
  if (change.domain === 'profile-memory' && typeof window.BroadcastChannel === 'function') {
    const channel = new window.BroadcastChannel('easel:profile-memory');
    channel.postMessage(change); channel.close();
  }
}
export function watchWorkbenchChange(domain: WorkbenchChange["domain"], listener: (change: WorkbenchChange) => void): () => void {
  const receive = (event: Event) => {
    const change = (event as CustomEvent<WorkbenchChange>).detail;
    if (change?.domain === domain) listener(change);
  };
  window.addEventListener(WORKBENCH_EVENT, receive);
  const channel = domain === 'profile-memory' && typeof window.BroadcastChannel === 'function' ? new window.BroadcastChannel('easel:profile-memory') : null;
  if (channel) channel.onmessage = event => { if (event.data?.domain === domain) listener(event.data); };
  return () => { window.removeEventListener(WORKBENCH_EVENT, receive); channel?.close(); };
}
