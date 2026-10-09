import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { fetchModelChannels, type ModelChannelsResponse, type SkillDetail, type SkillItem } from '../lib/api';
import { skillDependencies } from '../lib/skillDependencies';
import { IconImage, IconVideo, IconMic, IconMusic, IconKey, IconFile } from './icons';
import { IconBell } from './settingsIcons';
import '../styles/skill-dependencies.css';

const icons: Record<string, ComponentType<{ size?: number }>> = { image: IconImage, video: IconVideo, speech: IconMic, transcribe: IconMic, music: IconMusic, notify: IconBell, document: IconFile, api: IconKey };
export default function SkillDependencyBadges({ skill, detail }: { skill: SkillItem; detail?: SkillDetail | null }) {
  const [channels, setChannels] = useState<ModelChannelsResponse | null>(null);
  const needsChannels = Boolean(detail && skillDependencies(skill, detail).some(dependency => dependency.channel));
  useEffect(() => {
    if (!needsChannels) return;
    let active = true; setChannels(null);
    fetchModelChannels().then(value => { if (active) setChannels(value); }).catch(() => { /* Keep unknown distinct from missing. */ });
    return () => { active = false; };
  }, [detail, needsChannels]);
  const dependencies = skillDependencies(skill, detail, channels);
  if (!dependencies.length) return null;
  return <div className={`skill-dependencies${detail ? ' is-detailed' : ''}`} aria-label="技能外部能力与配置">
    {dependencies.map(dependency => {
      const Icon = icons[dependency.id];
      const state = dependency.configured === true ? 'Key 已配置' : dependency.configured === false ? 'Key 待配置' : '按用途配置';
      const title = `${dependency.label} · ${dependency.required ? '必需' : '相关能力 / 按用途选用'} · ${state}。${dependency.note} 配置状态不代表实际调用已通过。`;
      const content = <><Icon size={14} /><span>{dependency.label}</span>{detail && <small>{dependency.required ? '必需' : '按用途'} · {state}</small>}</>;
      return detail && dependency.channel ? <button key={dependency.id} type="button" title={title} aria-label={title} className={dependency.required && dependency.configured === false ? 'needs-config' : ''} onClick={() => window.dispatchEvent(new CustomEvent('easel:open-skill-settings', { detail: dependency.channel }))}>{content}</button>
        : <span key={dependency.id} title={title} aria-label={title} tabIndex={detail ? 0 : undefined} className={dependency.required && dependency.configured === false ? 'needs-config' : ''}>{content}</span>;
    })}
    {detail && <p>用到对应能力时配置其 Key；转写、普通配音等可使用本地或无 Key 分支。已配置仅表示凭据登记，调用费用以服务商为准。点击图标进入对应设置。</p>}
  </div>;
}
