import { CAPABILITY_MENU } from '../lib/capabilityMenu';
import { IconChart, IconCompass, IconImage, IconMusic, IconProfile, IconSearch, IconSend, IconSkills, IconText, IconVideo } from './icons';

// Presentation categories from the existing catalogue, not execution evidence.
const groups = new Map(CAPABILITY_MENU.tabs.flatMap(tab => tab.groups.flatMap(group =>
  group.items.flatMap(item => item.skill ? [[item.skill, group.id] as const] : []))));
export default function SkillTypeIcon({ name, size = 14 }: { name: string; size?: number }) {
  const group = groups.get(name);
  const Icon = group === 'visual' ? IconImage : group === 'video' ? IconVideo
    : group === 'audio' ? IconMusic : group === 'writing' ? IconText
    : group === 'publish' || group === 'ops' ? IconSend : group === 'discover' ? IconSearch
    : group === 'plan' ? IconCompass : group === 'data' ? IconChart : group === 'account' ? IconProfile : IconSkills;
  return <span className="composer-skill-type-icon" aria-hidden="true"><Icon size={size}/></span>;
}
