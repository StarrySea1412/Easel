import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement, StrictMode } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Simulated DOM and manually dispatched media events verify UI/resource
// lifecycle only. These tests do not establish real decoding or playback.
globalThis.window = new Window({ url: 'https://easel.test/workbench/index.html' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Preview, OFFICE_MEDIA_PREVIEW_TIMEOUT_MS: TIMEOUT } = await loadTsModule('../src/components/agent-office/OfficeOutputPreview.tsx', import.meta.url);

function item(kind = 'image', patch = {}) {
  const name = kind === 'image' ? 'picture.png' : kind === 'audio' ? 'sound.wav' : 'clip.mp4';
  return { id: name, name, path: `project/${name}`, kind, size: 64, modifiedAt: '2026-10-01T00:00:00Z', href: `/api/media/project/${name}`, ...patch };
}

function fixture(t) {
  const events = [], timers = new Map(); let timerId = 0;
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Media must use native resource loading, not fetch'); });
  t.mock.method(window, 'setTimeout', (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; });
  t.mock.method(window, 'clearTimeout', id => timers.delete(id));
  for (const action of ['pause', 'load', 'play']) t.mock.method(window.HTMLMediaElement.prototype, action, function () {
    events.push({ action, node: this, src: this.getAttribute('src') });
    return action === 'play' ? Promise.resolve() : undefined;
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); let mounted = true;
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } };
  t.after(async () => { await unmount(); assert.equal(fetch.mock.callCount(), 0); container.remove(); });
  return { container, events, timers, unmount,
    render: async (file = item(), strict = false) => act(async () => root.render(strict ? createElement(StrictMode, null, createElement(Preview, { item: file })) : createElement(Preview, { item: file }))),
    dispatch: async (node, type) => act(async () => node.dispatchEvent(new window.Event(type))),
    retry: async () => act(async () => container.querySelector('.office-media-retry').click()),
    media: () => container.querySelector('img, audio, video'),
    status: () => container.querySelector('[role="status"]')?.textContent,
  };
}

test('image loading settles only after load, retains original/download links and cancels its deadline', async t => {
  const view = fixture(t); await view.render();
  const image = view.media(), url = new URL(image.src);
  assert.match(view.status(), /正在加载图片/);
  assert.equal(image.alt, item().name);
  assert.equal(url.pathname, '/workbench/api/media/project/picture.png');
  assert.equal(url.searchParams.get('v'), item().modifiedAt);
  assert.equal(url.searchParams.get('size'), String(item().size));
  assert.equal([...view.timers.values()][0].delay, TIMEOUT);
  for (const link of view.container.querySelectorAll('a')) assert.equal(link.getAttribute('href'), '/workbench/api/media/project/picture.png');
  assert.equal(view.container.querySelector('a[download]').getAttribute('download'), item().name);
  await view.dispatch(image, 'load');
  assert.equal(view.status(), '图片已加载。');
  assert.equal(view.timers.size, 0);
  await view.unmount();
  assert.equal(image.getAttribute('src'), null);
});

test('failed images retry using a fresh element and URL; detached events cannot affect the new attempt', async t => {
  const view = fixture(t); await view.render();
  const old = view.media(), oldSrc = old.src;
  await view.dispatch(old, 'error');
  assert.match(view.container.querySelector('[role="alert"]').textContent, /文件无法预览/);
  assert.equal(old.getAttribute('src'), null);
  assert.equal(view.media(), null);
  assert.equal(view.timers.size, 0);
  await view.retry();
  const next = view.media();
  assert.notEqual(next, old); assert.notEqual(next.src, oldSrc);
  assert.equal(document.activeElement, view.container.querySelector('.office-media-preview'));
  assert.match(view.status(), /正在加载图片/);
  await view.dispatch(old, 'load'); await view.dispatch(old, 'error');
  assert.match(view.status(), /正在加载图片/);
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  await view.dispatch(next, 'load');
  assert.equal(view.status(), '图片已加载。');
});

test('image timeout releases its request and supports a new attempt without a stale timeout or load', async t => {
  const view = fixture(t); await view.render();
  const old = view.media(), deadline = [...view.timers.values()][0].callback;
  await act(async () => deadline());
  assert.match(view.container.textContent, /图片加载超时/);
  assert.equal(old.getAttribute('src'), null);
  await view.retry();
  const next = view.media();
  await act(async () => deadline());
  await view.dispatch(old, 'load');
  assert.match(view.status(), /正在加载图片/);
  await view.dispatch(next, 'load');
  assert.equal(view.status(), '图片已加载。');
});

