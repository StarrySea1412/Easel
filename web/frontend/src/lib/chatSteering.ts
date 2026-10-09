import { getChatQueue, pauseChatQueue, dispatchSelectedQueuedMessage, type QueuedMessage } from './chatQueue';

const pending = new Set<string>();
/** Interrupt and continue with the queued snapshot only after the current run stops. */
export async function steerQueuedMessage(session: string, id: string, stop: () => Promise<boolean>, send: (item: QueuedMessage) => boolean): Promise<boolean> {
  if (pending.has(session)) return false;
  const item = getChatQueue(session).items.find(row => row.id === id);
  if (!item || item.missingAttachments.length) return false;
  pending.add(session); pauseChatQueue(session);
  try {
    if (!await stop()) return false;
    // Edits or removal while stopping must not silently change the approved message.
    if (getChatQueue(session).items.find(row => row.id === id) !== item) return false;
    return dispatchSelectedQueuedMessage(session, id, send);
  } finally { pending.delete(session); }
}
