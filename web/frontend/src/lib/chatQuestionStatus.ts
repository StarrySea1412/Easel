const terminalQuestionStatuses = new Set([
  'answered', 'resolved', 'expired', 'cancelled', 'canceled', 'not_found',
]);

export function shouldKeepChatQuestion(status?: string): boolean {
  return !status || !terminalQuestionStatuses.has(status.toLowerCase());
}
