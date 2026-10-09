import { readLocalValue, writeLocalValue } from './localPersistence';
const KEY = 'easel:agent-channel-order';
export function readChannelOrder(): string[] {
  const result = readLocalValue(KEY);
  if (!result.ok || !result.value) return [];
  try { const data = JSON.parse(result.value); return Array.isArray(data) ? [...new Set(data.filter((v): v is string=>typeof v==='string' && /^[A-Za-z0-9_.-]{1,100}$/.test(v)))].slice(0,256) : []; }
  catch { return []; }
}
export function orderedChannels(available: string[], saved: string[]): string[] {
  return [...saved.filter(id=>available.includes(id)), ...available.filter(id=>!saved.includes(id))];
}
export function saveChannelOrder(order: string[]): boolean { return writeLocalValue(KEY, JSON.stringify(order)); }
export function moveChannel(order: string[], from: string, to: string): string[] {
  const start=order.indexOf(from), end=order.indexOf(to);
  if(start<0 || end<0 || start===end)return order;
  const next=[...order];next.splice(start,1);next.splice(end,0,from);return next;
}
