/** Raw recovery evidence is kept separate from portable, readable backups. */
export interface RawConversationStorageBackup {
  format: 'easel-raw-conversation-storage';
  version: 1;
  exportedAt: string;
  entries: { key: string; value: string | null; readable: boolean }[];
}

const CONVERSATION_KEYS = ['easel_sessions', 'easel-sessions', 'postcraft_sessions'] as const;

/** Read only the conversation allowlist. Never enumerate credentials or mutate protection status. */
export function exportRawConversationStorage(): RawConversationStorageBackup {
  const entries = CONVERSATION_KEYS.map(key => {
    try { return { key, value: localStorage.getItem(key), readable: true }; }
    catch { return { key, value: null, readable: false }; }
  });
  if (entries.every(entry => !entry.readable)) {
    throw new Error('浏览器阻止了原始会话数据读取。请先导出当前页内会话，原始数据保持不变。');
  }
  return { format: 'easel-raw-conversation-storage', version: 1, exportedAt: new Date().toISOString(), entries };
}
