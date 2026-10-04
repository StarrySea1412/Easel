/** Brand identity and review status are separate from routing configuration. */
export const MODEL_PROVIDERS = [
  { id: 'doubao', name: '豆包', motif: '棕色侧分短发女孩', color: '#986b50' },
  { id: 'deepseek', name: 'DeepSeek', motif: '蓝鲸', color: '#3978ee' },
  { id: 'qwen', name: 'Qwen / 千问', motif: '三段闭环', color: '#6756df' },
  { id: 'kimi', name: 'Kimi', motif: 'K 与蓝点', color: '#538df5' },
  { id: 'glm', name: 'GLM / 智谱', motif: '倾斜双环', color: '#426ee9' },
  { id: 'minimax', name: 'MiniMax', motif: '暖色波形', color: '#ee6a73' },
  { id: 'hunyuan', name: '腾讯混元', motif: '三瓣旋涡', color: '#31b8d2' },
  { id: 'spark', name: '讯飞星火', motif: '蓝青火焰与红尖', color: '#279ed2' },
  { id: 'wenxin', name: '文心', motif: '文心字牌（待审方向）', color: '#7482dc' },
  { id: 'openai', name: 'OpenAI', motif: '交织结', color: '#409881' },
  { id: 'claude', name: 'Claude', motif: '珊瑚星芒', color: '#d88067' },
  { id: 'gemini', name: 'Gemini', motif: '多色四角星', color: '#548ee7' },
  { id: 'grok', name: 'Grok', motif: '断环与斜线', color: '#697786' },
  { id: 'mistral', name: 'Mistral', motif: '像素猫与橙围巾', color: '#e99739' },
  { id: 'unknown', name: '来源未确认', motif: '中性石墨机器人', color: '#7d8996' },
] as const;

export type ModelProviderId = typeof MODEL_PROVIDERS[number]['id'];
export interface OfficeObservedModel {
  provider: ModelProviderId;
  model: string | null;
  channel: string | null;
  source: 'observed' | 'unknown' | 'demo';
  observedAt: string | null;
  evidence: string;
}

export function modelProvider(provider?: string) {
  return MODEL_PROVIDERS.find(item => item.id === provider) ?? MODEL_PROVIDERS[14];
}

/** Never accept configured or synthetic identities as evidence from a live endpoint. */
export function decodeObservedModel(value: unknown): OfficeObservedModel {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.slice(0, 240) : null;
  const label = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(value) ? value : null;
  const model = label(item.model);
  const observedAt = typeof item.observedAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(item.observedAt)
    && Number.isFinite(Date.parse(item.observedAt)) ? item.observedAt : null;
  const observed = item.source === 'observed' && model !== null && observedAt !== null;
  return {
    provider: observed ? modelProvider(text(item.provider) ?? undefined).id : 'unknown',
    model: observed ? model : null, channel: observed ? label(item.channel) : null, source: observed ? 'observed' : 'unknown',
    observedAt: observed ? observedAt : null,
    evidence: observed ? text(item.evidence) ?? '调用记录标识；中转底层模型未独立验证。' : '尚未观察到该 Agent 的模型记录。',
  };
}

export function officeModelLabel(identity?: OfficeObservedModel) {
  const prefix = identity?.source === 'demo' ? '模拟品牌' : identity?.source === 'observed' ? '记录标识' : '模型';
  return `${prefix}：${modelProvider(identity?.provider).name}${identity?.model ? ` · ${identity.model}` : ''}`;
}
