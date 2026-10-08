import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelVideogenJob, fetchVideogenConfig, fetchVideogenJob, startVideogen, uploadImagegenReference } from '../lib/api';
import type { ImagegenGalleryItem, ImagegenReference, VideogenConfig, VideogenJob, VideogenMode } from '../lib/api';
import { restoreReference, validateReferenceFile } from '../lib/imageReferences';

const DRAFT_KEY = 'easel_videogen_draft';
const JOB_KEY = 'easel_videogen_job';
const VIEW_KEY = 'easel_studio_media';
function stored(key: string): unknown {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; }
}
function restoreDraft() {
  const value = stored(DRAFT_KEY) as Record<string, unknown> | null;
  return { prompt: typeof value?.prompt === 'string' ? value.prompt : '',
    providerId: typeof value?.providerId === 'string' ? value.providerId : '',
    ratio: ['16:9', '9:16', '1:1'].includes(String(value?.ratio)) ? String(value?.ratio) : '16:9',
    duration: typeof value?.duration === 'number' && Number.isInteger(value.duration) ? value.duration : null,
    reference: restoreReference(value?.reference) };
}
function restoreJob(): VideogenJob | null {
  const value = stored(JOB_KEY) as VideogenJob | null;
  return value && typeof value.jobId === 'string' && ['running', 'done', 'error', 'cancelled'].includes(value.state)
    && typeof value.prompt === 'string' && Number.isFinite(value.started)
    && ['text2video', 'image2video'].includes(value.mode) ? value : null;
}
function save(key: string, value: unknown) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Optional tab persistence. */ } }
export function closestVideoRatio(reference: ImagegenReference, ratios: string[]): string {
  return ratios.reduce((best, ratio) => {
    const distance = (candidate: string) => { const [w, h] = candidate.split(':').map(Number); return Math.abs(Math.log((w / h) / (reference.width / reference.height))); };
    return distance(ratio) < distance(best) ? ratio : best;
  }, ratios[0] || '16:9');
}

