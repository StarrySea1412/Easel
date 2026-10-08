import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Mount the actual hook and API client. HTTP replies and DOM/storage are
// controlled substitutes: these tests do not call an image provider.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.sessionStorage = window.sessionStorage;
globalThis.Event = window.Event;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { useImageStudio } = await loadTsModule('../src/hooks/useImageStudio.ts', import.meta.url);

const draftKey = 'easel_imagegen_draft';
const reference = (id, width = 1024, height = 1024) => ({
  id, url: `/api/imagegen/references/${id}`, name: `${id}.png`, width, height,
});
const original = reference('original');
const mask = reference('mask');
const draft = () => ({ prompt: '保留原有构图，修改背景', size: '1024x1024', mode: 'img2img', reference: original, mask });
const file = (name = 'source.png', type = 'image/png') => new File(['controlled-image'], name, { type });
const galleryItem = { name: 'past.png', url: '/outputs/past.png', mtime: 1 };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(t, initial = {}) {
  sessionStorage.clear();
  sessionStorage.setItem(draftKey, JSON.stringify(initial));
  const requests = [];
  let serverModel = 'test-model';
  let galleryFailure = '';
  t.mock.method(globalThis, 'fetch', (url, options = {}) => {
    const request = { url: String(url), options, method: options.method || 'GET' };
    requests.push(request);
    if (url === '/api/image-reverse/config') return Promise.resolve(json({ providers: [] }));
    if (url === '/api/imagegen' && request.method === 'GET') return Promise.resolve(galleryFailure ? json({ detail: galleryFailure }, 503) : json({
      images: [], channel: { configured: true, baseUrl: '', keyMasked: '', model: serverModel },
    }));
    return new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let current;
  function Harness() { current = useImageStudio(true); return null; }
  await act(async () => root.render(createElement(Harness)));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); sessionStorage.clear(); });
  return {
    requests, state: () => current,
    serverModel: model => { serverModel = model; },
    serverError: message => { galleryFailure = message; },
    stored: () => JSON.parse(sessionStorage.getItem(draftKey)),
    uploads: () => requests.filter(r => r.url === '/api/imagegen/references'),
    starts: () => requests.filter(r => r.url === '/api/imagegen' && r.method === 'POST'),
    // Do not await a deferred network operation inside act: its reply is
    // delivered separately so assertions can inspect the pending state.
    run: async action => act(async () => { action(current); }),
    reply: async (request, response) => act(async () => { request.resolve(response); }),
    reject: async (request, error) => act(async () => { request.reject(error); }),
  };
}

test('uploading a reference selects its closest supported ratio and sends a real img2img payload', async t => {
  const f = await fixture(t, { prompt: '  把背景改成黄昏  ', size: '1024x1024', mode: 'generate' });
  await f.run(s => s.uploadReference(file()));
  assert.equal(f.state().referenceBusy, true);
  const upload = f.uploads()[0];
  assert.ok(upload.options.body instanceof FormData);
  assert.equal(upload.options.body.get('file').name, 'source.png');
  const wide = reference('wide', 1800, 1000);
  await f.reply(upload, json(wide));
  assert.equal(f.state().referenceBusy, false);
  assert.equal(f.state().mode, 'img2img');
  assert.equal(f.state().imgSize, '1536x864');
  assert.deepEqual(f.state().reference, wide);
  assert.equal(f.state().mask, null);
  assert.equal(f.stored().mode, 'img2img');

  await f.run(s => s.fireImagegen());
  assert.deepEqual(JSON.parse(f.starts()[0].options.body), {
    prompt: '把背景改成黄昏', size: '1536x864', n: 1, mode: 'img2img', referenceId: 'wide', model: 'test-model',
  });
});

test('clearing the reference clears its mask and the next generation sends no image IDs', async t => {
  const f = await fixture(t, draft());
  assert.deepEqual(f.state().mask, mask);
  await f.run(s => s.clearReference());
  assert.equal(f.state().reference, null);
  assert.equal(f.state().mask, null);
  assert.equal(f.state().mode, 'generate');
  assert.deepEqual(f.stored(), { ...draft(), mode: 'generate', reference: null, mask: null });
  await f.run(s => s.fireImagegen());
  assert.deepEqual(JSON.parse(f.starts()[0].options.body), {
    prompt: draft().prompt, size: '1024x1024', n: 1, mode: 'text2img', model: 'test-model',
  });
});

