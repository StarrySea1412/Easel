// Presentation only: keep the full event stream in execution records.
const transportNotice = /^(?:请求已(?:收到|接收)，等待运行器确认|已进入运行器，等待模型事件)[。！!]?$/;
const silenceNotice = /^(?:已\s*)?\d+\s*秒未收到新事件[；;，,]/;
const questionNotice = /^等待你回答问题[，,]请查看输入框上方的选项卡[。.]?$/;

export function progressText(value: string): string {
  const text = value.trim();
  if (transportNotice.test(text)) return '';
  if (silenceNotice.test(text)) return '等待进度更新';
  if (questionNotice.test(text)) return '等待你回答';
  return text;
}

export function progressEntries(values: string[]): string[] {
  // Repeated receipts are not additional work. Keep the latest occurrence order.
  const unique = new Set<string>();
  for (const value of [...values].reverse()) {
    const text = value.trim();
    if (!text || transportNotice.test(text) || silenceNotice.test(text) || questionNotice.test(text)) continue;
    unique.add(text);
  }
  return [...unique].reverse();
}
