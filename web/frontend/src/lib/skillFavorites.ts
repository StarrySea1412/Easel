import { useSyncExternalStore } from 'react';
import { readLocalValue, writeLocalValue } from './localPersistence';
import type { ClawHubSkill } from './api';

export const SKILL_FAVORITES_KEY = 'easel:skill-favorites';
export const SKILL_FAVORITES_LIMIT = 100;

/** Public ClawHub metadata only — favorites never install or run anything. */
export interface SkillFavorite {
  id: string;
  slug: string;
  displayName: string;
  ownerHandle: string | null;
  summary: string;
  version: string | null;
  updatedAt: number | null;
  canonicalUrl: string;
  savedAt: number;
}

function sanitizeText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function readOne(value: unknown): SkillFavorite | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = sanitizeText(raw.id, 240), slug = sanitizeText(raw.slug, 120), displayName = sanitizeText(raw.displayName, 200);
  if (!id || !slug || !displayName) return null;
  return {
    id, slug, displayName,
    ownerHandle: sanitizeText(raw.ownerHandle, 120) || null,
    summary: sanitizeText(raw.summary, 500),
    version: sanitizeText(raw.version, 60) || null,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
    canonicalUrl: sanitizeText(raw.canonicalUrl, 500),
    savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : Date.now(),
  };
}

export function favoriteFromSkill(skill: ClawHubSkill, savedAt = Date.now()): SkillFavorite {
  return readOne({ ...skill, savedAt })!;
}

/** Rebuilds the public skill shape so a favorite can open the shared detail view. */
export function favoriteAsSkill(favorite: SkillFavorite): ClawHubSkill {
  return { id: favorite.id, source: 'clawhub', slug: favorite.slug, ownerHandle: favorite.ownerHandle, displayName: favorite.displayName,
    summary: favorite.summary, version: favorite.version, updatedAt: favorite.updatedAt, canonicalUrl: favorite.canonicalUrl, installationState: 'not_checked' };
}

function load(): SkillFavorite[] {
  const { ok, value } = readLocalValue(SKILL_FAVORITES_KEY);
  if (!ok || !value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(readOne).filter((item): item is SkillFavorite => item !== null).slice(0, SKILL_FAVORITES_LIMIT);
  } catch { return []; }
}

let favorites: SkillFavorite[] = load();
const listeners = new Set<() => void>();

function emit() { for (const listener of listeners) listener(); }

function commit(next: SkillFavorite[]): boolean {
  if (!writeLocalValue(SKILL_FAVORITES_KEY, JSON.stringify(next))) return false;
  favorites = next;
  emit();
  return true;
}

export function skillFavorites(): SkillFavorite[] { return favorites; }

export function isSkillFavorite(id: string): boolean { return favorites.some(item => item.id === id); }

/** Adds or removes one favorite; false means the local save failed and nothing changed. */
export function toggleSkillFavorite(skill: ClawHubSkill): boolean {
  const exists = isSkillFavorite(skill.id);
  if (!exists && favorites.length >= SKILL_FAVORITES_LIMIT) return false;
  const next = exists
    ? favorites.filter(item => item.id !== skill.id)
    : [favoriteFromSkill(skill), ...favorites];
  return commit(next);
}

export function removeSkillFavorite(id: string): boolean {
  const next = favorites.filter(item => item.id !== id);
  return next.length === favorites.length ? true : commit(next);
}

export function useSkillFavorites(): SkillFavorite[] {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, skillFavorites, skillFavorites);
}
