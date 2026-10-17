import { recordEvent, type NoticeTarget } from './eventNotifications';

export type ToastTone = 'success' | 'info' | 'error';
export interface ToastNotice { message: string; tone: ToastTone; action?: { label: string; run: () => void } }
export const TOAST_EVENT = 'easel:toast';

export function showToast(message: string, tone: ToastTone = 'info', action?: ToastNotice['action'], id?: string, target?: NoticeTarget): void {
  // Durable events (run outcomes, publish receipts, questions) carry a stable id
  // and a jump target; plain confirmations stay transient and never fill the
  // notification inbox (Apple HIG: no duplicate noise in Notification Center).
  const durable = id !== undefined;
  // Local saves may run inside React state updaters; notify after rendering.
  queueMicrotask(() => {
    if (durable && !recordEvent(message, tone, action, id, target)) return;
    window.dispatchEvent(new window.CustomEvent<ToastNotice>(TOAST_EVENT, { detail: { message, tone, action } }));
  });
}
