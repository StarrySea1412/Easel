import { useState, useEffect, useRef, useCallback } from 'react';
import { startImagegen, fetchImagegenJob, fetchImagegenGallery } from '../lib/api';
import type { ImagegenJob, ImagegenGalleryItem, ImagegenChannel } from '../lib/api';
import { useImageReverse } from './useImageReverse';

export const IMAGE_SIZES: { id: string; label: string; ratio: string; use: string }[] = [
  { id: '1024x1024', label: '方图 1:1', ratio: '1 / 1', use: '头像 / 产品' },
  { id: '768x1024', label: '竖图 3:4', ratio: '3 / 4', use: '小红书 / 图文' },
  { id: '1024x768', label: '横图 4:3', ratio: '4 / 3', use: '文章 / 配图' },
  { id: '864x1536', label: '竖屏 9:16', ratio: '9 / 16', use: '短视频 / 壁纸' },
  { id: '1536x864', label: '宽屏 16:9', ratio: '16 / 9', use: '视频 / 封面' },
  { id: '1024x1280', label: '竖图 4:5', ratio: '4 / 5', use: '社交 / 海报' },
  { id: '1280x1024', label: '横图 5:4', ratio: '5 / 4', use: '展陈 / 产品' },
  { id: '1024x1536', label: '竖图 2:3', ratio: '2 / 3', use: '人像 / 海报' },
  { id: '1536x1024', label: '横图 3:2', ratio: '3 / 2', use: '摄影 / 场景' },
  { id: 'auto', label: '自动尺寸', ratio: '1 / 1', use: '由模型决定' },
];
const IMAGE_JOB_KEY = 'easel_imagegen_job';
const IMAGE_DRAFT_KEY = 'easel_imagegen_draft';
type ImageStudioJob = ImagegenJob & { size: string };

function imageSize(value: unknown): string {
  return IMAGE_SIZES.find((item) => item.id === value)?.id || IMAGE_SIZES[0].id;
}

function restoreImageDraft(): { prompt: string; size: string } {
  try {
    const draft = JSON.parse(sessionStorage.getItem(IMAGE_DRAFT_KEY) || 'null');
    return { prompt: typeof draft?.prompt === 'string' ? draft.prompt : '', size: imageSize(draft?.size) };
  } catch { return { prompt: '', size: IMAGE_SIZES[0].id }; }
}

function restoreImageJob(): ImageStudioJob | null {
  try {
    const job = JSON.parse(sessionStorage.getItem(IMAGE_JOB_KEY) || 'null');
    return job && typeof job.jobId === 'string' && ['running', 'done', 'error'].includes(job.state)
      && typeof job.prompt === 'string' && Number.isFinite(job.started)
      && (job.url === null || typeof job.url === 'string') && (job.error === null || typeof job.error === 'string')
      ? { ...job, size: imageSize(job.size ?? restoreImageDraft().size) } : null;
  } catch { return null; }
}

