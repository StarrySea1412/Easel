import type { SkillItem } from './api';
import { displayName } from './skillDisplayNames';

// Local intent matching uses installed skills and never calls a model.
const intents: [RegExp, string[]][] = [
  [/生图|生成.{0,6}(图片|图像)|画一|绘制|ai.{0,2}(图片|绘图)/i, ['ai-image-gen']],
  [/海报|封面|主视觉/, ['poster-hero','ai-image-gen']],
  [/电商|商品详情|详情图/, ['ecom-details-image','copywriting']],
  [/生成.{0,6}视频|ai.{0,2}视频/i, ['ai-video-gen','video-script']],
  [/短剧/, ['short-drama','video-script']],
  [/剪辑|剪视频|视频剪/, ['video-editing','video-highlights']],
  [/字幕|转写|转录/, ['auto-subtitle','video-to-article']],
  [/配音|朗读/, ['tts-voiceover']],
  [/声音克隆|克隆声音|复刻声音/, ['voice-clone']],
  [/生成.{0,6}(音乐|歌曲)|作曲|写歌/, ['ai-music']],
  [/小红书.{0,8}(笔记|文案)|探店笔记/, ['xhs-note-creator','card-xiaohongshu']],
  [/写.{0,6}(文案|广告)|营销文案|带货文案/, ['copywriting','text-polisher']],
  [/润色|改写/, ['text-polisher','style-transfer']],
  [/公众号|推文/, ['gzh-design','skill-wechat-publisher']],
  [/选题|热点|趋势/, ['skill-trending-topics','skill-topic-evaluator']],
  [/排期|日历|一周.{0,6}(计划|内容)/, ['skill-content-calendar','skill-content-calendar-log']],
  [/竞品|竞争对手/, ['skill-competitor-analysis','skill-content-gap-analysis']],
  [/账号诊断|账号分析|运营分析/, ['skill-account-diagnosis','skill-social-performance-review']],
  [/复盘|数据分析|运营数据/, ['skill-content-postmortem','skill-publish-analytics']],
  [/内容策略|运营策略|运营计划/, ['skill-content-strategy','skill-strategy-advisor']],
  [/发布|投稿/, ['skill-publish-checklist','skill-cross-platform-publish']],
  [/邮件|邮箱.{0,6}(提醒|通知)/, ['skill-email-notify']],
  [/思维导图/, ['mindmap']],
  [/pdf|文档转换/i, ['doc-convert']],
];
export function recommendSkills(text: string, installed: SkillItem[], selected: string[] = []): SkillItem[] {
  const input = text.trim().toLowerCase().slice(0, 20000);
  if (input.length < 2) return [];
  const scores = new Map<string, number>();
  for (const [pattern, names] of intents) if (pattern.test(input)) names.forEach((name, index) => scores.set(name, Math.max(scores.get(name) || 0, 10 - index)));
  for (const skill of installed) {
    const label = displayName(skill.name).toLowerCase();
    if (input.includes(skill.name.toLowerCase()) || (label.length >= 3 && input.includes(label))) scores.set(skill.name, 20);
  }
  return installed.filter(skill => !selected.includes(skill.name) && scores.has(skill.name))
    .sort((a, b) => scores.get(b.name)! - scores.get(a.name)! || a.name.localeCompare(b.name)).slice(0, 3);
}
