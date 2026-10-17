/** Notification copy hygiene: bounded subjects instead of raw titles and URLs. */
export function noticeSubject(value: string | undefined, fallback: string): string {
  const text = (value || '')
    .replace(/https?:\/\/[^\s，。；、）)】」>]+/gi, match => {
      try { return new URL(match).hostname.replace(/^www\./i, ''); } catch { return '链接'; }
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  return text.length > 24 ? text.slice(0, 24) + '…' : text;
}

// Confirmations from older builds that persisted every toast. New builds keep
// this class transient, so these records are safe to offer for one-tap cleanup.
const LEGACY_TRANSIENT_PREFIXES = [
  '已选择思考强度', '已引用到输入框', '已保存对话标题', '已置顶对话', '已取消置顶',
  '已归档对话', '已恢复对话', '已调整消息顺序', '消息顺序未能保存', '已暂停排队', '已继续排队',
  '已加入日历', '已保存 ', '已删除画像', '已跳过 ', '强度已在本页修改',
  '标题已在本页修改', '置顶状态已在本页修改', '归档状态已在本页修改',
];

export const isLegacyTransientNotice = (message: string): boolean =>
  LEGACY_TRANSIENT_PREFIXES.some(prefix => message.startsWith(prefix));
