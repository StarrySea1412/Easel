export const CHAT_QUOTE_EVENT = 'easel:quote';
export function appendQuotedText(draft: string, text: string): string {
  const quote = text.trim().split(/\r?\n/).map(line => `> ${line}`).join('\n');
  return quote ? `${draft}${draft.trim() ? '\n\n' : ''}${quote}\n\n` : draft;
}
