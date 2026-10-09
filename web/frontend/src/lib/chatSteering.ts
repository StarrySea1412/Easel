import { getChatQueue, pauseChatQueue, dispatchSelectedQueuedMessage, type QueuedMessage } from './chatQueue';

const pending = new Set<string>();
/** Interrupt and continue with the queued snapshot only after the current run stops. */
export async function steerQueuedMessage(session: string, id: string, stop: () => Promise<boolean>, send: (item: QueuedMessage) => boolean): Promise<boolean> {
  if (pending.has(session)) return false;
  const item = getChatQueue(session).items.find(row => row.id === id);
  if (!item || item.missingAttachments.length) return false;
  pending.add(session); pauseChatQueue(session);
  try {
    if (!await stop()) {
      pauseChatQueue(session, '引导未完成：当前任务停止尚未确认，所选消息未发送，队列保持暂停。');
      return false;
    }
    // Edits or removal while stopping must not silently change the approved message.
    if (getChatQueue(session).items.find(row => row.id === id) !== item) {
      pauseChatQueue(session, '引导期间消息已编辑或移除，请确认新的内容后操作。');
      return false;
    }
    return dispatchSelectedQueuedMessage(session, id, send);
  } finally { pending.delete(session); }
}
