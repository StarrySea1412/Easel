import { useEffect, useState } from 'react';
import { fetchOfficeTaskModels, type OfficeModelCapability } from '../lib/officeControls';
import { isCompleteModelRef, loadComposerModel, saveComposerModel } from '../lib/composerModel';
import { fetchModelHealth, type ModelHealthSnapshot } from '../lib/modelHealth';

export function useComposerModels(sessionId: string | null) {
  const [modelRef, setModelRef] = useState(loadComposerModel);
  const [capability, setCapability] = useState<OfficeModelCapability | null>(null);
  const [health, setHealth] = useState<ModelHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setCapability(null);
    fetchOfficeTaskModels(sessionId, controller.signal).then(value => { if (!controller.signal.aborted) setCapability(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '模型选项暂不可用。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    let readingHealth = false;
    const readHealth = () => {
      if (controller.signal.aborted || readingHealth) return;
      readingHealth = true;
      fetchModelHealth(controller.signal).then(value => { if (!controller.signal.aborted) setHealth(value); })
        .catch(() => { if (!controller.signal.aborted) setHealth(null); })
        .finally(() => { readingHealth = false; });
    };
    readHealth();
    const timer = setInterval(readHealth, 60000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [sessionId, revision]);
  const options = capability?.options.filter(option => option.configured && isCompleteModelRef(option.id)) || [];
  const selected = options.find(option => option.id === modelRef);
  const ready = !modelRef || (!loading && capability?.available === true && Boolean(selected));
  const choose = (value: string) => {
    if (value && (!capability?.available || !options.some(option => option.id === value))) return;
    setModelRef(value); setNotice(saveComposerModel(value) ? '' : '浏览器未能保存模型选择，刷新后请重新选择。');
  };
  return { modelRef, options, selected, ready, loading, capability, health, error, notice, choose, refresh: () => setRevision(value => value + 1),
    getSnapshot: () => ready ? { modelRef: modelRef || undefined } : null };
}
