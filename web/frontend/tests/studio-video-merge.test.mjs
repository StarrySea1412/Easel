import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';

// ComfyUI（模拟/真实）产物并入视频工坊「最近视频」的纯函数规则。
const { mergeStudioVideos } = await loadTsModule('../src/lib/studioVideoMerge.ts', import.meta.url);

const providerItem = {
  name: 'old.mp4', url: '/api/media/AI生视频/old.mp4', mtime: 1000,
  generation: { jobId: 'v1', state: 'done', url: '/api/media/AI生视频/old.mp4' },
};
const demoJob = {
  jobId: 'demo123456', state: 'done', mode: 'demo', prompt: '海边日落',
  url: '/api/media/AI生视频/comfyui/demo-a.mp4', started: 30, finished: 40, filename: 'demo-a.mp4',
};
const liveJob = {
  jobId: 'live123456', state: 'done', mode: 'live', prompt: '真实任务',
  url: '/api/media/AI生视频/comfyui/live-b.mp4', started: 10, finished: 20, filename: 'live-b.mp4',
};

test('studio gallery merges comfy products with provider videos, newest first', () => {
  const merged = mergeStudioVideos([providerItem], [demoJob, liveJob]);
  assert.deepEqual(merged.map(entry => entry.name), ['demo-a.mp4', 'live-b.mp4', 'old.mp4']);
  assert.equal(merged[0].demo, true);
  assert.equal(merged[0].generation.provider, 'comfyui-demo');
  assert.match(merged[0].generation.model, /非模型生成/);
  assert.equal(merged[1].demo, false);
  assert.equal(merged[1].generation.provider, 'comfyui');
});

test('running, url-less and duplicate comfy jobs stay out of the gallery', () => {
  const merged = mergeStudioVideos([providerItem], [
    { ...demoJob, jobId: 'running', state: 'running' },
    { ...demoJob, jobId: 'nourl', url: null },
    { ...demoJob, jobId: 'dupx' },
    { ...liveJob, url: providerItem.url },
  ]);
  assert.deepEqual(merged.map(entry => entry.url), [demoJob.url, providerItem.url]);
  assert.equal(merged.length, 2, 'no duplicate urls and no unfinished jobs');
});
