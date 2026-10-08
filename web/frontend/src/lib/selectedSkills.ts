function normalizeSelectedSkills(saved: unknown): string[] {
  return Array.isArray(saved) ? [...new Set(saved.filter((item): item is string => typeof item === 'string' && /^(?!\.)[a-zA-Z0-9_.-]{1,120}$/.test(item)))] : [];
}

export type SkillRequirements = Record<string, string>;
export const MAX_SKILL_REQUIREMENT_LENGTH = 2000;
export const MAX_SKILL_REQUIREMENTS_TOTAL = 10000;
export const MAX_SKILL_REQUIREMENTS_COUNT = 20;

export function requirementsForSelection(value: unknown, selectedSkills: readonly string[]): SkillRequirements {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const selected = new Set(normalizeSelectedSkills(selectedSkills));
  let total = 0;
  const entries: [string, string][] = [];
  for (const [name, raw] of Object.entries(value)) {
    if (!selected.has(name) || typeof raw !== 'string') continue;
    const text = raw.trim();
    if (!text || text.length > MAX_SKILL_REQUIREMENT_LENGTH || entries.length >= MAX_SKILL_REQUIREMENTS_COUNT
      || total + text.length > MAX_SKILL_REQUIREMENTS_TOTAL) continue;
    entries.push([name, text]); total += text.length;
  }
  return Object.fromEntries(entries);
}

export function readSelectedSkills(sessionId: string): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`easel:selected-skills:${sessionId}`) || '[]');
    return normalizeSelectedSkills(saved);
  } catch { return []; }
}

/** Persist explicit user edits only; reading a partial skill catalogue is not an edit. */
export function writeSelectedSkills(sessionId: string, skills: string[]): boolean {
  try {
    localStorage.setItem(`easel:selected-skills:${sessionId}`, JSON.stringify(normalizeSelectedSkills(skills)));
    return true;
  } catch { return false; }
}

export function readSkillRequirements(sessionId: string, selectedSkills = readSelectedSkills(sessionId)): SkillRequirements {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`easel:skill-requirements:${sessionId}`) || '{}');
    return requirementsForSelection(value, selectedSkills);
  } catch { return {}; }
}

export function writeSkillRequirements(sessionId: string, requirements: SkillRequirements): boolean {
  try {
    localStorage.setItem(`easel:skill-requirements:${sessionId}`, JSON.stringify(requirements));
    return true;
  } catch { return false; }
}