/** Lives in App so switching medium or leaving the studio never abandons a job. */
export function useVideoStudio(active: boolean) {
  const [viewMode, setViewMode] = useState<'image' | 'video'>(() => stored(VIEW_KEY) === 'video' ? 'video' : 'image');
  const [draft, setDraft] = useState(restoreDraft);
  const [job, setJob] = useState<VideogenJob | null>(restoreJob);
  const [config, setConfig] = useState<VideogenConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [configError, setConfigError] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const mounted = useRef(false);
  const activePage = useRef(active);
  const pending = useRef(false);
  const referencePending = useRef(false);
  const cancelPending = useRef(new Set<string>());
  const currentJobId = useRef(job?.jobId);
  const requestId = useRef(0);
  const running = job?.state === 'running';
  const busy = submitting || running;
  const locked = busy || referenceBusy;
  const cancelling = Boolean(job && cancellingId === job.jobId);
  const mode: VideogenMode = draft.reference ? 'image2video' : 'text2video';
  const provider = config?.providers.find(item => item.id === draft.providerId) || null;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { save(VIEW_KEY, viewMode); }, [viewMode]);
  useEffect(() => { save(DRAFT_KEY, draft); }, [draft]);
  useEffect(() => { save(JOB_KEY, job); }, [job]);
  useEffect(() => { currentJobId.current = job?.jobId; }, [job?.jobId]);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true); setConfigError('');
    try {
      const data = await fetchVideogenConfig();
      if (!mounted.current || id !== requestId.current) return;
      setConfig(data);
      setDraft(current => {
        const selected = data.providers.find(item => item.id === current.providerId)
          || data.providers.find(item => item.id === data.defaultProvider)
          || data.providers.find(item => item.configured) || data.providers[0];
        return selected ? { ...current, providerId: selected.id,
          ratio: selected.ratios.includes(current.ratio) ? current.ratio : selected.ratios[0] || '16:9',
          duration: current.duration !== null && selected.durations.includes(current.duration) ? current.duration : null } : current;
      });
      // Recover server-side work after storage was cleared without replacing a newer task.
      setJob(current => current || (pending.current ? null : data.jobs.find(item => item.state === 'running') || null));
    } catch (e) { if (mounted.current && id === requestId.current) setConfigError(e instanceof Error ? e.message : '视频服务读取失败'); }
    finally { if (mounted.current && id === requestId.current) setLoading(false); }
  }, []);
  useEffect(() => { activePage.current = active; if (active) void refresh(); }, [active, refresh]);

  useEffect(() => {
    if (!job || job.state !== 'running') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await fetchVideogenJob(job.jobId);
        if (!alive) return;
        setError('');
        if (next.state !== 'running') {
          setJob(next);
          if (next.state === 'done') {
            window.dispatchEvent(new Event('easel:outputs-updated'));
            if (activePage.current) void refresh();
          }
          return;
        }
      } catch (e) {
        if (!alive) return;
        if (e instanceof Error && 'status' in e && e.status === 404) {
          setJob({ ...job, state: 'error', error: '任务已过期或服务已重启，请先查看最近视频，再重新生成。' });
          return;
        }
        setError(`暂时无法读取视频进度，将自动重试：${e instanceof Error ? e.message : '连接失败'}`);
      }
      timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [job, refresh]);
  useEffect(() => {
    if (!job || job.state !== 'running') return;
    const update = () => setTick(Math.max(0, Math.floor(Date.now() / 1000 - job.started)));
    update(); const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [job]);

  const selectProvider = (providerId: string) => {
    if (pending.current || referencePending.current || running) return;
    const selected = config?.providers.find(item => item.id === providerId);
    if (selected) setDraft(current => ({ ...current, providerId, duration: null,
      ratio: current.reference ? closestVideoRatio(current.reference, selected.ratios) : selected.ratios.includes(current.ratio) ? current.ratio : selected.ratios[0] || '16:9' }));
    setError('');
  };
  const applyReference = (reference: ImagegenReference) => {
    setDraft(current => {
      const selected = config?.providers.find(item => item.id === current.providerId && item.modes.includes('image2video'))
        || config?.providers.find(item => item.configured && item.modes.includes('image2video'))
        || config?.providers.find(item => item.modes.includes('image2video'));
      return { ...current, reference, providerId: selected?.id || current.providerId, duration: null,
        ratio: closestVideoRatio(reference, selected?.ratios || ['16:9', '9:16', '1:1']) };
    });
    setError('');
  };
  const useReference = (reference: ImagegenReference) => {
    if (pending.current || referencePending.current || running) return;
    setViewMode('video'); applyReference(reference);
  };
  const uploadReference = async (file: File): Promise<ImagegenReference | null> => {
    if (!mounted.current || pending.current || referencePending.current || running) return null;
    referencePending.current = true; setReferenceBusy(true); setError('');
    try {
      validateReferenceFile(file);
      const reference = await uploadImagegenReference(file);
      if (!mounted.current) return null;
      applyReference(reference);
      return reference;
    }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '参考图上传失败'); return null; }
    finally { referencePending.current = false; if (mounted.current) setReferenceBusy(false); }
  };
  const useGalleryReference = async (item: ImagegenGalleryItem) => {
    if (pending.current || referencePending.current || running) return;
    // Switch immediately so upload errors are visible while the image draft stays untouched.
    setViewMode('video'); referencePending.current = true; setReferenceBusy(true); setError('');
    try {
      const url = new URL(item.url, window.location.href);
      if (url.origin !== window.location.origin) throw new Error('仅支持使用本地图库图片作为参考。');
      const response = await fetch(url.href);
      if (!response.ok) throw new Error('历史图片读取失败，请重新上传。');
      const blob = await response.blob();
      const file = new File([blob], item.name, { type: blob.type });
      validateReferenceFile(file);
      const reference = await uploadImagegenReference(file);
      if (mounted.current) applyReference(reference);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '参考图读取失败'); }
    finally { referencePending.current = false; if (mounted.current) setReferenceBusy(false); }
  };
  const clearReference = () => {
    if (!pending.current && !referencePending.current && !running) { setDraft(current => ({ ...current, reference: null })); setError(''); }
  };
  const generate = async () => {
    const prompt = draft.prompt.trim();
    if (pending.current || referencePending.current || running || loading || configError || !provider?.configured || !prompt || prompt.length > 2000) return;
    if (!provider.modes.includes(mode)) { setError('当前视频模型不支持这种生成方式，请切换服务或移除参考图。'); return; }
    pending.current = true; setSubmitting(true); setError('');
    try {
      const options = { prompt, mode, provider: provider.id, ratio: draft.ratio, duration: draft.duration, referenceId: draft.reference?.id || null };
      const { jobId } = await startVideogen(options);
      const next: VideogenJob = { ...options, jobId, state: 'running', model: mode === 'image2video' ? provider.imageModel : provider.model, started: Date.now() / 1000, url: null, error: null };
      save(JOB_KEY, next); if (mounted.current) setJob(next);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '视频提交失败'); }
    finally { pending.current = false; if (mounted.current) setSubmitting(false); }
  };
  const cancel = async () => {
    if (!job || job.state !== 'running' || cancelPending.current.has(job.jobId)) return;
    const identifier = job.jobId;
    cancelPending.current.add(identifier); setCancellingId(identifier); setError('');
    try {
      const next = await cancelVideogenJob(identifier);
      // The old job may finish through polling and a new job may start while
      // this response is in flight. Cancellation belongs only to its target.
      if (mounted.current) setJob(current => current?.jobId === identifier ? next : current);
    } catch (e) {
      if (mounted.current && !pending.current && currentJobId.current === identifier) setError(e instanceof Error ? e.message : '停止等待失败');
    } finally {
      cancelPending.current.delete(identifier);
      if (mounted.current) setCancellingId(current => current === identifier ? null : current);
    }
  };
  return { ...draft, viewMode, setViewMode, job, config, provider, mode, loading, configError, error, submitting, referenceBusy, cancelling, tick, busy, locked,
    refresh, generate, cancel, selectProvider, useReference, uploadReference, useGalleryReference, clearReference,
    setPrompt: (prompt: string) => setDraft(current => ({ ...current, prompt })),
    setRatio: (ratio: string) => { if (!locked && provider?.ratios.includes(ratio)) setDraft(current => ({ ...current, ratio })); },
    setDuration: (duration: number | null) => { if (!locked && (duration === null || provider?.durations.includes(duration))) setDraft(current => ({ ...current, duration })); },
    previewJob: (selected: VideogenJob) => { if (!pending.current && !referencePending.current && !running) { setJob(selected); setError(''); } },
  };
}
export type VideoStudioController = ReturnType<typeof useVideoStudio>;
