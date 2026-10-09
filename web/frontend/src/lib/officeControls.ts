export interface OfficeControlIdentity { sessionId: string; turnId: string; agentId: string }
export type OfficeModelScope = 'next_turn' | 'subsequent_calls' | 'future_spawn' | 'unavailable';
export const OFFICE_MODEL_SCOPE_LABELS: Record<OfficeModelScope, string> = {
  next_turn: '仅在 Agent 已空闲或结束时保存，用于该 Agent 的后续轮次；当前运行中的模型不变。',
  subsequent_calls: '保存到该 Agent 会话，后续模型调用使用所选渠道；不会重新运行已完成任务。',
  future_spawn: '保存后用于之后创建的协作任务；当前已运行的 Agent 不变。',
  unavailable: '后台暂未提供独立模型分配能力。',
};
export type OfficeStopScope = 'agent' | 'session' | 'unavailable';
export interface OfficeModelOption { id: string; provider: string; model: string; label: string; configured: boolean; thinkingLevels?: string[]; channelName?: string }
export interface OfficeModelCapability {
  available: boolean;
  scope: OfficeModelScope;
  currentModelRef: string | null;
  defaultModelRef?: string;
  options: OfficeModelOption[];
  reason: string;
}
export interface OfficeControls extends OfficeControlIdentity {
  model: OfficeModelCapability;
  stop: { available: boolean; scope: OfficeStopScope; reason: string; runId?: string | null };
}
export interface OfficeModelReceipt extends OfficeControlIdentity {
  applied: boolean; scope: OfficeModelScope; modelRef: string | null; message: string;
}
export interface OfficeStopReceipt extends OfficeControlIdentity {
  confirmed: boolean; scope: OfficeStopScope; message: string; runId?: string | null;
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

export function decodeOfficeModelCapability(value: unknown): OfficeModelCapability {
  if (!record(value)) throw new Error('模型选项格式无效，请刷新后重试。');
  const model = value;
  const options: OfficeModelOption[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(model.options) ? model.options.slice(0, 256) : []) {
    if (!record(item) || typeof item.id !== 'string' || !item.id || item.id.length > 500 || seen.has(item.id)
      || typeof item.provider !== 'string' || !item.provider || typeof item.model !== 'string' || !item.model) continue;
    seen.add(item.id);
      options.push({ id: item.id, provider: text(item.provider), model: text(item.model), label: text(item.label), configured: item.configured === true,
        ...(typeof item.channelName === 'string' ? { channelName: text(item.channelName) } : {}),
      ...(Array.isArray(item.thinkingLevels) ? { thinkingLevels: item.thinkingLevels.filter((level): level is string => typeof level === 'string' && ['off','minimal','low','medium','high','xhigh','adaptive','max','ultra'].includes(level)) } : {}) });
  }
  const scope = modelScope(model.scope);
  return { available: model.available === true && scope !== 'unavailable', scope,
    currentModelRef: typeof model.currentModelRef === 'string' ? text(model.currentModelRef) : null,
    ...(typeof model.defaultModelRef === 'string' ? {defaultModelRef:text(model.defaultModelRef)} : {}),
    options, reason: text(model.reason, '当前暂不支持指定模型。') };
}

export function decodeOfficeControls(value: unknown, expected: OfficeControlIdentity): OfficeControls {
  const data = identity(value, expected);
  const model = record(data.model) ? data.model : {};
  const stop = record(data.stop) ? data.stop : {};
  const stopTarget = stopScope(stop.scope);
  return { ...expected,
    model: decodeOfficeModelCapability(model),
    stop: { available: stop.available === true && stopTarget !== 'unavailable', scope: stopTarget,
      reason: text(stop.reason, '后台暂未提供可确认的单 Agent 停止能力。'),
      runId: typeof stop.runId === 'string' ? text(stop.runId) : null },
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
export async function stopOfficeAgent(expected: OfficeControlIdentity, signal: AbortSignal, expectedRunId?: string): Promise<OfficeStopReceipt> {
  const data = identity(await request('stop', expected, signal, expectedRunId ? { expectedRunId } : {}), expected);
  return { ...expected, confirmed: data.confirmed === true, scope: stopScope(data.scope), message: text(data.message),
    runId: typeof data.runId === 'string' ? text(data.runId) : null };
}

/** This catalog never proves that a configured model has completed an inference. */
export async function fetchOfficeTaskModels(sessionId: string | null, signal: AbortSignal): Promise<OfficeModelCapability> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try {
    const response = await fetch(`${base}/api/agent-office/models${sessionId ? `?${new URLSearchParams({ sessionId })}` : ''}`, { signal: controller.signal, cache: 'no-store' });
    const data: unknown = await response.json();
    if (timedOut) throw new Error('模型能力核验超时，请刷新模型选项后重试。');
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!response.ok) {
      const detail = record(data) ? data.detail : undefined;
      throw new Error(typeof detail === 'string' ? text(detail) : record(detail) && typeof detail.message === 'string' ? text(detail.message) : `模型选项读取失败（HTTP ${response.status}）。`);
    }
    const decoded = decodeOfficeModelCapability(data);
    return { ...decoded, available: decoded.available && decoded.scope === 'next_turn',
      scope: decoded.scope === 'next_turn' ? 'next_turn' : 'unavailable',
      options: decoded.options.filter(option => option.id === `${option.provider}/${option.model}`),
      ...(decoded.scope !== 'next_turn' && decoded.available ? { reason: '后台未提供本轮模型指定能力，请检查网关配置。' } : {}) };
  } catch (error) {
    if (timedOut) throw new Error('模型能力核验超时，请刷新模型选项后重试。');
    throw error;
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
  }
}