for (const kind of ['audio', 'video']) test(`${kind} metadata is readiness, never playback success, and failures release and retry`, async t => {
  const view = fixture(t); await view.render(item(kind));
  const old = view.media(), oldSrc = old.src;
  assert.equal(old.tagName.toLowerCase(), kind);
  assert.equal(old.preload, 'metadata'); assert.equal(old.controls, true);
  assert.equal(old.autoplay, false); assert.equal(old.hasAttribute('autoplay'), false);
  assert.match(view.status(), /正在读取.*元数据/);
  assert.equal(view.events.length, 0);
  await view.dispatch(old, 'loadedmetadata');
  assert.match(view.status(), /元数据已就绪，请使用播放控件/);
  assert.doesNotMatch(view.container.textContent, /播放成功|已播放/);
  assert.equal(view.timers.size, 0);
  assert.equal(view.events.length, 0);
  await view.dispatch(old, 'error');
  assert.deepEqual(view.events.map(event => event.action), ['pause', 'load']);
  assert.equal(view.events[0].src, oldSrc.replace('https://easel.test', ''));
  assert.equal(view.events[1].src, null);
  await view.retry();
  const next = view.media(); assert.notEqual(next, old); assert.notEqual(next.src, oldSrc);
  await view.dispatch(old, 'loadedmetadata'); await view.dispatch(old, 'error');
  assert.match(view.status(), /正在读取.*元数据/);
  await view.dispatch(next, 'loadedmetadata');
  await view.unmount();
  assert.equal(next.getAttribute('src'), null);
  assert.deepEqual(view.events.map(event => event.action), ['pause', 'load', 'pause', 'load']);
  assert.equal(view.events.filter(event => event.action === 'play').length, 0);
});

test('metadata changes replace media, unchanged rerenders preserve it, and closing releases exactly once', async t => {
  const view = fixture(t); const first = item('video'); await view.render(first);
  const old = view.media(); await view.dispatch(old, 'loadedmetadata');
  await view.render({ ...first });
  assert.equal(view.media(), old); assert.equal(view.events.length, 0);
  await view.render({ ...first, size: 100 });
  const resized = view.media(); assert.notEqual(resized, old);
  assert.equal(old.getAttribute('src'), null);
  assert.equal(new URL(resized.src).searchParams.get('size'), '100');
  assert.match(view.status(), /正在读取视频元数据/);
  await view.dispatch(old, 'error');
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  await view.render(item('audio'));
  const audio = view.media();
  assert.equal(resized.getAttribute('src'), null);
  assert.equal(audio.tagName, 'AUDIO');
  await view.unmount();
  assert.equal(audio.getAttribute('src'), null);
  for (const node of [old, resized, audio]) assert.deepEqual(view.events.filter(event => event.node === node).map(event => event.action), ['pause', 'load']);
  assert.equal(view.timers.size, 0);
});

test('metadata timeout is retryable, and StrictMode cleanup restores the active resource', async t => {
  const view = fixture(t); await view.render(item('audio'), true);
  const audio = view.media(); assert.ok(audio.getAttribute('src'));
  assert.equal(view.timers.size, 1);
  await act(async () => [...view.timers.values()][0].callback());
  assert.match(view.container.textContent, /音频元数据加载超时/);
  assert.equal(audio.getAttribute('src'), null);
  await view.retry();
  assert.ok(view.media().getAttribute('src'));
  await view.dispatch(view.media(), 'loadedmetadata');
  assert.match(view.status(), /元数据已就绪/);
});

test('unsafe paths remain blocked and unsupported media extensions stay download-only', async t => {
  const view = fixture(t);
  await view.render(item('image', { href: 'https://other.test/picture.png' }));
  assert.match(view.container.textContent, /文件路径无法确认/);
  assert.equal(view.media(), null); assert.equal(view.container.querySelectorAll('a').length, 0);
  await view.render(item('image', { name: 'vector.svg', path: 'project/vector.svg', href: '/api/media/project/vector.svg' }));
  assert.match(view.container.textContent, /不在面板中嵌入预览/);
  assert.equal(view.media(), null); assert.ok(view.container.querySelector('a[download="vector.svg"]'));
  assert.equal(view.container.querySelector('a[target="_blank"]'), null);
  assert.equal(view.timers.size, 0);
});

test.after(() => window.close());
