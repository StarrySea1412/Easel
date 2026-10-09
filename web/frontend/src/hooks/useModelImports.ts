import { useCallback, useEffect, useRef, useState } from 'react';
import { applyImport, fetchImportSources, previewImport } from '../lib/api';
import type { ImportPreview, ImportSource, ModelRow } from '../lib/api';
import { modelImportSlotLabel } from '../lib/modelImports';

/** Model settings can select local configurations without leaving the model page. */
export function useModelImport({ onApplied, onBusyChange }: {
  onApplied: (row: ModelRow) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [sources, setSources] = useState<ImportSource[]>([]);
  const [loadingSources, setLoadingSources] = useState(true);
  const [source, setSource] = useState('saved');
  const [slot, setSlot] = useState('auto');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [pick, setPick] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'' | 'preview' | 'apply'>('');
  const [message, setMessage] = useState('');
  const alive = useRef(true);
  const requestId = useRef(0);
  const applying = useRef(false);
  const callbacks = useRef({ onApplied, onBusyChange });
  callbacks.current = { onApplied, onBusyChange };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      requestId.current += 1;
      callbacks.current.onBusyChange(false);
    };
  }, []);

  const refreshSources = useCallback(async () => {
    setLoadingSources(true);
    try {
      const data = await fetchImportSources();
      if (alive.current) { setSources(data.sources); setMessage(''); }
    } catch (error) {
      if (alive.current) setMessage(`读取来源失败：${error instanceof Error ? error.message : '请重试'}`);
    } finally {
      if (alive.current) setLoadingSources(false);
    }
  }, []);
  useEffect(() => { void refreshSources(); }, [refreshSources]);

  const read = useCallback(async (nextSource: string, nextSlot: string) => {
    if (applying.current) return;
    const id = ++requestId.current;
    setSource(nextSource);
    setSlot(nextSlot);
    setPreview(null);
    setPick('');
    setConfirmed(false);
    setMessage('');
    if (nextSource === 'saved') { setBusy(''); return; }
    setBusy('preview');
    try {
      const data = await previewImport(nextSource, nextSlot);
      if (!alive.current || id !== requestId.current) return;
      setPreview(data);
      if (!data.candidates.length) setMessage('此来源没有可选择的模型配置。可刷新来源，或在配置导入页指定文件路径。');
    } catch (error) {
      if (alive.current && id === requestId.current) {
        setMessage(`读取配置失败：${error instanceof Error ? error.message : '请重试'}`);
      }
    } finally {
      if (alive.current && id === requestId.current) setBusy('');
    }
  }, []);

  const selected = preview?.candidates.find((candidate) => candidate.id === pick);
  const apply = useCallback(async () => {
    if (!selected?.compatible || !selected.previewToken || !confirmed || applying.current) return;
    applying.current = true;
    setBusy('apply');
    callbacks.current.onBusyChange(true);
    setMessage('');
    try {
      const targetSlot = selected.targetSlot || slot;
      const result = await applyImport(source, selected.id, targetSlot, preview?.path || '', selected.previewToken);
      const row = result.channels.chat.rows.find((item) => item.slot === targetSlot);
      if (row) callbacks.current.onApplied(row);
      if (alive.current) {
        setPreview(null);
        setPick('');
        setConfirmed(false);
        setMessage(`已导入并保存 ${selected.name} · ${selected.model || '保留原模型'} → ${modelImportSlotLabel(targetSlot)}。如需切换主模型，在「当前配置」选择后再保存。`);
      }
    } catch (error) {
      if (alive.current) {
        setMessage(`导入失败：${error instanceof Error ? error.message : '请重试'}。请重新读取候选后核对。`);
        setConfirmed(false);
      }
    } finally {
      applying.current = false;
      callbacks.current.onBusyChange(false);
      if (alive.current) setBusy('');
    }
  }, [selected, confirmed, source, slot, preview]);

  return { sources, loadingSources, source, slot, preview, pick, selected, confirmed, busy, message,
    refreshSources, read, apply, setConfirmed,
    selectCandidate: (id: string) => { setPick(id); setConfirmed(false); },
  };
}
