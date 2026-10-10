import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Actual React page and child panel, with a controller substitute. These tests
// exercise events and rendering, not CSS layout, network calls or image output.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Page } = await loadTsModule('../src/components/ImageStudioPage.tsx', import.meta.url);

const reference = { id: 'ref-one', url: '/api/imagegen/references/ref-one', name: '猫咪.png', width: 1200, height: 800 };
const resultJob = (patch = {}) => ({ jobId: 'job-one', state: 'done', mode: 'img2img', referenceId: reference.id,
  prompt: '保留小猫，换成阳光咖啡馆背景', size: '1536x1024', url: '/api/media/result.png',
  error: null, started: 1, width: 1536, height: 1024, ...patch });

async function fixture(t, patch = {}) {
  const calls = { uploads: [], sizes: [], modes: [], prompts: [], reused: [], savedModels: [], generated: 0, cleared: 0, settings: 0, models: 0, outputs: 0 };
  const studio = {
    mode: 'generate', reference: null, mask: null, referenceBusy: false,
    imgPrompt: '', imgSize: '1024x1024', imgJob: null, imgSubmitting: false,
    imgErr: '', imgTick: 9, gallery: [], imgChannel: { configured: true, model: 'test-image-model' },
    loading: false, galleryError: '', refreshGallery: async () => {},
    reverse: { providers: [], provider: '', busy: false, file: null, preview: '', result: null,
      mode: 'auto', language: 'zh', instruction: '', prompt: '', error: '', configError: '', configLoading: false,
      setProvider() {}, setMode() {}, setLanguage() {}, setInstruction() {}, setPrompt() {}, selectFile() {}, run: async () => {} },
    uploadReference: async (...args) => { calls.uploads.push(args); },
    clearReference: () => { calls.cleared++; studio.reference = null; studio.mask = null; studio.mode = 'generate'; },
    clearMask: () => { studio.mask = null; },
    setMode: mode => { calls.modes.push(mode); studio.mode = mode; },
    setImgSize: size => { calls.sizes.push(size); studio.imgSize = size; },
    setImgPrompt: prompt => { calls.prompts.push(prompt); studio.imgPrompt = prompt; },
    fireImagegen: async () => { calls.generated++; },
    saveModel: async model => { calls.savedModels.push(model); studio.imgChannel = { ...studio.imgChannel, model: model.trim() }; return true; },
    useGalleryReference: async item => { calls.reused.push(item); },
    ...patch,
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const props = { studio, onOpenSettings: () => { calls.settings++; }, onOpenModels: () => { calls.models++; }, onOpenOutputs: () => { calls.outputs++; } };
  const render = async (values = {}) => { Object.assign(studio, values); await act(async () => root.render(createElement(Page, props))); };
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Page tests must not call a backend'); });
  await render();
  const button = label => [...container.querySelectorAll('button')].find(item => item.textContent.replace(/[←→↗]/g, '').trim() === label);
  const dispatch = async (element, event) => { assert.ok(element, 'event target exists'); await act(async () => element.dispatchEvent(event)); await render(); };
  return { container, studio, calls, render, button,
    click: async element => { assert.ok(element, 'button exists'); await act(async () => element.click()); await render(); },
    dispatch,
    async selectFile(file, selector = '[aria-label="上传参考图"]') {
      const input = container.querySelector(selector);
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      await dispatch(input, new window.Event('change', { bubbles: true }));
      assert.equal(input.value, '', 'same file can be selected again');
    },
    async transfer(type, files) {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: { files, types: ['Files'] } });
      await dispatch(container.querySelector('[aria-label="图片创作工作区"]'), event);
      return event;
    },
  };
}

test('provider failure shows an actionable summary, collapsed diagnostics and a working channel settings action', async t => {
  const view = await fixture(t, { imgJob: resultJob({ state: 'error', mode: 'text2img', url: null, error: '渠道无可用账号', errorDetail: 'HTTP 503: no_available_account' }) });
  const error = view.container.querySelector('.image-error');
  assert.match(error.querySelector('p').textContent, /渠道无可用账号/);
  assert.equal(error.querySelector('details').open, false);
  assert.match(error.querySelector('pre').textContent, /no_available_account/);
  await view.click(view.button('修改图片渠道')); assert.equal(view.calls.settings, 1);
});

test('compact ratio control preserves all sizes and optional masks stay available in collapsed options', async t => {
  const view = await fixture(t, { mode: 'img2img', reference });
  const select = view.container.querySelector('select[aria-label="画面比例"]');
  assert.deepEqual([...select.options].map(option => option.value), [
    '1024x1024', '768x1024', '1024x768', '864x1536', '1536x864', '1024x1280', '1280x1024', '1024x1536', '1536x1024', 'auto',
  ]);
  select.value = 'auto';
  await view.dispatch(select, new window.Event('change', { bubbles: true }));
  assert.deepEqual(view.calls.sizes, ['auto']);
  assert.equal(select.value, 'auto');
  const summary = [...view.container.querySelectorAll('summary')].find(item => item.textContent === '更多选项');
  assert.ok(summary);
  assert.equal(summary.parentElement.open, false);
  assert.match(summary.parentElement.textContent, /由模型决定/);
  const mask = new File(['mask'], 'mask.png', { type: 'image/png' });
  summary.parentElement.open = true;
  await view.selectFile(mask, '#image-mask-upload');
  assert.deepEqual(view.calls.uploads, [[mask, true]]);
});

