import { useEffect, useRef, useState } from 'react';
import { decodeModelHealth, probeModel, type ModelHealthResult, type ModelProbeMode } from '../lib/modelHealth';

export const DEFAULT_MODEL_CHECK = { mode: 'text' as ModelProbeMode, prompt: '请只回复：连接成功' };
const STORAGE_KEY = 'easel:model-check-defaults:v1';
export type ModelCheckDefaults = typeof DEFAULT_MODEL_CHECK;
export type ModelCheckState = { busy?: boolean; result?: ModelHealthResult; error?: string; mode: ModelProbeMode };
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
  const pending = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const requests = pending.current;
    return () => { requests.forEach(controller => controller.abort()); requests.clear(); };
  }, []);
  const saveDefaults = (next: ModelCheckDefaults) => {
    const value = { mode: next.mode, prompt: next.prompt.trim() || DEFAULT_MODEL_CHECK.prompt };
    setDefaults(value);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); setStorageNote('已保存此浏览器的默认检测设置。'); }
    catch { setStorageNote('本次已应用；浏览器未能保存，刷新后使用内置默认值。'); }
  };
  const run = async (modelRef: string, identity = modelRef) => {
    if (pending.current.has(identity)) return;
    const controller = new AbortController(), mode = defaults.mode;
    pending.current.set(identity, controller);
    setChecks(old => ({ ...old, [identity]: { busy: true, mode } }));
    try {
      const value = await probeModel(modelRef, mode, defaults.prompt, controller.signal);
      if (controller.signal.aborted) return;
      const result = decodeModelHealth({ results: [value] }).results[0];
      if (!result || result.modelRef !== modelRef || result.mode !== mode || !['success', 'failed'].includes(result.state)) throw new Error('检测回执不完整，请重新检测；当前结果未确认。');
      setChecks(old => ({ ...old, [identity]: { result, mode } }));
    } catch (cause) {
      if (!controller.signal.aborted) setChecks(old => ({ ...old, [identity]: { mode, error: cause instanceof Error ? cause.message : '检测未完成，请重试。' } }));
    } finally { if (pending.current.get(identity) === controller) pending.current.delete(identity); }
  };
  return { defaults, checks, storageNote, saveDefaults, run };
}
export type ModelAvailabilityController = ReturnType<typeof useModelAvailability>;
