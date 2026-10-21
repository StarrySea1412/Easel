import { useEffect, useState, useSyncExternalStore } from 'react';
import { fetchOfficeTaskModels, type OfficeModelCapability } from '../lib/officeControls';
import { isCompleteModelRef, loadComposerModel, saveComposerModel, subscribeComposerModel } from '../lib/composerModel';
import { fetchModelHealth, type ModelHealthSnapshot } from '../lib/modelHealth';
import { fetchChannelConnection, type ChannelConnection } from '../lib/channelStatus';
import { useCodexModels } from './useCodexModels';

export function useComposerModels(sessionId: string | null, engine: 'openclaw'|'codex' = 'openclaw') {
  const openclaw = useOpenclawComposerModels(sessionId, engine === 'openclaw');
  const codex = useCodexModels(engine === 'codex');
  return engine === 'codex' ? codex : openclaw;
}
function useOpenclawComposerModels(sessionId: string | null, enabled: boolean) {
  const modelRef = useSyncExternalStore(subscribeComposerModel, loadComposerModel);
  const [capability, setCapability] = useState<OfficeModelCapability | null>(null);
  const [health, setHealth] = useState<ModelHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [connection, setConnection] = useState<ChannelConnection | null>(null);
  useEffect(() => {
    const changed = () => setRevision(value => value + 1);
    window.addEventListener('easel:channel-names-changed', changed);
    return () => window.removeEventListener('easel:channel-names-changed', changed);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); setLoading(true); setError('');
    let readingCapability = false;
    const readCapability = async () => {
      if (controller.signal.aborted || readingCapability) return;
      readingCapability = true;
      try {
        const value = await fetchOfficeTaskModels(sessionId, controller.signal, modelRef || undefined);
        if (!controller.signal.aborted) { setCapability(value); setError(''); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '模型选项暂未读取。');
      } finally {
        readingCapability = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void readCapability();
    let readingHealth = false;
    const readHealth = () => {
      if (controller.signal.aborted || readingHealth) return;
      readingHealth = true;
      fetchModelHealth(controller.signal).then(value => { if (!controller.signal.aborted) setHealth(value); })
        .catch(() => { if (!controller.signal.aborted) setHealth(null); })
        .finally(() => { readingHealth = false; });
    };
    readHealth();
    const timer = setInterval(() => { readHealth(); void readCapability(); }, 60000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [sessionId, revision, enabled, modelRef]);
  const options = capability?.options.filter(option => option.configured && isCompleteModelRef(option.id)) || [];
  const selected = options.find(option => option.id === modelRef && option.enabled !== false);
  const effectiveRef = selected?.id || capability?.currentModelRef || capability?.defaultModelRef || '';
  const effectiveDisabled = options.find(option => option.id === effectiveRef)?.enabled === false;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setConnection(effectiveRef && !effectiveDisabled ? { modelRef: effectiveRef, state: 'running', channelName: '正在读取渠道', detail: '正在读取已保存渠道的模型列表…' } : null);
    if (effectiveRef && !effectiveDisabled) fetchChannelConnection(effectiveRef, controller.signal)
      .then(value => { if (!controller.signal.aborted) setConnection(value); })
      .catch(cause => { if (!controller.signal.aborted) setConnection({ modelRef: effectiveRef, state: 'failed', channelName: '渠道状态未知', detail: cause instanceof Error ? cause.message : '模型列表读取失败。' }); });
    return () => controller.abort();
  }, [effectiveRef, effectiveDisabled, revision, enabled]);
  const automaticDisabled = options.find(option => option.id === (capability?.currentModelRef || capability?.defaultModelRef))?.enabled === false;
  const ready = modelRef ? Boolean(selected) : !automaticDisabled;
  const choose = (value: string) => {
    if (value && !options.some(option => option.id === value && option.enabled !== false)) return;
    setNotice(saveComposerModel(value) ? '' : '浏览器未能保存模型选择，刷新后请重新选择。');
  };
  return { modelRef, options, selected, ready, loading, capability, health, connection: connection?.modelRef === effectiveRef ? connection : null, error, notice, choose, refresh: () => setRevision(value => value + 1),
    getSnapshot: () => ready ? { modelRef: modelRef || undefined } : null };
}
