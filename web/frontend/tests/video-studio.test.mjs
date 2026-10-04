import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Real studio page, both real controllers and API client; HTTP and DOM are
// simulated. No paid generation or actual video decoding happens in this suite.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.sessionStorage = window.sessionStorage;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Event = window.Event;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Page } = await loadTsModule('../src/components/ImageStudioPage.tsx', import.meta.url);
const { useImageStudio } = await loadTsModule('../src/hooks/useImageStudio.ts', import.meta.url);
const { useVideoStudio } = await loadTsModule('../src/hooks/useVideoStudio.ts', import.meta.url);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const reference = { id: 'source', name: '原图.png', url: '/api/imagegen/references/source', width: 1600, height: 900 };
const imageDraft = { prompt: '保留图片草稿', size: '1536x864', mode: 'img2img', reference, mask: null };
const videoDraft = { prompt: '  镜头缓慢推进  ', providerId: 'text', ratio: '16:9', duration: null, reference: null };
const providers = [
  { id: 'text', name: '文生模型', configured: true, model: 'test-t2v', imageModel: 'test-t2v', modes: ['text2video'], ratios: ['16:9', '9:16', '1:1'], durations: [5], hint: '只支持文字' },
  { id: 'both', name: '图文模型', configured: true, model: 'test-video', imageModel: 'test-image-video', modes: ['text2video', 'image2video'], ratios: ['16:9', '9:16'], durations: [5, 10], hint: '测试服务' },
];
const config = { providers, defaultProvider: 'text', videos: [], jobs: [], cancelHint: '仅停止本地等待，服务商可能继续计费。', billingHint: '调用服务可能产生费用。' };