export function useImageStudio(active: boolean) {
  const reverse = useImageReverse(active);
  const [mode, setMode] = useState<'generate' | 'reverse'>('generate');
  const mounted = useRef(false);
  const activePage = useRef(active);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // ── AI 生图工坊 ──
  const [imgPrompt, setImgPrompt] = useState(() => restoreImageDraft().prompt);
  const [imgSize, setImgSize] = useState(() => restoreImageDraft().size);
  const [imgJob, setImgJob] = useState<ImageStudioJob | null>(restoreImageJob);
  const [imgSubmitting, setImgSubmitting] = useState(false);
  const imgSubmitPending = useRef(false);
  const [imgErr, setImgErr] = useState('');
  const [imgTick, setImgTick] = useState(0);
  const [gallery, setGallery] = useState<ImagegenGalleryItem[]>([]);
  const [imgChannel, setImgChannel] = useState<ImagegenChannel | null>(null);

  const [loading, setLoading] = useState(true);
  const [galleryError, setGalleryError] = useState('');
  const galleryRequest = useRef(0);
  const refreshGallery = useCallback(async () => {
    const request = ++galleryRequest.current;
    setLoading(true);
    setGalleryError('');
    try {
      const data = await fetchImagegenGallery();
      if (mounted.current && request === galleryRequest.current) { setGallery(data.images || []); setImgChannel(data.channel); }
    } catch (e) {
      if (mounted.current && request === galleryRequest.current) setGalleryError(e instanceof Error ? e.message : '加载失败');
    } finally { if (mounted.current && request === galleryRequest.current) setLoading(false); }
  }, []);
  useEffect(() => {
    activePage.current = active;
    if (active) void refreshGallery();
  }, [active, refreshGallery]);
  // 控制器驻留 App；草稿与任务保留到当前标签页，切页和刷新均可恢复。
  useEffect(() => {
    try { sessionStorage.setItem(IMAGE_DRAFT_KEY, JSON.stringify({ prompt: imgPrompt, size: imgSize })); }
    catch { /* 隐私模式下仍保留当前 App 内的草稿。 */ }
  }, [imgPrompt, imgSize]);
  useEffect(() => {
    try {
      if (imgJob) sessionStorage.setItem(IMAGE_JOB_KEY, JSON.stringify(imgJob));
      else sessionStorage.removeItem(IMAGE_JOB_KEY);
    } catch { /* 隐私模式不可持久化时仍可在当前页面使用。 */ }
  }, [imgJob]);

  // 上一轮请求结束后再计时，避免慢接口导致重复轮询。
  useEffect(() => {
    if (imgJob?.state !== 'running') return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const job = await fetchImagegenJob(imgJob.jobId);
        if (!alive) return;
        setImgErr('');
        if (job.state !== 'running') {
          setImgJob({ ...job, size: imageSize(job.size || imgJob.size) });
          if (job.state === 'done') window.dispatchEvent(new Event('easel:outputs-updated'));
          if (job.state === 'done' && activePage.current) void refreshGallery();
          return;
        }
      } catch (e) {
        if (!alive) return;
        if (e instanceof Error && 'status' in e && e.status === 404) {
          setImgJob({ ...imgJob, state: 'error', error: '任务已过期或服务已重启，请查看历史图片后重新生成。' });
          return;
        }
        setImgErr(`暂时无法读取任务进度，将自动重试：${e instanceof Error ? e.message : '连接失败'}`);
      }
      timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [imgJob, refreshGallery]);

  // 生成等待计时：SkeletonImage 上显示已等待秒数（聚合站慢，明确告知比无限转圈安心）
  useEffect(() => {
    if (imgJob?.state !== 'running') return undefined;
    const update = () => setImgTick(Math.max(0, Math.floor(Date.now() / 1000 - imgJob.started)));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [imgJob]);

  const fireImagegen = useCallback(async () => {
    const p = imgPrompt.trim();
    if (!p || p.length > 2000 || !imgChannel?.configured || imgJob?.state === 'running' || imgSubmitPending.current) return;
    imgSubmitPending.current = true;
    setImgSubmitting(true);
    setImgErr('');
    try {
      const { jobId } = await startImagegen(p, imgSize);
      const job: ImageStudioJob = { jobId, state: 'running', prompt: p, size: imgSize, url: null, error: null, started: Date.now() / 1000 };
      try { sessionStorage.setItem(IMAGE_JOB_KEY, JSON.stringify(job)); } catch { /* optional */ }
      if (mounted.current) setImgJob(job);
    } catch (e) {
      if (mounted.current) setImgErr(e instanceof Error ? e.message : '发起失败');
    } finally {
      imgSubmitPending.current = false;
      if (mounted.current) setImgSubmitting(false);
    }
  }, [imgPrompt, imgSize, imgJob, imgChannel]);

  return { imgPrompt, setImgPrompt, imgSize, setImgSize, imgJob, imgSubmitting, imgErr,
    imgTick, gallery, imgChannel, loading, galleryError, refreshGallery, fireImagegen, reverse, mode, setMode };
}

export type ImageStudioController = ReturnType<typeof useImageStudio>;
