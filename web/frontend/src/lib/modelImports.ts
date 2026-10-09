export const MODEL_IMPORT_SLOT_OPTIONS = [
  { value: 'auto', label: '自动匹配协议', description: '优先使用空的兼容通道，确认前显示实际写入位置' },
  { value: 'openai', label: 'OpenAI 兼容', description: 'Chat Completions 协议' },
  { value: 'relay', label: 'Anthropic 兼容中转', description: 'Anthropic Messages 协议' },
  { value: 'anthropic', label: 'Anthropic', description: 'Anthropic Messages 协议' },
];

export function modelImportSlotLabel(slot: string) {
  return MODEL_IMPORT_SLOT_OPTIONS.find(option => option.value === slot)?.label || slot;
}
