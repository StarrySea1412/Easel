import type { ComponentType } from 'react';
import type { ModelRow } from '../lib/api';
import { providerBrand } from '../lib/providerBrand';
import deepseek from '../assets/providers/deepseek-color.svg';
import openai from '../assets/providers/openai.svg';
import claude from '../assets/providers/claude-color.svg';
import gemini from '../assets/providers/gemini-color.svg';
import qwen from '../assets/providers/qwen-color.svg';
import moonshot from '../assets/providers/moonshot.svg';
import zhipu from '../assets/providers/zhipu-color.svg';
import minimax from '../assets/providers/minimax-color.svg';
import doubao from '../assets/providers/doubao-color.svg';
import siliconcloud from '../assets/providers/siliconcloud-color.svg';
import grok from '../assets/providers/grok.svg';
import mistral from '../assets/providers/mistral-color.svg';
import fishaudio from '../assets/providers/fishaudio.svg';
import hunyuan from '../assets/providers/hunyuan-color.svg';
import spark from '../assets/providers/spark-color.svg';
import wenxin from '../assets/providers/wenxin-color.svg';

const ICONS: Record<string, string> = { deepseek, openai, claude, gemini, qwen, moonshot, zhipu, minimax, doubao, siliconcloud, grok, mistral, fishaudio, hunyuan, spark, wenxin };

export default function ProviderIcon({ row, fallback: Fallback }: { row: ModelRow; fallback: ComponentType<{ size?: number }> }) {
  const brand = providerBrand(row);
  return brand && ICONS[brand] ? <img src={ICONS[brand]} alt="" width={22} height={22} draggable={false} data-provider-brand={brand} /> : <Fallback size={19} />;
}
