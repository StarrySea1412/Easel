import type { ComfyVideoJob, VideogenGalleryItem, VideogenJob } from './api';

/** 视频工坊图库条目 = 视频服务作品或 ComfyUI（模拟/真实）产物。 */
export interface StudioGalleryEntry {
  name: string;
  url: string;
  mtime: number;
  generation: VideogenJob;
  demo: boolean;
}

/** 合并视频服务作品与 ComfyUI 产物：只取已完成、按 url 去重、按时间倒序。 */
export function mergeStudioVideos(videos: VideogenGalleryItem[], comfyJobs: ComfyVideoJob[]): StudioGalleryEntry[] {
  const entries: StudioGalleryEntry[] = videos.map(item => ({ ...item, demo: false }));
  const seen = new Set(entries.map(item => item.url));
  for (const job of comfyJobs) {
    if (job.state !== 'done' || !job.url || seen.has(job.url)) continue;
    seen.add(job.url);
    const finished = job.finished || job.started || 0;
    const demo = job.mode === 'demo';
    entries.push({
      name: job.filename || `ComfyUI 视频 ${job.jobId.slice(0, 8)}`,
      url: job.url,
      mtime: Math.round(finished * 1000),
      demo,
      generation: {
        jobId: job.jobId, state: 'done', prompt: job.prompt, mode: 'text2video',
        provider: demo ? 'comfyui-demo' : 'comfyui',
        model: demo ? '本地占位（非模型生成）' : 'ComfyUI 工作流',
        ratio: '16:9', duration: 4, referenceId: null, started: job.started || 0,
        url: job.url, error: null, filename: job.filename || null, finished,
      },
    });
  }
  return entries.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
}
