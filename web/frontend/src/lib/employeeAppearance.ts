import { useSyncExternalStore } from 'react';
import { readLocalValue, writeLocalValue, reportLocalPersistenceFailure } from './localPersistence';

export const EMPLOYEE_APPEARANCE_IDS = ['coordinator', 'researcher', 'designer', 'writer', 'tester', 'reviewer', 'generic'] as const;
export type EmployeeAppearanceId = typeof EMPLOYEE_APPEARANCE_IDS[number];
export const EMPLOYEE_SPECIES = ['cat', 'rabbit', 'fox', 'bear'] as const;
export type EmployeeSpecies = typeof EMPLOYEE_SPECIES[number];
export interface EmployeeAppearance {
  id: EmployeeAppearanceId;
  name: string;
  role: string;
  species: EmployeeSpecies;
  shirtColor: string;
  hairColor: string;
  skinColor: string;
  hairStyle: 'short' | 'long' | 'bun';
  accessory: 'none' | 'glasses' | 'headset';
}

export const DEFAULT_EMPLOYEE_APPEARANCES: readonly EmployeeAppearance[] = Object.freeze([
  { id: 'coordinator', name: 'Easel', role: '任务协调', species: 'cat', shirtColor: '#658C80', hairColor: '#3A302D', skinColor: '#E5B995', hairStyle: 'short', accessory: 'headset' },
  { id: 'researcher', name: 'Scout', role: '资料研究', species: 'fox', shirtColor: '#7B96B1', hairColor: '#46382D', skinColor: '#D9A780', hairStyle: 'short', accessory: 'glasses' },
  { id: 'designer', name: 'Pixel', role: '视觉设计', species: 'rabbit', shirtColor: '#BD967A', hairColor: '#59432F', skinColor: '#F0CBAA', hairStyle: 'bun', accessory: 'none' },
  { id: 'writer', name: 'Quill', role: '文案创作', species: 'rabbit', shirtColor: '#9B89AD', hairColor: '#302D32', skinColor: '#B98564', hairStyle: 'long', accessory: 'glasses' },
  { id: 'tester', name: 'Check', role: '质量检查', species: 'bear', shirtColor: '#9DAD82', hairColor: '#67503D', skinColor: '#ECC6A1', hairStyle: 'short', accessory: 'headset' },
  { id: 'reviewer', name: 'Sage', role: '审阅整合', species: 'fox', shirtColor: '#B69885', hairColor: '#6D655D', skinColor: '#CB9874', hairStyle: 'bun', accessory: 'glasses' },
  { id: 'generic', name: '协作员工', role: '协作 Agent', species: 'cat', shirtColor: '#8E9B9D', hairColor: '#3A3531', skinColor: '#D8AD8C', hairStyle: 'short', accessory: 'none' },
].map(card => Object.freeze(card as EmployeeAppearance)));

const APPEARANCE_KEY = 'easel_employee_appearances';
const ASSIGNMENT_KEY = 'easel_employee_assignments';
const blocked = new Set<string>();
const listeners = new Set<() => void>();
let appearances: readonly EmployeeAppearance[] | undefined;
let assignments: Readonly<Record<string, EmployeeAppearanceId>> | undefined;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function shortText(value: unknown, label: string, max: number) {
  const hasControlCharacter = typeof value === 'string' && Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > max || hasControlCharacter) {
    throw new Error(`${label}须为 1–${max} 个字符，不能包含控制字符。`);
  }
  return value.trim();
}
function color(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${label}须为 #RRGGBB 形式的颜色。`);
  return value.toUpperCase();
}
function cardId(value: unknown): EmployeeAppearanceId {
  if (typeof value !== 'string' || !EMPLOYEE_APPEARANCE_IDS.includes(value as EmployeeAppearanceId)) throw new Error('员工角色卡标识无效。');
  return value as EmployeeAppearanceId;
}

