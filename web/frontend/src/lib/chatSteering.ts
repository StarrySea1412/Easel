import { getChatQueue, pauseChatQueue, resumeChatQueue, dispatchSelectedQueuedMessage, type QueuedMessage } from './chatQueue';

const pending = new Set<string>();
/** Send one selected snapshot; interrupt first only when a run is active. */
export async function steerQueuedMessage(session: string, id: string, stop: () => Promise<boolean>, send: (item: QueuedMessage) => boolean, hasActiveRun: () => boolean = () => true): Promise<boolean> {
  if (pending.has(session)) return false;
  const item = getChatQueue(session).items.find(row => row.id === id);
  if (!item || item.missingAttachments.length) return false;
  pending.add(session); pauseChatQueue(session);
  const heldQueue = getChatQueue(session);
  try {
    if (hasActiveRun() && !await stop()) {
      pauseChatQueue(session, '引导未完成：当前任务停止尚未确认，所选消息未发送，队列保持暂停。');
      return false;
    }
    // Edits or removal while stopping must not silently change the approved message.
    if (getChatQueue(session).items.find(row => row.id === id) !== item) {
      pauseChatQueue(session, '引导期间消息已编辑或移除，请确认新的内容后操作。');
      return false;
    }
    const unchanged = getChatQueue(session) === heldQueue;
    const accepted = dispatchSelectedQueuedMessage(session, id, send);
    // A successful guidance starts the selected turn, then drains the remaining
    // queue. Edits made while waiting and missing media still require attention.
    if (accepted && unchanged && !getChatQueue(session).error) resumeChatQueue(session);
    return accepted;
  } finally { pending.delete(session); }
}
