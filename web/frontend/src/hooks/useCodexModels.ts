import { useEffect, useState } from 'react';
import { fetchCodexRuntime, type CodexRuntime } from '../lib/codex';
import type { OfficeModelCapability } from '../lib/officeControls';
import type { ModelHealthSnapshot } from '../lib/modelHealth';
import type { ChannelConnection } from '../lib/channelStatus';
import { readLocalValue, writeLocalValue } from '../lib/localPersistence';

export function useCodexModels(enabled: boolean) {
  const [runtime, setRuntime] = useState<CodexRuntime | null>(null);
  const [modelRef, setModelRef] = useState(() => readLocalValue('easel:codex-model').value || '');
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); setLoading(true); setError('');
    fetchCodexRuntime(controller.signal).then(value => { if (!controller.signal.aborted) setRuntime(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Codex 检测失败。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled, revision]);
  const options = runtime?.options || [], selected = options.find(option => option.id === modelRef);
  const available = runtime?.available === true && runtime.auth !== 'login_required';
  const capability: OfficeModelCapability = {available, scope: available ? 'next_turn' : 'unavailable', currentModelRef: null,
    defaultModelRef: runtime?.defaultModelRef, options, reason: runtime?.error || (runtime?.auth === 'login_required' ? '请登录本机 Codex。' : '本机 Codex 模型能力。')};
  const ready = !loading && available && (!modelRef || Boolean(selected));
  return {modelRef, options, selected, ready, loading, capability, health: null as ModelHealthSnapshot | null,
    connection: null as ChannelConnection | null, error: error || runtime?.error || '', notice: '',
    choose: (value: string) => { if (!value || options.some(option => option.id === value)) { setModelRef(value); writeLocalValue('easel:codex-model', value); } },
    refresh: () => setRevision(value => value + 1), getSnapshot: () => ready ? {modelRef: modelRef || runtime?.defaultModelRef} : null,
  };
}
