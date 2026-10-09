function normalizeSelectedSkills(saved: unknown): string[] {
  return Array.isArray(saved) ? [...new Set(saved.filter((item): item is string => typeof item === 'string' && /^(?!\.)[a-zA-Z0-9_.-]{1,120}$/.test(item)))] : [];
}

export type SkillRequirements = Record<string, string>;
export const MAX_SKILL_REQUIREMENT_LENGTH = 2000;
export const MAX_SKILL_REQUIREMENTS_TOTAL = 10000;
export const MAX_SKILL_REQUIREMENTS_COUNT = 20;

export interface ComposerSkillState {
  selectedSkills: string[];
  skillRequirements: SkillRequirements;
  readable: boolean;
}

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

function readStoredSelection(sessionId: string): string[] {
  const raw = localStorage.getItem(`easel:selected-skills:${sessionId}`);
  const saved: unknown = JSON.parse(raw === null ? '[]' : raw);
  if (!Array.isArray(saved)) throw new Error('Invalid saved skill selection');
  return normalizeSelectedSkills(saved);
}

function readStoredRequirements(sessionId: string, selectedSkills: string[]): SkillRequirements {
  const raw = localStorage.getItem(`easel:skill-requirements:${sessionId}`);
  const saved: unknown = JSON.parse(raw === null ? '{}' : raw);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid saved skill requirements');
  return requirementsForSelection(saved, selectedSkills);
}

/** A failed read is not an empty selection and must not authorize a replacement. */
export function readComposerSkillState(sessionId: string): ComposerSkillState {
  let selectedSkills: string[] = [];
  try {
    selectedSkills = readStoredSelection(sessionId);
    return { selectedSkills, skillRequirements: readStoredRequirements(sessionId, selectedSkills), readable: true };
  } catch { return { selectedSkills, skillRequirements: {}, readable: false }; }
}

export function readSelectedSkills(sessionId: string): string[] {
  try { return readStoredSelection(sessionId); } catch { return []; }
}

/** Persist explicit user edits only; reading a partial skill catalogue is not an edit. */
export function writeSelectedSkills(sessionId: string, skills: string[]): boolean {
  try {
    localStorage.setItem(`easel:selected-skills:${sessionId}`, JSON.stringify(normalizeSelectedSkills(skills)));
    return true;
  } catch { return false; }
}

export function readSkillRequirements(sessionId: string, selectedSkills = readSelectedSkills(sessionId)): SkillRequirements {
  try { return readStoredRequirements(sessionId, selectedSkills); } catch { return {}; }
}

export function writeSkillRequirements(sessionId: string, requirements: SkillRequirements): boolean {
  try {
    localStorage.setItem(`easel:skill-requirements:${sessionId}`, JSON.stringify(requirements));
    return true;
  } catch { return false; }
}