async function fixture(t, options = {}) {
  sessionStorage.clear();
  sessionStorage.setItem('easel_imagegen_draft', JSON.stringify(imageDraft));
  sessionStorage.setItem('easel_videogen_draft', JSON.stringify(videoDraft));
  if (options.job) sessionStorage.setItem('easel_videogen_job', JSON.stringify(options.job));
  const requests = [];
  t.mock.method(globalThis, 'fetch', (url, init = {}) => {
    const request = { url: String(url), init, method: init.method || 'GET' }; requests.push(request);
    if (url === '/api/image-reverse/config') return Promise.resolve(json({ providers: [] }));
    if (url === '/api/imagegen' && request.method === 'GET') return Promise.resolve(json({ images: [], channel: { configured: true, model: 'image-model' } }));
    if (url === '/api/videogen' && request.method === 'GET') return Promise.resolve(options.configError ? json({ detail: '读取服务失败' }, 503) : json(options.config || config));
    return new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let current; let active = true;
  const calls = { settings: 0 };
  function Harness() {
    const studio = useImageStudio(active); const video = useVideoStudio(active);
    current = { studio, video };
    return active ? createElement(Page, { studio, video, onOpenVideoSettings: () => { calls.settings++; }, onOpenSettings() {}, onOpenOutputs() {}, onOpenModels() {} }) : null;
  }
  const render = async () => act(async () => root.render(createElement(Harness)));
  await render();
  t.after(async () => { await act(async () => root.unmount()); container.remove(); sessionStorage.clear(); });
  return {
    container, requests, calls, state: () => current,
    stored: key => JSON.parse(sessionStorage.getItem(key)),
    starts: () => requests.filter(item => item.url === '/api/videogen' && item.method === 'POST'),
    polls: () => requests.filter(item => /^\/api\/videogen\/[^/]+$/.test(item.url) && item.method === 'GET'),
    button: label => [...container.querySelectorAll('button')].find(item => item.textContent.replace(/[←→↗]/g, '').trim() === label),
    run: async action => act(async () => { action(current); }),
    click: async element => { assert.ok(element); await act(async () => element.click()); },
    reply: async (request, response) => { assert.ok(request); await act(async () => request.resolve(response)); },
    active: async value => { active = value; await render(); },
  };
}

test('image and video drafts stay separate while a video completes off-page and restores its real result links', async t => {
  const f = await fixture(t);
  assert.equal(f.container.querySelector('#image-prompt').value, imageDraft.prompt);
  await f.click(f.button('视频'));
  assert.equal(f.container.querySelector('#video-prompt').value, videoDraft.prompt);
  await f.click(f.button('生成视频'));
  assert.deepEqual(JSON.parse(f.starts()[0].init.body), { prompt: '镜头缓慢推进', mode: 'text2video', provider: 'text', ratio: '16:9', duration: null, referenceId: null });
  assert.equal(f.state().video.submitting, true);
  await f.click(f.button('图片'));
  assert.equal(f.container.querySelector('#image-prompt').value, imageDraft.prompt);
  assert.deepEqual(f.stored('easel_imagegen_draft'), imageDraft);
  await f.reply(f.starts()[0], json({ jobId: 'video-one', state: 'running' }));
  assert.equal(f.state().video.job.state, 'running');
  await f.active(false);
  let outputEvents = 0;
  const onOutput = () => { outputEvents++; }; window.addEventListener('easel:outputs-updated', onOutput);
  t.after(() => window.removeEventListener('easel:outputs-updated', onOutput));
  await f.reply(f.polls()[0], json({ ...f.state().video.job, state: 'done', url: '/api/media/video.mp4' }));
  assert.equal(outputEvents, 1);
  assert.equal(f.stored('easel_videogen_job').state, 'done');
  await f.active(true); await f.click(f.button('视频'));
  const player = f.container.querySelector('video[aria-label="生成视频预览"]');
  assert.equal(player.getAttribute('src'), '/api/media/video.mp4');
  assert.equal(player.controls, true);
  assert.equal(f.container.querySelector('a[download]').getAttribute('href'), '/api/media/video.mp4');
  await act(async () => player.dispatchEvent(new window.Event('error')));
  assert.match(f.container.textContent, /浏览器无法播放/);
});

test('using the displayed image selects an image-capable provider without changing image edits; submission failures retain the video draft', async t => {
  const f = await fixture(t);
  await f.click(f.button('用这张图生成视频'));
  assert.equal(f.state().video.viewMode, 'video');
  assert.deepEqual(f.state().video.reference, reference);
  assert.equal(f.state().video.providerId, 'both');
  assert.equal(f.state().video.ratio, '16:9');
  assert.deepEqual([...f.container.querySelector('[aria-label="视频时长"]').options].map(item => item.value), ['', '5', '10']);
  await f.run(({ video }) => { void video.generate(); void video.generate(); video.clearReference(); });
  assert.equal(f.starts().length, 1, 'the synchronous pending guard prevents duplicate submits');
  assert.equal(JSON.parse(f.starts()[0].init.body).referenceId, reference.id);
  assert.equal(JSON.parse(f.starts()[0].init.body).mode, 'image2video');
  await f.reply(f.starts()[0], json({ detail: '模型暂时不可用，请稍后重试' }, 503));
  assert.equal(f.state().video.submitting, false);
  assert.equal(f.state().video.job, null);
  assert.match(f.container.textContent, /模型暂时不可用/);
  assert.deepEqual(f.state().video.reference, reference);
  assert.equal(f.state().video.prompt, videoDraft.prompt);
  assert.deepEqual(f.stored('easel_imagegen_draft'), imageDraft);
  await f.click(f.button('配置视频服务')); assert.equal(f.calls.settings, 1);
  await f.click(f.button('图片')); assert.equal(f.container.querySelector('#image-prompt').value, imageDraft.prompt);
});

test('a failed gallery import preserves the previous video reference and never copies or clears the image draft', async t => {
  const f = await fixture(t);
  await f.run(({ video }) => video.useReference(reference));
  await f.run(({ video }) => { void video.useGalleryReference({ url: '/outputs/new.png', name: 'new.png', mtime: 1 }); });
  assert.equal(f.state().video.referenceBusy, true);
  await f.reply(f.requests.find(item => item.url === 'https://easel.test/outputs/new.png'), new Response('image-bytes', { headers: { 'Content-Type': 'image/png' } }));
  const upload = f.requests.find(item => item.url === '/api/imagegen/references');
  assert.equal(await upload.init.body.get('file').text(), 'image-bytes');
  await f.reply(upload, json({ detail: '参考图保存失败' }, 503));
  assert.equal(f.state().video.referenceBusy, false);
  assert.deepEqual(f.state().video.reference, reference);
  assert.match(f.container.textContent, /参考图保存失败/);
  assert.deepEqual(f.stored('easel_imagegen_draft'), imageDraft);
  const count = f.requests.length;
  await f.run(({ video }) => { void video.useGalleryReference({ url: 'https://foreign.test/a.png', name: 'a.png', mtime: 1 }); });
  assert.equal(f.requests.length, count);
  assert.match(f.state().video.error, /仅支持使用本地图库图片/);
});

test('restored running jobs keep polling across mode switches, expose stop-waiting semantics and ignore stale completion after cancellation', async t => {
  const job = { jobId: 'restored', state: 'running', prompt: '旧任务', provider: 'text', model: 'test-t2v', mode: 'text2video', ratio: '16:9', duration: null, referenceId: null, started: Date.now() / 1000, url: null, error: null };
  const f = await fixture(t, { job });
  assert.equal(f.polls().length, 1);
  await f.click(f.button('视频'));
  assert.match(f.container.textContent, /服务商可能继续计费/);
  await f.click(f.button('停止等待'));
  await f.run(({ video }) => { void video.cancel(); });
  const cancels = f.requests.filter(item => item.url === '/api/videogen/restored/cancel');
  assert.equal(cancels.length, 1);
  await f.reply(cancels[0], json({ ...job, state: 'cancelled', error: config.cancelHint }));
  assert.equal(f.state().video.job.state, 'cancelled');
  await f.reply(f.polls()[0], json({ ...job, state: 'done', url: '/api/media/stale.mp4' }));
  assert.equal(f.state().video.job.state, 'cancelled');
  assert.equal(f.container.querySelector('video[aria-label="生成视频预览"]'), null);
  assert.match(f.container.textContent, /仅停止本地等待/);
});

test('a reference upload finishes in the background without pulling the user out of image mode', async t => {
  const f = await fixture(t);
  await f.click(f.button('视频'));
  await f.run(({ video }) => { void video.uploadReference(new File(['image-bytes'], 'next.png', { type: 'image/png' })); });
  await f.click(f.button('图片'));
  const next = { ...reference, id: 'next', name: 'next.png', url: '/api/imagegen/references/next' };
  await f.reply(f.requests.find(item => item.url === '/api/imagegen/references'), json(next));
  assert.equal(f.state().video.viewMode, 'image');
  assert.deepEqual(f.state().video.reference, next);
  assert.equal(f.container.querySelector('#image-prompt').value, imageDraft.prompt);
  await f.click(f.button('视频'));
  assert.equal(f.container.querySelector('[alt="视频首帧参考"]').getAttribute('src'), next.url);
});

for (const failOldCancel of [false, true]) test(`a late ${failOldCancel ? 'failed' : 'successful'} cancellation cannot overwrite or unlock a newer running task`, async t => {
  const old = { jobId: 'old', state: 'running', prompt: '旧任务', provider: 'text', model: 'test-t2v', mode: 'text2video', ratio: '16:9', duration: null, referenceId: null, started: Date.now() / 1000, url: null, error: null };
  const f = await fixture(t, { job: old });
  await f.run(({ video }) => { void video.cancel(); });
  const oldCancel = f.requests.find(item => item.url === '/api/videogen/old/cancel');
  await f.reply(f.polls()[0], json({ ...old, state: 'done', url: '/api/media/old.mp4' }));
  await f.run(({ video }) => { void video.generate(); });
  await f.reply(f.starts()[0], json({ jobId: 'new', state: 'running' }));
  const current = f.state().video.job;
  assert.equal(current.jobId, 'new');
  assert.equal(f.state().video.cancelling, false, 'an old cancellation does not disable stopping the new job');
  await f.run(({ video }) => { void video.cancel(); void video.cancel(); });
  const newCancels = f.requests.filter(item => item.url === '/api/videogen/new/cancel');
  assert.equal(newCancels.length, 1, 'duplicate prevention is scoped to the target job');
  await f.reply(oldCancel, failOldCancel ? json({ detail: '旧任务取消失败' }, 503) : json({ ...old, state: 'done', url: '/api/media/old.mp4' }));
  assert.equal(f.state().video.job, current);
  assert.equal(f.stored('easel_videogen_job').jobId, 'new');
  assert.equal(f.state().video.cancelling, true, 'old cleanup does not clear the new pending cancellation');
  assert.equal(f.state().video.error, '', 'old cancellation errors do not leak into the new job');
  await f.reply(newCancels[0], json({ ...current, state: 'cancelled', error: config.cancelHint }));
  assert.equal(f.state().video.job.jobId, 'new');
  assert.equal(f.state().video.job.state, 'cancelled');
  assert.equal(f.state().video.cancelling, false);
});

test('cancellation failure for the current task remains visible and can be retried', async t => {
  const job = { jobId: 'current', state: 'running', prompt: '当前任务', provider: 'text', model: 'test-t2v', mode: 'text2video', ratio: '16:9', duration: null, referenceId: null, started: Date.now() / 1000, url: null, error: null };
  const f = await fixture(t, { job });
  await f.run(({ video }) => { void video.cancel(); });
  await f.reply(f.requests.find(item => item.url === '/api/videogen/current/cancel'), json({ detail: '连接断开，请重试' }, 503));
  assert.match(f.state().video.error, /连接断开/);
  assert.equal(f.state().video.job.state, 'running');
  assert.equal(f.state().video.cancelling, false);
  await f.run(({ video }) => { void video.cancel(); });
  assert.equal(f.requests.filter(item => item.url === '/api/videogen/current/cancel').length, 2);
});

test('service errors and unsupported modes block submits and leave a reachable configuration path', async t => {
  const f = await fixture(t, { configError: true });
  await f.click(f.button('视频'));
  assert.match(f.container.textContent, /视频服务读取失败：读取服务失败/);
  assert.equal(f.button('生成视频').disabled, true);
  await f.run(({ video }) => { void video.generate(); });
  assert.equal(f.starts().length, 0);
  assert.ok(f.button('重试读取视频服务'));
  await f.click(f.button('配置视频服务')); assert.equal(f.calls.settings, 1);
});

test('unsupported image mode is not submitted and removing its reference restores text generation', async t => {
  const f = await fixture(t);
  await f.run(({ video }) => video.useReference(reference));
  await f.run(({ video }) => video.selectProvider('text'));
  assert.equal(f.button('生成视频').disabled, true);
  assert.match(f.container.textContent, /当前模型仅支持文生视频/);
  await f.run(({ video }) => { void video.generate(); }); assert.equal(f.starts().length, 0);
  await f.click(f.button('移除参考图'));
  assert.equal(f.button('生成视频').disabled, false);
  await f.click(f.button('生成视频'));
  assert.equal(JSON.parse(f.starts()[0].init.body).referenceId, null);
});

test.after(async () => { await window.happyDOM.abort(); window.close(); });
