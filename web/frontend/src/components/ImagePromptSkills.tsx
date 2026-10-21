import { useEffect, useState } from 'react';
import { fetchSkills, type SkillItem } from '../lib/api';
import { displayName } from '../lib/skillDisplayNames';
import { IconSkills } from './icons';

export default function ImagePromptSkills({ active, disabled, prompt, ratio, onOpen }: {
  active: boolean; disabled: boolean; prompt: string; ratio: string;
  onOpen: (skill: string, input: string) => boolean;
}) {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    let alive = true, sequence = 0;
    const load = async () => {
      const request = ++sequence;
      try {
        const rows = await fetchSkills();
        if (!Array.isArray(rows)) throw new Error('技能目录暂不可用');
        if (alive && request === sequence) setSkills(rows.filter(skill =>
          ['ecom-details-image', 'ai-image-gen'].includes(skill.name)
          || (skill.source === 'clawhub' && /提示词|prompt/i.test(skill.description) && /图片|生图|图像|image/i.test(skill.description))
        ).slice(0, 4));
      } catch { /* Keep installed suggestions during a temporary catalogue outage. */ }
    };
    void load();
    window.addEventListener('easel:skill-configured', load);
    return () => { alive = false; window.removeEventListener('easel:skill-configured', load); };
  }, [active]);

  if (!skills.length) return null;
  return <div className="image-skill-ideas" role="group" aria-label="Skill 灵感">
    <span className="image-inspiration-label"><IconSkills size={14} />Skill 灵感</span>
    <div className="image-prompt-suggestions">{skills.map(skill => <button type="button" key={skill.name} disabled={disabled}
      title={`${skill.description}\n在对话中完善提示词`} onClick={() => {
        const input = ['请使用所选技能帮我完善图片提示词。只输出创意方向与可直接用于生图的描述，暂不生成图片或调用生图工具。',
          `画面比例：${ratio}`, prompt.trim() ? `当前描述：\n${prompt.trim()}` : '请先帮助我确定主体、用途、风格与构图。',
          '最终提示词控制在2000字以内，放在独立代码块中，便于带回生图工坊。'].join('\n\n');
        setError(onOpen(skill.name, input) ? '' : '对话草稿未能保存，请重试');
      }}>{skill.displayName || displayName(skill.name)}<span aria-hidden="true">↗</span></button>)}</div>
    {error && <p className="image-error" role="alert">{error}</p>}
  </div>;
}
