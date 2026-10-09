import type { ComposerSkills } from '../hooks/useComposerSkills';
import BrushEntry from './BrushEntry';
import SelectedSkillChip from './SelectedSkillChip';

export function ComposerSkillChips({ skills }: { skills: ComposerSkills }) {
  if (!skills.selectedSkills.length) return null;
  return <div className="composer-selected-skills" role="group" aria-label="已选择的创作技能">
    <span className="composer-selected-label">已选技能</span>
    {skills.selectedSkills.map(skill => <SelectedSkillChip key={skill} skillName={skill}
      requirement={Object.hasOwn(skills.skillRequirements, skill) ? skills.skillRequirements[skill] : undefined}
      requirementScope={skills.requirementScope}
      onSaveRequirement={text => skills.saveSkillRequirement(skill, text)}
      onRemove={() => skills.removeSkill(skill)} />)}
  </div>;
}

export function ComposerSkillPicker({ skills, setInput, openRequest }: {
  skills: ComposerSkills;
  openRequest?: number;
  setInput: (value: string | ((current: string) => string)) => void;
}) {
  return <BrushEntry compact openRequest={openRequest} selectedSkills={skills.selectedSkills} onRemove={skills.removeSkill}
    onPick={(text, skill, example) => {
      if (!skills.retryRestore()) return;
      skills.selectSkill(skill);
      setInput(current => example ? (current.trim() ? `${current}\n${text}` : text) : current.trim() ? current : text);
    }} />;
}
