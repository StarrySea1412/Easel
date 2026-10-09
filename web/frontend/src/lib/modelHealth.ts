import { isCompleteModelRef } from './composerModel';

export type ModelProbeMode = 'text' | 'vision';
export type ModelHealthState = 'unverified' | 'running' | 'success' | 'failed';
export interface ModelHealthResult { modelRef: string; mode: ModelProbeMode; state: ModelHealthState; testedAt?: number; stale?: boolean; detail?: string }
export interface ModelHealthSchedule { modelRef: string; enabled: boolean; intervalSeconds: number; prompt: string }
export interface ModelHealthSnapshot { results: ModelHealthResult[]; schedules: ModelHealthSchedule[]; limit: { requests: number; windowSeconds: number; automaticModelsPerProvider: number }; staleAfterSeconds: number; serverTime: number }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
export function decodeModelHealth(value: unknown): ModelHealthSnapshot {
  if (!record(value) || !Array.isArray(value.results)) throw new Error('模型测活状态格式无效，请刷新后重试。');
  const results = value.results.flatMap(item => {
    if (!record(item) || !isCompleteModelRef(item.modelRef) || (item.mode !== 'text' && item.mode !== 'vision')
      || !['unverified', 'running', 'success', 'failed'].includes(String(item.state))) return [];
    return [{ modelRef: item.modelRef, mode: item.mode, state: item.state as ModelHealthState,
      ...(typeof item.testedAt === 'number' && Number.isFinite(item.testedAt) ? { testedAt: item.testedAt } : {}),
      stale: item.stale === true, detail: typeof item.detail === 'string' ? item.detail.slice(0, 1000) : '' } as ModelHealthResult];
  });
  const schedules = (Array.isArray(value.schedules) ? value.schedules : []).flatMap(item => !record(item) || !isCompleteModelRef(item.modelRef) ? [] : [{
    modelRef: item.modelRef, enabled: item.enabled === true, intervalSeconds: typeof item.intervalSeconds === 'number' ? item.intervalSeconds : 900, prompt: typeof item.prompt === 'string' ? item.prompt : '',
  }]);
  const limit = record(value.limit) ? value.limit : {};
  return { results, schedules, limit: { requests: typeof limit.requests === 'number' ? limit.requests : 2, windowSeconds: typeof limit.windowSeconds === 'number' ? limit.windowSeconds : 60, automaticModelsPerProvider: typeof limit.automaticModelsPerProvider === 'number' ? limit.automaticModelsPerProvider : 2 },
    staleAfterSeconds: typeof value.staleAfterSeconds === 'number' ? value.staleAfterSeconds : 900, serverTime: typeof value.serverTime === 'number' ? value.serverTime : Date.now() / 1000 };
}
async function request(path: string, signal: AbortSignal, body?: object): Promise<unknown> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  const controller = new AbortController(), abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let timedOut = false; const timer = setTimeout(() => { timedOut = true; controller.abort(); }, body ? 90000 : 15000);
  try {
    const response = await fetch(`${base}/api/settings/models/${path}`, { signal: controller.signal, cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const value: unknown = await response.json();
    if (timedOut) throw new Error('模型测活请求超时，结果尚未确认，请刷新状态。');
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!response.ok) throw new Error(record(value) && typeof value.detail === 'string' ? value.detail : record(value) && record(value.detail) && typeof value.detail.message === 'string' ? value.detail.message : `模型测活请求失败（HTTP ${response.status}）`);
    return value;
  } catch (cause) { if (timedOut) throw new Error('模型测活请求超时，结果尚未确认，请刷新状态。'); throw cause; }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
export async function fetchModelHealth(signal: AbortSignal): Promise<ModelHealthSnapshot> { return decodeModelHealth(await request('health', signal)); }
export function probeModel(modelRef: string, mode: ModelProbeMode, prompt: string, signal: AbortSignal): Promise<unknown> { return request('probe', signal, { modelRef, mode, prompt }); }
export function saveModelHealthSchedules(schedules: ModelHealthSchedule[], signal: AbortSignal): Promise<unknown> { return request('health/schedules', signal, { schedules }); }
export function modelHealthLabel(result?: ModelHealthResult): string {
  if (!result || result.state === 'unverified') return '未测活';
  if (result.state === 'running') return '测活中';
  return `${result.state === 'success' ? '通过' : '失败'}${result.stale ? '（已过期）' : ''}`;
}
