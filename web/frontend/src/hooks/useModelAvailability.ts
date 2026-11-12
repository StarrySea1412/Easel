import { useEffect, useRef, useState } from 'react';
import { decodeModelHealth, ModelHealthRequestError, probeModel, type ModelHealthResult, type ModelProbeMode } from '../lib/modelHealth';

export const DEFAULT_MODEL_CHECK = { mode: 'text' as ModelProbeMode, prompt: '请只回复：连接成功' };
const STORAGE_KEY = 'easel:model-check-defaults:v1';
export type ModelCheckDefaults = typeof DEFAULT_MODEL_CHECK;
export type ModelCheckState = { busy?: boolean; result?: ModelHealthResult; error?: string; mode: ModelProbeMode; startedAt?: number; elapsedSeconds?: number; cancelled?: boolean };
function readDefaults(): ModelCheckDefaults {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (value && ['text', 'vision'].includes(value.mode) && typeof value.prompt === 'string' && value.prompt.trim() && value.prompt.length <= 1000) return { mode: value.mode, prompt: value.prompt };
  } catch { /* Defaults work even when browser storage is unavailable. */ }
  return DEFAULT_MODEL_CHECK;
}

/** Explicit clicks only. Opening settings never submits a model request. */
export function useModelAvailability() {
  const [defaults, setDefaults] = useState(readDefaults);
  const [checks, setChecks] = useState<Record<string, ModelCheckState>>({});
  const [storageNote, setStorageNote] = useState('');
  const [retryAt, setRetryAt] = useState(0);
  const [providerRetryAt, setProviderRetryAt] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now);
  const pending = useRef(new Map<string, AbortController>());
  const busy = Object.values(checks).some(check => check.busy);
  const cooldownActive = retryAt > now || Object.values(providerRetryAt).some(time => time > now);
  useEffect(() => {
    if (!busy && !cooldownActive) return;
    const timer = window.setInterval(() => {
      const time = Date.now(); setNow(time);
      setChecks(old => Object.fromEntries(Object.entries(old).map(([id, check]) => [id, check.busy ? { ...check, elapsedSeconds: Math.max(0, Math.floor((time - (check.startedAt || time)) / 1000)) } : check])));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy, cooldownActive]);
  useEffect(() => {
    const requests = pending.current;
    return () => { requests.forEach(controller => controller.abort()); requests.clear(); };
  }, []);
  const saveDefaults = (next: ModelCheckDefaults) => {
    const value = { mode: next.mode, prompt: next.prompt.trim() || DEFAULT_MODEL_CHECK.prompt };
    setDefaults(value);
    pending.current.forEach(controller => controller.abort()); pending.current.clear(); setChecks({});
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); setStorageNote('已保存此浏览器的默认检测设置。'); }
    catch { setStorageNote('本次已应用；浏览器未能保存，刷新后使用内置默认值。'); }
  };
  const run = async (modelRef: string, identity = modelRef) => {
    if (pending.current.has(identity) || retryAt > Date.now() || (providerRetryAt[modelRef.split('/')[0]] || 0) > Date.now()) return;
    const controller = new AbortController(), mode = defaults.mode;
    pending.current.set(identity, controller);
    setChecks(old => ({ ...old, [identity]: { busy: true, mode, startedAt: Date.now(), elapsedSeconds: 0 } }));
    try {
      const value = await probeModel(modelRef, mode, defaults.prompt, controller.signal);
      if (controller.signal.aborted) return;
      const result = decodeModelHealth({ results: [value] }).results[0];
      if (!result || result.modelRef !== modelRef || result.mode !== mode || !['success', 'failed'].includes(result.state)) throw new Error('检测回执不完整，请重新检测；当前结果未确认。');
      setChecks(old => ({ ...old, [identity]: { result, mode } }));
      if (result.retryAfterSeconds) { const time = Date.now(); setNow(time); setProviderRetryAt(old => ({ ...old, [modelRef.split('/')[0]]: time + result.retryAfterSeconds! * 1000 })); }
    } catch (cause) {
      if (!controller.signal.aborted) {
        if (cause instanceof ModelHealthRequestError && cause.retryAfterSeconds > 0) { const time = Date.now(); setNow(time); setRetryAt(time + cause.retryAfterSeconds * 1000); }
        setChecks(old => ({ ...old, [identity]: { mode, error: cause instanceof Error ? cause.message : '检测未完成，请重试。' } }));
      }
    } finally { if (pending.current.get(identity) === controller) pending.current.delete(identity); }
  };
  const cancel = (identity: string) => {
    const controller = pending.current.get(identity);
    if (!controller) return;
    controller.abort(); pending.current.delete(identity);
    setChecks(old => ({ ...old, [identity]: { mode: old[identity]?.mode || defaults.mode, cancelled: true, error: '已停止等待；服务端和供应商请求可能仍在完成，费用不一定取消。可稍后刷新状态，未自动重试。' } }));
  };
  const reportError = (identity: string, error: string) => setChecks(old => ({ ...old, [identity]: { mode: defaults.mode, error } }));
  const cooldownFor = (modelRef: string) => Math.max(0, Math.ceil((Math.max(retryAt, providerRetryAt[modelRef.split('/')[0]] || 0) - now) / 1000));
  return { defaults, checks, storageNote, saveDefaults, run, cancel, reportError, cooldownFor, cooldownSeconds: Math.max(0, Math.ceil((retryAt - now) / 1000)) };
}
export type ModelAvailabilityController = ReturnType<typeof useModelAvailability>;