test('an unsuccessful replacement upload preserves the existing prompt, size, mode, reference and mask', async t => {
  const initial = { ...draft(), size: '768x1024' };
  const f = await fixture(t, initial);
  await f.run(s => s.uploadReference(file('replacement.png')));
  await f.reply(f.uploads()[0], json({ detail: '图片上传暂时失败' }, 503));
  assert.equal(f.state().referenceBusy, false);
  assert.match(f.state().imgErr, /图片上传暂时失败/);
  assert.deepEqual(f.stored(), initial);
  assert.deepEqual(f.state().reference, original);
  assert.deepEqual(f.state().mask, mask);

  await f.run(s => s.uploadReference(file('unsupported.svg', 'image/svg+xml')));
  assert.equal(f.uploads().length, 1, 'invalid files never reach the upload API');
  assert.match(f.state().imgErr, /PNG、JPEG 或 WebP/);
  assert.deepEqual(f.stored(), initial);
});

test('using a gallery result uploads the actual image, clears the previous mask and retains the editing prompt', async t => {
  const f = await fixture(t, draft());
  await f.run(s => s.useGalleryReference(galleryItem));
  const imageRead = f.requests.find(r => r.url === 'https://easel.test/outputs/past.png');
  assert.ok(imageRead);
  assert.equal(f.state().referenceBusy, true);
  assert.deepEqual(f.state().reference, original, 'the old reference remains until replacement upload succeeds');
  await f.reply(imageRead, new Response('past-image-bytes', { headers: { 'Content-Type': 'image/png' } }));
  const uploadedFile = f.uploads()[0].options.body.get('file');
  assert.equal(uploadedFile.name, 'past.png');
  assert.equal(uploadedFile.type, 'image/png');
  assert.equal(await uploadedFile.text(), 'past-image-bytes');
  const portrait = reference('past', 750, 1000);
  await f.reply(f.uploads()[0], json(portrait));
  assert.deepEqual(f.state().reference, portrait);
  assert.equal(f.state().mode, 'img2img');
  assert.equal(f.state().imgSize, '768x1024');
  assert.equal(f.state().mask, null);
  assert.equal(f.state().imgPrompt, draft().prompt);
  assert.equal(f.state().referenceBusy, false);
  assert.equal(f.state().imgErr, '');
});

test('missing, foreign and failed gallery images leave the current draft intact', async t => {
  const initial = draft();
  const f = await fixture(t, initial);
  await f.run(s => s.useGalleryReference(galleryItem));
  await f.reply(f.requests.find(r => r.url === 'https://easel.test/outputs/past.png'), new Response('', { status: 404 }));
  assert.match(f.state().imgErr, /历史图片读取失败/);
  assert.equal(f.state().referenceBusy, false);
  assert.equal(f.uploads().length, 0);
  assert.deepEqual(f.stored(), initial);

  const before = f.requests.length;
  await f.run(s => s.useGalleryReference({ ...galleryItem, url: 'https://foreign.test/image.png' }));
  assert.equal(f.requests.length, before, 'foreign gallery URLs are rejected before fetching');
  assert.match(f.state().imgErr, /仅支持使用本地图库图片/);
  assert.deepEqual(f.stored(), initial);

  await f.run(s => s.useGalleryReference({ ...galleryItem, url: '/outputs/second.png' }));
  await f.reply(f.requests.find(r => r.url === 'https://easel.test/outputs/second.png'), new Response('second-image', { headers: { 'Content-Type': 'image/png' } }));
  await f.reject(f.uploads()[0], new Error('参考图保存失败'));
  assert.match(f.state().imgErr, /参考图保存失败/);
  assert.equal(f.state().referenceBusy, false);
  assert.deepEqual(f.stored(), initial);
});