test('upload, drop and clipboard image all reach the reference upload controller', async t => {
  const view = await fixture(t);
  const file = new File(['image'], 'reference.png', { type: 'image/png' });
  await view.selectFile(file);
  assert.equal((await view.transfer('drop', [file])).defaultPrevented, true);
  const nonImage = new File(['text'], 'notes.txt', { type: 'text/plain' });
  assert.equal((await view.transfer('paste', [nonImage, file])).defaultPrevented, true);
  assert.deepEqual(view.calls.uploads, [[file], [file], [file]]);
  await view.transfer('paste', [nonImage]);
  assert.equal(view.calls.uploads.length, 3);
});

test('editing shows the original immediately and contextual suggestions disappear after choosing a description', async t => {
  const view = await fixture(t, { mode: 'img2img', reference });
  assert.equal(view.container.querySelector('[aria-label="图片画布"] img').getAttribute('src'), reference.url);
  assert.equal(view.container.querySelector('[aria-label="图片画布"] img').alt, `原图：${reference.name}`);
  assert.match(view.container.querySelector('#image-prompt').placeholder, /保留.*背景/);
  assert.ok(view.button('换背景'));
  assert.equal(view.button('产品摄影'), undefined);
  await view.click(view.button('换背景'));
  assert.match(view.container.querySelector('#image-prompt').value, /保留主体/);
  assert.equal(view.button('换背景'), undefined, 'suggestions cannot overwrite an existing description');
  await view.click(view.button('移除图片'));
  assert.equal(view.calls.cleared, 1);
  assert.equal(view.container.querySelector('[aria-label="图片画布"] img'), null);
  assert.equal(view.container.querySelector('#image-prompt').value, view.calls.prompts[0], 'removing image preserves the description');
});

test('results belong to their reference and original/result comparison resets for a newer result', async t => {
  const view = await fixture(t, { mode: 'img2img', reference, imgJob: resultJob({ referenceId: 'old-reference' }) });
  const canvasImage = () => view.container.querySelector('[aria-label="图片画布"] img');
  assert.equal(canvasImage().getAttribute('src'), reference.url);
  assert.equal(view.button('继续修改'), undefined);
  assert.equal(view.container.querySelector('[aria-label="原图与结果对比"]'), null);
  await view.render({ imgJob: resultJob() });
  assert.equal(canvasImage().getAttribute('src'), '/api/media/result.png');
  await view.click(view.button('原图'));
  assert.equal(canvasImage().getAttribute('src'), reference.url);
  assert.equal(view.button('原图').getAttribute('aria-pressed'), 'true');
  await view.click(view.button('结果'));
  assert.equal(canvasImage().getAttribute('src'), '/api/media/result.png');
  await view.click(view.button('原图'));
  await view.render({ imgJob: resultJob({ jobId: 'job-two', url: '/api/media/new.png' }) });
  assert.equal(canvasImage().getAttribute('src'), '/api/media/new.png');
});

test('continue-edit and recent-work actions reuse their exact image and keep download/open links usable', async t => {
  const galleryItem = { name: '旧作品.webp', url: '/api/media/old.webp', mtime: 1, width: 800, height: 1200 };
  const view = await fixture(t, { mode: 'img2img', reference, imgJob: resultJob(), gallery: [galleryItem] });
  await view.click(view.button('继续修改'));
  assert.equal(view.calls.reused[0].url, '/api/media/result.png');
  assert.equal(view.calls.reused[0].width, 1536);
  assert.equal(view.calls.reused[0].height, 1024);
  await view.click(view.container.querySelector(`[aria-label="用作参考图：${galleryItem.name}"]`));
  assert.deepEqual(view.calls.reused[1], galleryItem);
  assert.equal(view.container.querySelector('a[download]').getAttribute('href'), '/api/media/result.png');
  assert.equal(view.container.querySelector('a[target="_blank"]').getAttribute('href'), '/api/media/result.png');
  await view.click(view.button('作品'));
  await view.click(view.button('查看全部'));
  assert.equal(view.calls.outputs, 2);
});

