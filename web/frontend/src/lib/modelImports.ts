export const MODEL_IMPORT_SLOT_OPTIONS = [
  { value: 'auto', label: '自动匹配协议', description: '按 Chat Completions / Responses / Messages 选择兼容通道' },
  { value: 'openai', label: 'OpenAI 兼容', description: 'Chat Completions 或 Responses 协议' },
  { value: 'relay', label: 'Anthropic 兼容中转', description: 'Anthropic Messages 协议' },
  { value: 'anthropic', label: 'Anthropic', description: 'Anthropic Messages 协议' },
];

export function modelImportSlotLabel(slot: string) {
  return MODEL_IMPORT_SLOT_OPTIONS.find(option => option.value === slot)?.label || slot;
}
