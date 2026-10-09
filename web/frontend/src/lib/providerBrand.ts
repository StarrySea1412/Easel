import type { ModelRow } from './api';

export function providerBrand(row: Pick<ModelRow, 'name' | 'slot' | 'model' | 'baseUrl'>): string | null {
  let host = '';
  try { host = new URL(row.baseUrl).hostname.toLowerCase(); } catch { /* An incomplete draft has no host. */ }
  const hosts: [string, string][] = [
    ['deepseek.com', 'deepseek'], ['openai.com', 'openai'], ['anthropic.com', 'claude'],
    ['moonshot.cn', 'moonshot'], ['moonshot.ai', 'moonshot'], ['bigmodel.cn', 'zhipu'],
    ['siliconflow.cn', 'siliconcloud'], ['siliconflow.com', 'siliconcloud'],
    ['dashscope.aliyuncs.com', 'qwen'], ['minimaxi.com', 'minimax'], ['minimax.io', 'minimax'],
    ['generativelanguage.googleapis.com', 'gemini'], ['volces.com', 'doubao'],
    ['x.ai', 'grok'], ['mistral.ai', 'mistral'], ['fish.audio', 'fishaudio'],
  ];
  const matched = hosts.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
  if (matched) return matched[1];
  const identity = `${row.name} ${row.model}`.toLowerCase();
  const names: [RegExp, string][] = [
    [/deepseek/, 'deepseek'], [/claude|anthropic/, 'claude'], [/gemini|google/, 'gemini'],
    [/qwen|千问|通义|dashscope|cosyvoice/, 'qwen'], [/kimi|moonshot/, 'moonshot'],
    [/glm|zhipu|智谱/, 'zhipu'], [/minimax/, 'minimax'], [/doubao|豆包|seedance/, 'doubao'],
    [/siliconflow|硅基/, 'siliconcloud'], [/gpt|openai/, 'openai'], [/grok/, 'grok'],
    [/mistral/, 'mistral'], [/fish/, 'fishaudio'], [/hunyuan|混元/, 'hunyuan'],
    [/spark|星火/, 'spark'], [/wenxin|文心/, 'wenxin'],
  ];
  return names.find(([pattern]) => pattern.test(row.model.toLowerCase()))?.[1]
    ?? names.find(([pattern]) => pattern.test(identity))?.[1] ?? null;
}
