import { useEffect, useRef, useState } from 'react';
import { fetchSkills } from '../lib/api';
import {
  readSelectedSkills, writeSelectedSkills, readSkillRequirements, writeSkillRequirements,
  requirementsForSelection, MAX_SKILL_REQUIREMENT_LENGTH, MAX_SKILL_REQUIREMENTS_TOTAL,
  MAX_SKILL_REQUIREMENTS_COUNT,
} from '../lib/selectedSkills';

/** The caller remounts on scope changes, so edits always belong to one draft. */
export function useComposerSkills(scope: string, requirementScope: 'conversation' | 'creation' = 'conversation') {
  const [selectedSkills, updateSelectedSkills] = useState(() => readSelectedSkills(scope));
  const selectedSkillsRef = useRef(selectedSkills);
  const [skillRequirements, updateSkillRequirements] = useState(() => readSkillRequirements(scope, selectedSkills));
  const skillRequirementsRef = useRef(skillRequirements);
  const revision = useRef(0);
  const [storageNotice, setStorageNotice] = useState('');
  const [catalog, setCatalog] = useState<Set<string> | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const scopeLabel = requirementScope === 'creation' ? '本次创作' : '本会话';

  useEffect(() => {
    let stale = false;
    fetchSkills().then(skills => {
      if (stale) return;
      if (!Array.isArray(skills)) throw new Error('Invalid skill catalogue');
      // Directory responses describe availability; only user edits change picks.
      setCatalog(new Set(skills.map(skill => skill.name)));
      setCatalogFailed(false);
    }).catch(() => { if (!stale) setCatalogFailed(true); });
    return () => { stale = true; };
  }, [scope]);

  const replaceSkills = (next: string[]) => {
    selectedSkillsRef.current = next;
    updateSelectedSkills(next);
    const kept = requirementsForSelection(skillRequirementsRef.current, next);
    skillRequirementsRef.current = kept;
    updateSkillRequirements(kept);
    revision.current += 1;
    const selectedSaved = writeSelectedSkills(scope, next);
    const requirementsSaved = writeSkillRequirements(scope, kept);
    const saved = selectedSaved && requirementsSaved;
    setStorageNotice(saved ? '' : '浏览器未能保存技能选择或补充要求，刷新后需要重新设置。');
    return saved;
  };

  const saveSkillRequirement = (skill: string, text: string) => {
    if (!selectedSkillsRef.current.includes(skill)) return false;
    const trimmed = text.trim();
    const next = { ...skillRequirementsRef.current, [skill]: trimmed };
    if (!trimmed) delete next[skill];
    if (trimmed.length > MAX_SKILL_REQUIREMENT_LENGTH || Object.keys(next).length > MAX_SKILL_REQUIREMENTS_COUNT
      || Object.values(next).reduce((total, value) => total + value.length, 0) > MAX_SKILL_REQUIREMENTS_TOTAL) {
      setStorageNotice(`每个技能补充要求最多 2000 字；${scopeLabel}最多 20 项，总共 10000 字。`);
      return false;
    }
    // Cancel or failed persistence must never activate a partially edited note.
    if (!writeSkillRequirements(scope, next)) {
      setStorageNotice(`浏览器未能保存${scopeLabel}补充要求，原要求仍然生效。请重试。`);
      return false;
    }
    skillRequirementsRef.current = next;
    updateSkillRequirements(next);
    revision.current += 1;
    setStorageNotice('');
    return true;
  };

  return {
    selectedSkills, skillRequirements, requirementScope, saveSkillRequirement,
    notice: storageNotice || (catalogFailed ? '技能列表暂时无法读取，已保留当前选择。'
      : catalog && selectedSkills.some(name => !catalog.has(name)) ? '部分已选技能未出现在当前列表中，已保留选择；发送前请确认技能是否可用。' : ''),
    selectSkill: (skill: string) => replaceSkills(selectedSkillsRef.current.includes(skill)
      ? selectedSkillsRef.current : [...selectedSkillsRef.current, skill]),
    removeSkill: (skill: string) => replaceSkills(selectedSkillsRef.current.filter(name => name !== skill)),
    getSnapshot: () => ({
      selectedSkills: [...selectedSkillsRef.current],
      skillRequirements: requirementsForSelection(skillRequirementsRef.current, selectedSkillsRef.current),
      revision: revision.current,
    }),
    /** null means the accepted send no longer owns the current selection. */
    clear: (acceptedRevision: number): boolean | null => revision.current === acceptedRevision ? replaceSkills([]) : null,
  };
}

export type ComposerSkills = ReturnType<typeof useComposerSkills>;
