export function goalCommand(text: string): string | null {
  const match = text.trim().match(/^\/(?:goal|目标)(?:\s+([\s\S]*))?$/i);
  return match ? (match[1] || '').trim() : null;
}

export function suggestsGoal(text: string): boolean {
  return /^\/(?:g(?:o(?:a(?:l)?)?)?|目(?:标)?)?$/i.test(text.trim());
}
