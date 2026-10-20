/** Domain changes invalidate shared reads; toast history is not application state. */
export const WORKBENCH_EVENT = "easel:workbench-changed";
export type WorkbenchChange = { domain: "analysis" | "models" | "model-health"; platform?: string; accountId?: string; source?: string };
export function publishWorkbenchChange(change: WorkbenchChange): void {
  window.dispatchEvent(new window.CustomEvent(WORKBENCH_EVENT, { detail: change }));
}
export function watchWorkbenchChange(domain: WorkbenchChange["domain"], listener: (change: WorkbenchChange) => void): () => void {
  const receive = (event: Event) => {
    const change = (event as CustomEvent<WorkbenchChange>).detail;
    if (change?.domain === domain) listener(change);
  };
  window.addEventListener(WORKBENCH_EVENT, receive);
  return () => window.removeEventListener(WORKBENCH_EVENT, receive);
}
