export type ToastTone = 'success' | 'info' | 'error';
export interface ToastNotice { message: string; tone: ToastTone; action?: { label: string; run: () => void } }
export const TOAST_EVENT = 'easel:toast';

export function showToast(message: string, tone: ToastTone = 'info', action?: ToastNotice['action']): void {
  // Local saves may run inside React state updaters; notify after rendering.
  queueMicrotask(() => {
    window.dispatchEvent(new window.CustomEvent<ToastNotice>(TOAST_EVENT, { detail: { message, tone, action } }));
  });
}
