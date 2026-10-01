import { useState, useEffect, useRef, useCallback } from 'react';
import { startImagegen, fetchImagegenJob, fetchImagegenGallery, uploadImagegenReference } from '../lib/api';
import type { ImagegenJob, ImagegenGalleryItem, ImagegenChannel, ImagegenReference } from '../lib/api';
import { restoreReference, validateReferenceFile, validateMaskFile } from '../lib/imageReferences';
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

/** Choose a supported ratio; 'auto' is not a promise to preserve source size. */
export function closestImageSize(width: number, height: number): string {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width / height)) return IMAGE_SIZES[0].id;
  const choices = IMAGE_SIZES.filter(item => item.id !== 'auto');
  const distance = (id: string) => {
    const [w, h] = id.split('x').map(Number);
    return Math.abs(Math.log((w / h) / (width / height)));
  };
  return choices.reduce((best, item) => distance(item.id) < distance(best.id) ? item : best).id;
}
type ImageStudioJob = ImagegenJob & { size: string };

function imageSize(value: unknown): string {
  return IMAGE_SIZES.find((item) => item.id === value)?.id || IMAGE_SIZES[0].id;
}

function restoreImageDraft(): { prompt: string; size: string; mode: 'generate'|'img2img'|'reverse'; reference:ImagegenReference|null; mask:ImagegenReference|null } {
  try {
    const draft = JSON.parse(sessionStorage.getItem(IMAGE_DRAFT_KEY) || 'null');
    return { prompt: typeof draft?.prompt === 'string' ? draft.prompt : '', size: imageSize(draft?.size), mode: draft?.mode==='img2img'?'img2img':draft?.mode==='reverse'?'reverse':'generate', reference:restoreReference(draft?.reference), mask:restoreReference(draft?.mask) };
  } catch { return { prompt: '', size: IMAGE_SIZES[0].id, mode:'generate',reference:null,mask:null }; }
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
  const [mode, setMode] = useState<'generate' | 'img2img' | 'reverse'>(()=>restoreImageDraft().mode);
  const [reference, setReference] = useState<ImagegenReference|null>(()=>restoreImageDraft().reference);
  const [mask, setMask] = useState<ImagegenReference|null>(()=>restoreImageDraft().mask);
  const [referenceBusy,setReferenceBusy] = useState(false);
  const referencePending = useRef(false);
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
    try { sessionStorage.setItem(IMAGE_DRAFT_KEY, JSON.stringify({ prompt: imgPrompt, size: imgSize, mode, reference, mask })); }
    catch { /* 隐私模式下仍保留当前 App 内的草稿。 */ }
  }, [imgPrompt, imgSize, mode, reference, mask]);
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
    if(referencePending.current)return;
    if(mode==='img2img'&&!reference){setImgErr('请先上传参考图。');return;}
    imgSubmitPending.current = true;
    setImgSubmitting(true);
    setImgErr('');
    try {
      const options = mode==='img2img' ? {mode:'img2img' as const,referenceId:reference!.id,...(mask?{maskId:mask.id}:{})} : {mode:'text2img' as const};
      const { jobId } = await startImagegen(p, imgSize, 1, options);
      const job: ImageStudioJob = { jobId, state: 'running', prompt: p, size: imgSize, url: null, error: null, started: Date.now() / 1000, ...options };
      try { sessionStorage.setItem(IMAGE_JOB_KEY, JSON.stringify(job)); } catch { /* optional */ }
      if (mounted.current) setImgJob(job);
    } catch (e) {
      if (mounted.current) setImgErr(e instanceof Error ? e.message : '发起失败');
    } finally {
      imgSubmitPending.current = false;
      if (mounted.current) setImgSubmitting(false);
    }
  }, [imgPrompt, imgSize, imgJob, imgChannel, mode, reference, mask]);

  const uploadReference = useCallback(async (file:File, isMask=false) => {
    if(referencePending.current || imgSubmitPending.current || imgJob?.state==='running')return;
    referencePending.current=true;setReferenceBusy(true);setImgErr('');
    try {
      validateReferenceFile(file,isMask);
      if(isMask){if(!reference)throw new Error('请先上传参考图，再上传同尺寸蒙版。');await validateMaskFile(file,reference);}
      const uploaded=await uploadImagegenReference(file);
      if(!mounted.current)return;
      if(isMask)setMask(uploaded);else{setReference(uploaded);setMask(null);setMode('img2img');setImgSize(closestImageSize(uploaded.width,uploaded.height));}
    } catch(e){if(mounted.current)setImgErr(e instanceof Error?e.message:'图片上传失败。');}
    finally{referencePending.current=false;if(mounted.current)setReferenceBusy(false);}
  },[imgJob,reference]);
  const useGalleryReference = useCallback(async (item:ImagegenGalleryItem) => {
    if(referencePending.current || imgSubmitPending.current || imgJob?.state==='running')return;
    setImgErr('');referencePending.current=true;setReferenceBusy(true);
    try {
      const url=new URL(item.url,window.location.href);
      if(url.origin!==window.location.origin)throw new Error('仅支持使用本地图库图片作为参考。');
      const response=await fetch(url.href);if(!response.ok)throw new Error('历史图片读取失败，请重新上传。');
      const blob=await response.blob();const file=new File([blob],item.name,{type:blob.type});validateReferenceFile(file);const uploaded=await uploadImagegenReference(file);if(mounted.current){setReference(uploaded);setMask(null);setMode('img2img');setImgSize(closestImageSize(uploaded.width,uploaded.height));}
    }catch(e){if(mounted.current)setImgErr(e instanceof Error?e.message:'读取参考图失败。');}
    finally{referencePending.current=false;if(mounted.current)setReferenceBusy(false);}
  },[imgJob]);
  const clearReference = () => {if(!referencePending.current&&!imgSubmitPending.current&&imgJob?.state!=='running'){setReference(null);setMask(null);setMode('generate');}};
  const clearMask = () => {if(!referencePending.current&&!imgSubmitPending.current&&imgJob?.state!=='running')setMask(null);};
  return { reference,mask,referenceBusy,uploadReference,useGalleryReference,clearReference,clearMask,imgPrompt, setImgPrompt, imgSize, setImgSize, imgJob, imgSubmitting, imgErr,
    imgTick, gallery, imgChannel, loading, galleryError, refreshGallery, fireImagegen, reverse, mode, setMode };
}

export type ImageStudioController = ReturnType<typeof useImageStudio>;