test('submit and keyboard shortcut generate only valid, configured descriptions', async t => {
  const view = await fixture(t, { imgPrompt: '一杯咖啡' });
  const textarea = () => view.container.querySelector('#image-prompt');
  await view.click(view.button('生成图片'));
  assert.equal(view.calls.generated, 1);
  await view.dispatch(textarea(), new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  assert.equal(view.calls.generated, 2);
  for (const props of [{ key: 'Enter' }, { key: 'Enter', ctrlKey: true, isComposing: true }]) {
    await view.dispatch(textarea(), new window.KeyboardEvent('keydown', { ...props, bubbles: true, cancelable: true }));
  }
  assert.equal(view.calls.generated, 2);
  for (const patch of [{ imgPrompt: ' ' }, { imgPrompt: '字'.repeat(2001) }, { imgPrompt: '有效描述', imgChannel: { configured: true } },
    { imgChannel: { configured: true, model: 'known-model' }, galleryError: '配置读取失败' }, { imgChannel: { configured: false }, galleryError: '' }]) {
    await view.render(patch);
    assert.equal(view.button('生成图片').disabled, true);
    await view.dispatch(textarea(), new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  }
  assert.equal(view.calls.generated, 2);
  await view.click(view.button('连接生图服务'));
  assert.equal(view.calls.settings, 1);
});

test('busy submission or reference upload locks edits and ignores dropped or pasted replacements', async t => {
  const galleryItem = { name: 'old.png', url: '/api/media/old.png', mtime: 1 };
  const view = await fixture(t, { mode: 'img2img', reference, imgPrompt: '修改背景', imgJob: resultJob(), gallery: [galleryItem], imgSubmitting: true });
  const file = new File(['replacement'], 'replacement.png', { type: 'image/png' });
  for (const patch of [{ imgSubmitting: true }, { imgSubmitting: false, referenceBusy: true }]) {
    await view.render(patch);
    assert.equal(view.container.querySelector('button[type="submit"]').disabled, true);
    assert.equal(view.container.querySelector('[aria-label="上传参考图"]').disabled, true);
    assert.equal(view.container.querySelector('[aria-label="画面比例"]').disabled, true);
    for (const label of ['提取提示词', '移除图片', '继续修改', '原图', '结果']) assert.equal(view.button(label).disabled, true, label);
    assert.equal(view.container.querySelector(`[aria-label="用作参考图：${galleryItem.name}"]`).disabled, true);
    await view.transfer('drop', [file]);
    await view.transfer('paste', [file]);
    await view.click(view.button('继续修改'));
    await view.click(view.button('提取提示词'));
  }
  assert.deepEqual(view.calls.uploads, []);
  assert.deepEqual(view.calls.reused, []);
  assert.deepEqual(view.calls.modes, []);
});

test('prompt extraction preserves the editing draft and opens the image channel for vision settings', async t => {
  const view = await fixture(t, { mode: 'img2img', reference, imgPrompt: '保留已有修改要求' });
  await view.click(view.button('提取提示词'));
  assert.equal(view.studio.mode, 'reverse');
  assert.ok(view.container.querySelector('[aria-label="反推参数"]'));
  await view.click(view.button('配置理解模型'));
  assert.equal(view.calls.settings, 1);
  assert.equal(view.calls.models, 0);
  await view.click(view.button('返回图片创作'));
  assert.deepEqual(view.calls.modes, ['reverse', 'img2img']);
  assert.equal(view.container.querySelector('#image-prompt').value, '保留已有修改要求');
  assert.equal(view.container.querySelector('[aria-label="图片画布"] img').alt, `原图：${reference.name}`);
});

test('current model is visible outside collapsed options and can be edited without leaving the studio', async t => {
  const view = await fixture(t);
  assert.match(view.container.querySelector('.studio-model-current').textContent, /test-image-model/);
  await view.click(view.button('自定义模型'));
  const input = view.container.querySelector('#studio-image-model');
  assert.equal(input.value, 'test-image-model');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'custom/image-v3');
  await view.dispatch(input, new window.Event('input', { bubbles: true }));
  await view.click(view.button('保存模型'));
  assert.deepEqual(view.calls.savedModels, ['custom/image-v3']);
  assert.match(view.container.querySelector('.studio-model-current').textContent, /custom\/image-v3/);
  assert.equal(view.container.querySelector('#studio-image-model'), null);
  assert.equal(view.calls.settings, 0);
  assert.equal(view.calls.generated, 0);
});

test('clipboard button requests media only on click and uploads the actual clipboard image', async t => {
  let reads = 0;
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read: async () => {
    reads++; return [{ types: ['image/png'], getType: async () => new Blob(['clipboard-bytes'], { type: 'image/png' }) }];
  } } });
  t.after(() => { if (previous) Object.defineProperty(navigator, 'clipboard', previous); else delete navigator.clipboard; });
  const view = await fixture(t);
  assert.equal(reads, 0);
  await view.click(view.button('从剪贴板粘贴'));
  assert.equal(reads, 1);
  assert.equal(view.calls.uploads.length, 1);
  assert.equal(view.calls.uploads[0][0].type, 'image/png');
  assert.equal(await view.calls.uploads[0][0].text(), 'clipboard-bytes');
});

test.after(async () => { await window.happyDOM.abort(); window.close(); });
