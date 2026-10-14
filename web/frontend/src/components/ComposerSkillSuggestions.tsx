import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComposerSkills } from '../hooks/useComposerSkills';
import { fetchSkillDetail, type SkillDetail } from '../lib/api';
import { recommendSkills } from '../lib/skillRecommendations';
import { skillDependencies } from '../lib/skillDependencies';
import { displayName } from '../lib/skillDisplayNames';
import { showToast } from '../lib/toast';
import SkillTypeIcon from './SkillTypeIcon';
import '../styles/skill-suggestions.css';

export function openSkillConfiguration(skill: SkillDetail) {
  const channel = skillDependencies(skill, skill).find(dependency => dependency.required && dependency.channel)?.channel;
  window.dispatchEvent(new CustomEvent(channel ? 'easel:open-skill-settings' : 'easel:open-skill-configuration', { detail: channel || skill.name }));
}
export function missingSkillSetup(skill?: SkillDetail): string | null {
  if (!skill?.needsApi || skill.apiConfigured !== false) return null;
  const missing = (skill.apiSpec?.providers || []).map(provider => provider.keys.filter(key => key.required && !key.configured));
  const shortest = missing.sort((a, b) => a.length - b.length)[0];
  return shortest?.length ? shortest.map(key => key.label).join('、') : '必需配置';
}
export default function ComposerSkillSuggestions({ text, skills, disabled = false }: { text: string; skills: ComposerSkills; disabled?: boolean }) {
  const [input, setInput] = useState('');
  const [details, setDetails] = useState<Record<string, SkillDetail>>({});
  const notified = useRef(new Set<string>());
  useEffect(() => { const timer = setTimeout(() => setInput(text), 650); return () => clearTimeout(timer); }, [text]);
  const suggestions = useMemo(() => recommendSkills(input, skills.skillList, skills.selectedSkills), [input, skills.skillList, skills.selectedSkills]);
  const relevant = [...new Set([...skills.selectedSkills, ...suggestions.map(skill => skill.name)])].slice(0, 23);
  const key = relevant.join('|');
  useEffect(() => {
    let active = true;
    setDetails({});
    void Promise.allSettled(key ? key.split('|').map(name => fetchSkillDetail(name)) : []).then(results => {
      if (!active) return;
      const next: Record<string, SkillDetail> = {};
      for (const result of results) if (result.status === 'fulfilled') next[result.value.name] = result.value;
      setDetails(next);
    });
    return () => { active = false; };
  }, [key, skills.skillList]);
  const missing = relevant.map(name => details[name]).filter((skill): skill is SkillDetail => Boolean(missingSkillSetup(skill)));
  useEffect(() => {
    if (disabled) return;
    const skill = missing.find(item => !notified.current.has(item.name + ':' + missingSkillSetup(item)));
    if (!skill) return;
    for (const item of missing) notified.current.add(item.name + ':' + missingSkillSetup(item));
    showToast(displayName(skill.name) + '需要配置' + missingSkillSetup(skill) + '。', 'info', { label: '去设置', run: () => openSkillConfiguration(skill) });
  }, [missing, disabled]);
  if (!suggestions.length && !missing.length) return null;
  return <div className="composer-skill-suggestions" aria-label="自动推荐技能">
    {!!suggestions.length && <div className="skill-suggestion-row"><span>可用技能</span>{suggestions.map(skill => <button type="button" key={skill.name} disabled={disabled} title={skill.description} aria-label={'加入' + displayName(skill.name) + '技能'} onClick={() => skills.selectSkill(skill.name)}><SkillTypeIcon name={skill.name}/>{displayName(skill.name)}{missingSkillSetup(details[skill.name]) && <small>需配置</small>}</button>)}</div>}
    {!!missing.length && <div className="skill-setup-prompts" role="status">{missing.map(skill => <span key={skill.name}>{displayName(skill.name)}：需配置{missingSkillSetup(skill)}<button type="button" disabled={disabled} onClick={() => openSkillConfiguration(skill)}>去设置</button></span>)}</div>}
  </div>;
}