/** Reject an incomplete/corrupt configuration instead of silently discarding cards. */
export function validateEmployeeAppearances(value: unknown): readonly EmployeeAppearance[] {
  if (!Array.isArray(value) || value.length !== EMPLOYEE_APPEARANCE_IDS.length) throw new Error('员工配置须包含完整的 7 张角色卡。');
  const byId = new Map<EmployeeAppearanceId, EmployeeAppearance>();
  for (const item of value) {
    if (!record(item)) throw new Error('员工角色卡格式无效。');
    const id = cardId(item.id);
    if (byId.has(id)) throw new Error('员工角色卡标识不能重复。');
    // Version-one human cards used these same color/style keys. Add the new
    // species only when absent, preserving every existing customization.
    const species = item.species === undefined ? DEFAULT_EMPLOYEE_APPEARANCES.find(card => card.id === id)!.species : item.species;
    if (typeof species !== 'string' || !EMPLOYEE_SPECIES.includes(species as EmployeeSpecies)) throw new Error('请选择小猫、兔子、狐狸或小熊。');
    if (typeof item.hairStyle !== 'string' || !['short', 'long', 'bun'].includes(item.hairStyle)) throw new Error('请选择短发、长发或发髻。');
    if (typeof item.accessory !== 'string' || !['none', 'glasses', 'headset'].includes(item.accessory)) throw new Error('请选择无配饰、眼镜或耳机。');
    byId.set(id, Object.freeze({
      id, name: shortText(item.name, '显示名', 24), role: shortText(item.role, '显示岗位', 40), species: species as EmployeeSpecies,
      shirtColor: color(item.shirtColor, '服装颜色'), hairColor: color(item.hairColor, '点缀色'), skinColor: color(item.skinColor, '毛色'),
      hairStyle: item.hairStyle as EmployeeAppearance['hairStyle'], accessory: item.accessory as EmployeeAppearance['accessory'],
    }));
  }
  return Object.freeze(EMPLOYEE_APPEARANCE_IDS.map(id => byId.get(id)!));
}

function agentIdentity(value: unknown): string {
  const id = shortText(value, 'Agent 标识', 160);
  if (['__proto__', 'constructor', 'prototype'].includes(id) || id !== value) throw new Error('Agent 标识无效。');
  return id;
}
function validateAssignments(value: unknown): Readonly<Record<string, EmployeeAppearanceId>> {
  if (!record(value) || Object.keys(value).length > 256) throw new Error('员工绑定格式无效，最多支持 256 个 Agent。');
  const result: Record<string, EmployeeAppearanceId> = Object.create(null);
  for (const [key, target] of Object.entries(value)) result[agentIdentity(key)] = cardId(target);
  return Object.freeze(result);
}

function readProtected<T>(key: string, decode: (value: unknown) => T, fallback: T): T {
  const stored = readLocalValue(key);
  if (!stored.ok) { blocked.add(key); return fallback; }
  if (stored.value === null) return fallback;
  try {
    const envelope: unknown = JSON.parse(stored.value);
    if (!record(envelope) || envelope.version !== 1) throw new Error('Unsupported employee configuration.');
    return decode(envelope.value);
  } catch {
    blocked.add(key);
    reportLocalPersistenceFailure(key, 'read', 'invalid');
    return fallback;
  }
}
function persist(key: string, value: unknown): boolean {
  if (blocked.has(key)) {
    reportLocalPersistenceFailure(key, 'write', 'unreadable');
    return false;
  }
  return writeLocalValue(key, JSON.stringify({ version: 1, value }));
}
function notify() {
  for (const listener of listeners) {
    try { listener(); } catch { /* One observer must not turn a successful save into a failure. */ }
  }
}

export function readEmployeeAppearances(): readonly EmployeeAppearance[] {
  return appearances ??= readProtected(APPEARANCE_KEY, validateEmployeeAppearances, DEFAULT_EMPLOYEE_APPEARANCES);
}
export function readEmployeeAssignments(): Readonly<Record<string, EmployeeAppearanceId>> {
  return assignments ??= readProtected(ASSIGNMENT_KEY, validateAssignments, Object.freeze(Object.create(null)));
}
export function subscribeEmployeeAppearances(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Returns false when applied in this window but not durably saved. */
export function saveEmployeeAppearances(cards: readonly EmployeeAppearance[]): boolean {
  const next = validateEmployeeAppearances(cards);
  readEmployeeAppearances(); // Establish protection before any write, even without a prior read.
  appearances = next;
  const saved = persist(APPEARANCE_KEY, next);
  notify();
  return saved;
}
export function resetEmployeeAppearances(): boolean { return saveEmployeeAppearances(DEFAULT_EMPLOYEE_APPEARANCES); }
/** Bind only after an explicit user choice; callers must not infer a live Agent's role. */
export function assignEmployeeAppearance(agentId: string, appearanceId: EmployeeAppearanceId): boolean {
  const id = agentIdentity(agentId), target = cardId(appearanceId);
  const next = validateAssignments({ ...readEmployeeAssignments(), [id]: target });
  assignments = next;
  const saved = persist(ASSIGNMENT_KEY, next);
  notify();
  return saved;
}
export function useEmployeeAppearances() {
  return useSyncExternalStore(subscribeEmployeeAppearances, readEmployeeAppearances, () => DEFAULT_EMPLOYEE_APPEARANCES);
}
const EMPTY_ASSIGNMENTS = Object.freeze(Object.create(null)) as Readonly<Record<string, EmployeeAppearanceId>>;
export function useEmployeeAssignments() {
  return useSyncExternalStore(subscribeEmployeeAppearances, readEmployeeAssignments, () => EMPTY_ASSIGNMENTS);
}