test('upload, submission and running-job locks prevent duplicate requests and reference changes', async t => {
  const f = await fixture(t, draft());
  await f.run(s => {
    void s.uploadReference(file('first.png'));
    void s.uploadReference(file('duplicate.png'));
    void s.useGalleryReference(galleryItem);
    void s.fireImagegen();
    s.clearReference(); s.clearMask();
  });
  assert.equal(f.uploads().length, 1);
  assert.equal(f.starts().length, 0);
  assert.equal(f.requests.some(r => r.url.includes('/outputs/')), false);
  assert.deepEqual(f.state().reference, original);
  assert.deepEqual(f.state().mask, mask);
  const next = reference('next');
  await f.reply(f.uploads()[0], json(next));

  await f.run(s => {
    void s.fireImagegen(); void s.fireImagegen();
    void s.uploadReference(file('while-submitting.png'));
    void s.useGalleryReference(galleryItem);
    s.clearReference();
  });
  assert.equal(f.state().imgSubmitting, true);
  assert.equal(f.starts().length, 1);
  assert.equal(f.uploads().length, 1);
  assert.deepEqual(f.state().reference, next);
  await f.reply(f.starts()[0], json({ jobId: 'controlled-job' }));
  assert.equal(f.state().imgJob.state, 'running');
  assert.equal(f.state().imgSubmitting, false);

  await f.run(s => {
    void s.fireImagegen(); void s.uploadReference(file('while-running.png'));
    void s.useGalleryReference(galleryItem); s.clearReference();
  });
  assert.equal(f.starts().length, 1);
  assert.equal(f.uploads().length, 1);
  assert.equal(f.requests.some(r => r.url.includes('/outputs/')), false);
  assert.deepEqual(f.state().reference, next);

  const poll = f.requests.find(r => r.url === '/api/imagegen/controlled-job');
  await f.reply(poll, json({ ...f.state().imgJob, state: 'done', url: '/outputs/done.png' }));
  assert.equal(f.state().imgJob.state, 'done');
  await f.run(s => s.clearReference());
  assert.equal(f.state().reference, null, 'editing becomes available after generation completes');
  await f.run(s => s.uploadReference(file('after-done.png')));
  assert.equal(f.uploads().length, 2, 'a completed job does not leave the upload lock stuck');
});

test('saving a custom model persists only IMG_MODEL and freezes generation until the saved channel is refreshed', async t => {
  const f = await fixture(t, { prompt: '自定义模型测试' });
  await f.run(s => { void s.saveModel('  custom/image-v2  '); void s.saveModel('duplicate'); void s.fireImagegen(); });
  assert.equal(f.state().modelSaving, true);
  const writes = f.requests.filter(r => r.url === '/api/env');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].options.body), { updates: { IMG_MODEL: 'custom/image-v2' } });
  assert.equal(f.starts().length, 0);
  f.serverModel('custom/image-v2');
  await f.reply(writes[0], json({ ok: true }));
  assert.equal(f.state().modelSaving, false);
  assert.equal(f.state().imgChannel.model, 'custom/image-v2');
  await f.run(s => s.fireImagegen());
  assert.equal(JSON.parse(f.starts()[0].options.body).model, 'custom/image-v2');
});

test('invalid or failed custom model updates preserve the usable saved model', async t => {
  const f = await fixture(t, { prompt: '保留原模型' });
  for (const model of ['', 'bad\nIMG_API_KEY=bad', 'a'.repeat(201)]) await f.run(s => s.saveModel(model));
  assert.equal(f.requests.filter(r => r.url === '/api/env').length, 0);
  assert.match(f.state().modelError, /有效模型名称/);
  await f.run(s => s.saveModel('unavailable-model'));
  await f.reply(f.requests.find(r => r.url === '/api/env'), json({ detail: '磁盘不可写' }, 503));
  assert.equal(f.state().imgChannel.model, 'test-model');
  assert.equal(f.state().modelSaving, false);
  assert.match(f.state().modelError, /磁盘不可写/);
});

test('a saved model remains visible but cannot generate until a failed configuration refresh recovers', async t => {
  const f = await fixture(t, { prompt: '确认模型后再生成' });
  await f.run(s => s.saveModel('saved-model'));
  f.serverError('无法重新读取配置');
  await f.reply(f.requests.find(r => r.url === '/api/env'), json({ ok: true }));
  assert.equal(f.state().imgChannel.model, 'saved-model');
  assert.equal(f.state().modelSaving, false);
  assert.match(f.state().galleryError, /无法重新读取配置/);
  await f.run(s => s.fireImagegen());
  assert.equal(f.starts().length, 0);
  f.serverError(''); f.serverModel('saved-model');
  await f.run(s => s.refreshGallery());
  assert.equal(f.state().galleryError, '');
  await f.run(s => s.fireImagegen());
  assert.equal(JSON.parse(f.starts()[0].options.body).model, 'saved-model');
});

test('a legacy or malformed response with no model cannot authorize a generation using stale settings', async t => {
  const f = await fixture(t, { prompt: '需要已知模型' });
  f.serverModel(undefined);
  await f.run(s => s.refreshGallery());
  assert.match(f.state().galleryError, /未读取到生图模型/);
  await f.run(s => s.fireImagegen());
  assert.equal(f.starts().length, 0);
});

test.after(() => window.close());
