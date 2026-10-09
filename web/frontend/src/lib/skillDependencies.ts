import rules from './skillDependencyRules.json';
import bundled from './bundledSkillDependencies.json';
import type { ModelChannelsResponse, SkillDetail, SkillItem } from './api';

export function skillDependencies(skill: Pick<SkillItem, 'name' | 'needsApi' | 'apiConfigured'>, detail?: SkillDetail | null, channels?: ModelChannelsResponse | null) {
  const ids = detail ? rules.filter(rule => rule.markers.some(marker => (detail.body || '').includes(marker))).map(rule => rule.id)
    : (bundled as Record<string, string[]>)[skill.name] || [];
  return rules.filter(rule => ids.includes(rule.id) || (rule.id === 'api' && skill.needsApi && !ids.length)).map(rule => {
    const required = (rule.requiredSkills as string[]).includes(skill.name) || (rule.id === 'api' && skill.needsApi);
    const rows = rule.channel && channels?.channels?.[rule.channel as keyof ModelChannelsResponse['channels']]?.rows;
    const configured = rows ? rows.some(row => row.result === '已配置' && Boolean(row.keyMasked && row.keyMasked !== '—'))
      : required && ['ai-image-gen', 'ai-video-gen', 'ai-music', 'voice-clone', 'ecom-details-image', 'short-drama', 'skill-email-notify'].includes(skill.name) ? skill.apiConfigured
        : rule.id === 'api' && detail?.guide?.needs?.api ? detail.guide.needs.api.configured : null;
    return { ...rule, required, configured };
  });
}
