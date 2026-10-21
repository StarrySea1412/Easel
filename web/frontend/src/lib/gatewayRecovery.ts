export interface GatewayRecoveryState { state: 'starting'|'connected'|'failed'|'not_needed'; note: string; retryAfter: number }
let pending: Promise<GatewayRecoveryState> | null = null;
export function ensureGateway(): Promise<GatewayRecoveryState> {
  if (pending) return pending;
  const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), 10000);
  const task = fetch(`${base}/api/gateway/ensure`, {method:'POST',cache:'no-store',signal:controller.signal}).then(async response=>{
    if (!response.ok) throw new Error(`网关恢复请求失败（HTTP ${response.status}）`);
    const data = await response.json();
    if (!['starting','connected','failed','not_needed'].includes(data?.state) || typeof data.note !== 'string') throw new Error('网关恢复状态读取失败');
    return data as GatewayRecoveryState;
  }).finally(()=>{clearTimeout(timer);if(pending===task)pending=null;});
  pending=task;
  return task;
}
