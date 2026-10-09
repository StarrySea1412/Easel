export interface ChannelConnection { modelRef: string; state: 'success' | 'failed' | 'unverified' | 'running'; channelName: string; detail: string; modelListed?: boolean; checkedAt?: number }
export interface ChannelName { name: string; sourceName?: string; source?: string }

async function request(path: string, signal?: AbortSignal, body?: object) {
  const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 20000);
  try {
    const response = await fetch(`${base}/api/settings/models/${path}`, { signal: controller.signal, cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value?.detail === 'string' ? value.detail : `读取渠道失败（HTTP ${response.status}）`);
    return value;
  } catch (cause) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('渠道读取超时，请重试。');
    throw cause;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export async function fetchChannelConnection(modelRef: string, signal: AbortSignal): Promise<ChannelConnection> {
  const value = await request(`connection?modelRef=${encodeURIComponent(modelRef)}`, signal);
  if (value?.modelRef !== modelRef || !['success', 'failed', 'unverified'].includes(value?.state) || typeof value.detail !== 'string') throw new Error('渠道检测结果格式无效。');
  return value;
}
export async function fetchChannelNames(signal: AbortSignal): Promise<Record<string, ChannelName>> {
  const value = await request('channel-names', signal);
  if (!value?.channels || typeof value.channels !== 'object' || Array.isArray(value.channels)) throw new Error('渠道名称读取失败。');
  return value.channels;
}
export async function saveChannelName(provider: string, name: string, signal: AbortSignal): Promise<void> {
  const value = await request('channel-names', signal, { provider, name });
  if (value?.ok !== true) throw new Error('渠道名称保存尚未确认。');
  window.dispatchEvent(new window.Event('easel:channel-names-changed'));
}
