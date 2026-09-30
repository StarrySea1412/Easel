export interface OfficeControlIdentity { sessionId: string; turnId: string; agentId: string }
export type OfficeModelScope = 'next_turn' | 'subsequent_calls' | 'future_spawn' | 'unavailable';
export const OFFICE_MODEL_SCOPE_LABELS: Record<OfficeModelScope, string> = {
  next_turn: '仅在 Agent 已空闲或结束时保存，用于该 Agent 的后续轮次；当前运行中的模型不变。',
  subsequent_calls: '保存到该 Agent 会话，后续模型调用使用所选渠道；不会重新运行已完成任务。',
  future_spawn: '保存后用于之后创建的协作任务；当前已运行的 Agent 不变。',
  unavailable: '后台暂未提供独立模型分配能力。',
};
export type OfficeStopScope = 'agent' | 'session' | 'unavailable';
export interface OfficeModelOption { id: string; provider: string; model: string; label: string; configured: boolean }
export interface OfficeModelCapability {
  available: boolean;
  scope: OfficeModelScope;
  currentModelRef: string | null;
  options: OfficeModelOption[];
  reason: string;
}
export interface OfficeControls extends OfficeControlIdentity {
  model: OfficeModelCapability;
  stop: { available: boolean; scope: OfficeStopScope; reason: string };
}
export interface OfficeModelReceipt extends OfficeControlIdentity {
  applied: boolean; scope: OfficeModelScope; modelRef: string | null; message: string;
}
export interface OfficeStopReceipt extends OfficeControlIdentity {
  confirmed: boolean; scope: OfficeStopScope; message: string;
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, fallback = '') { return typeof value === 'string' ? value.slice(0, 500) : fallback; }
function identity(value: unknown, expected: OfficeControlIdentity): Record<string, unknown> {
  if (!record(value) || value.sessionId !== expected.sessionId || value.turnId !== expected.turnId || value.agentId !== expected.agentId) {
    throw new Error('控制回执不属于当前会话、轮次或 Agent，结果未确认，请刷新后重试。');
  }
  return value;
}
function modelScope(value: unknown): OfficeModelScope { return value === 'next_turn' || value === 'subsequent_calls' || value === 'future_spawn' ? value : 'unavailable'; }
function stopScope(value: unknown): OfficeStopScope { return value === 'agent' || value === 'session' ? value : 'unavailable'; }

export function decodeOfficeControls(value: unknown, expected: OfficeControlIdentity): OfficeControls {
  const data = identity(value, expected);
  const model = record(data.model) ? data.model : {};
  const stop = record(data.stop) ? data.stop : {};
  const options: OfficeModelOption[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(model.options) ? model.options.slice(0, 256) : []) {
    if (!record(item) || typeof item.id !== 'string' || !item.id || item.id.length > 500 || seen.has(item.id)
      || typeof item.provider !== 'string' || !item.provider || typeof item.model !== 'string' || !item.model) continue;
    seen.add(item.id);
    options.push({ id: item.id, provider: text(item.provider), model: text(item.model), label: text(item.label), configured: item.configured === true });
  }
  const scope = modelScope(model.scope);
  const stopTarget = stopScope(stop.scope);
  return { ...expected,
    model: { available: model.available === true && scope !== 'unavailable', scope,
      currentModelRef: typeof model.currentModelRef === 'string' ? model.currentModelRef : null,
      options, reason: text(model.reason, '当前 Agent 暂不支持独立模型配置。') },
    stop: { available: stop.available === true && stopTarget !== 'unavailable', scope: stopTarget,
      reason: text(stop.reason, '后台暂未提供可确认的单 Agent 停止能力。') },
  };
}

async function request(path: string, expected: OfficeControlIdentity, signal: AbortSignal, extra?: object): Promise<unknown> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
  try {
    const response = await fetch(`${base}/api/agent-office/${path}${extra ? '' : `?${new URLSearchParams({ ...expected })}`}`, {
      method: extra ? 'POST' : 'GET', signal: controller.signal, cache: 'no-store',
      ...(extra ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...expected, ...extra }) } : {}),
    });
    let value: unknown;
    try { value = await response.json(); }
    catch {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      throw new Error(response.ok ? '后台返回的控制结果无法读取，操作尚未确认，请刷新后检查。'
        : `Agent 控制暂不可用（HTTP ${response.status}）。`);
    }
    if (timedOut) throw new Error('请求超时，结果尚未确认，请刷新状态后再操作。');
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!response.ok) throw new Error(record(value) && typeof value.detail === 'string' ? text(value.detail)
      : `Agent 控制暂不可用（HTTP ${response.status}）。`);
    return value;
  } catch (cause) {
    if (timedOut) throw new Error('请求超时，结果尚未确认，请刷新状态后再操作。');
    throw cause;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export async function fetchOfficeControls(expected: OfficeControlIdentity, signal: AbortSignal): Promise<OfficeControls> {
  return decodeOfficeControls(await request('controls', expected, signal), expected);
}
export async function saveOfficeAgentModel(expected: OfficeControlIdentity, modelRef: string, signal: AbortSignal): Promise<OfficeModelReceipt> {
  const data = identity(await request('model', expected, signal, { modelRef }), expected);
  return { ...expected, applied: data.applied === true, scope: modelScope(data.scope),
    modelRef: typeof data.modelRef === 'string' ? data.modelRef : null, message: text(data.message) };
}
export async function stopOfficeAgent(expected: OfficeControlIdentity, signal: AbortSignal): Promise<OfficeStopReceipt> {
  const data = identity(await request('stop', expected, signal, {}), expected);
  return { ...expected, confirmed: data.confirmed === true, scope: stopScope(data.scope), message: text(data.message) };
}
