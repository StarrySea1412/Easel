import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchImageReverseConfig, reverseImage } from '../lib/api';
import type { ImageReverseProvider, ImageReverseResult } from '../lib/api';

export function useImageReverse(active: boolean) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [providers, setProviders] = useState<ImageReverseProvider[]>([]);
  const [provider, setProvider] = useState('');
  const [modelRef, setModelRef] = useState('');
  const [instruction, setInstruction] = useState('');
  const [mode, setMode] = useState<'auto' | 'vision'>('auto');
  const [language, setLanguage] = useState<'zh' | 'en'>('zh');
  const [result, setResult] = useState<ImageReverseResult | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [configError, setConfigError] = useState('');
  const [configLoading, setConfigLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setConfigLoading(true);
    fetchImageReverseConfig().then(({ providers: rows, modelRef: saved }) => {
      if (!alive) return;
      setProviders(rows);
      const selected = rows.find(row => row.configured && `${row.id}/${row.model}` === (saved || modelRef));
      setProvider(selected?.id || '');
      setModelRef(saved || modelRef);
      setConfigError('');
    }).catch((e: unknown) => { if (alive) setConfigError(e instanceof Error ? e.message : '模型配置读取失败'); })
      .finally(() => { if (alive) setConfigLoading(false); });
    return () => { alive = false; };
  // Selection changes should not reload configuration while a request is in progress.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!file) { setPreview(''); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => () => pending.current?.abort(), []);

  const selectFile = useCallback((next: File | null) => {
    if (next && (!['image/png', 'image/jpeg', 'image/webp'].includes(next.type) || next.size > 8 * 1024 * 1024)) {
      setError('请选择 8 MB 以内的 PNG、JPEG 或 WebP 图片。');
      return;
    }
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setFile(next); setResult(null); setPrompt(''); setError('');
  }, []);

  const run = useCallback(async () => {
    if (!file || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true); setError(''); setResult(null); setPrompt('');
    try {
      const data = await reverseImage(file, provider, instruction.trim(), mode, language, controller.signal, modelRef);
      if (pending.current === controller) { setResult(data); setPrompt(data.prompt); }
    } catch (e) {
      if (pending.current === controller && !controller.signal.aborted) setError(e instanceof Error ? e.message : '反推失败，请重试');
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  }, [file, provider, instruction, mode, language, modelRef]);

  const chooseProvider = (id: string) => { setProvider(id); const row = providers.find(item => item.id === id); setModelRef(row ? `${row.id}/${row.model}` : ''); };
  return { file, preview, selectFile, providers, provider, setProvider: chooseProvider, instruction, setInstruction,
    mode, setMode, language, setLanguage, result, prompt, setPrompt, busy, error, configError, configLoading, run };
}
