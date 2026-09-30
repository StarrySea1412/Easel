export function readSelectedSkills(sessionId: string): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`easel:selected-skills:${sessionId}`) || '[]');
    return Array.isArray(saved) ? [...new Set(saved.filter((item): item is string => typeof item === 'string' && /^[a-zA-Z0-9_-]+$/.test(item)))] : [];
  } catch { return []; }
}
