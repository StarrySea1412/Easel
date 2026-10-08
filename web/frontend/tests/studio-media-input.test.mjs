import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Actual clipboard adapters and media hook; clipboard contents and video decode
// are controlled browser substitutes, never a claim of native clipboard support.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { readStudioClipboard, firstStudioMedia, extractVideoFirstFrame } = await loadTsModule('../src/lib/studioClipboard.ts', import.meta.url);
const { useStudioMediaInput } = await loadTsModule('../src/hooks/useStudioMediaInput.ts', import.meta.url);

test('clipboard reads preserve binary media and prefer a media representation over text', async () => {
  for (const type of ['image/png', 'video/mp4']) {
    const clipboard = { read: async () => [{ types: ['text/plain', type], getType: async selected => {
      assert.equal(selected, type); return new Blob(['controlled-bytes'], { type });
    } }] };
    const file = await readStudioClipboard(clipboard);
    assert.equal(file.type, type);
    assert.equal(await file.text(), 'controlled-bytes');
    assert.match(file.name, type === 'video/mp4' ? /\.mp4$/ : /\.png$/);
  }
  const video = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
  assert.equal(firstStudioMedia([new File(['url'], 'link.txt', { type: 'text/plain' }), video]), video);
});

test('missing permissions, missing formats and pasted URLs give honest recovery actions', async () => {
  await assert.rejects(readStudioClipboard({}), /Ctrl.*V/);
  await assert.rejects(readStudioClipboard({ read: async () => { throw new Error('NotAllowedError'); } }), /允许浏览器访问/);
  await assert.rejects(readStudioClipboard({ read: async () => [{ types: ['text/plain'], getType: async () => new Blob(['https://video.test/file.mp4']) }] }), /复制视频链接不会传入视频/);
});

function decodeFixture(t, { error = false, width = 3840, height = 2160, deferred = false } = {}) {
  const urls = [], revoked = [], draws = [], videos = [], canvases = [];
  t.mock.method(URL, 'createObjectURL', () => { const url = `blob:controlled-${urls.length}`; urls.push(url); return url; });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const original = document.createElement.bind(document);
  t.mock.method(document, 'createElement', (tag, ...args) => {
    if (tag === 'canvas') {
      const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (...values) => draws.push(values) }),
        toBlob: callback => callback(new Blob(['frame-bytes'], { type: 'image/jpeg' })) };
      canvases.push(canvas); return canvas;
    }
    if (tag === 'video') {
      const video = { src: '', videoWidth: width, videoHeight: height,
        load() { if (this.src && !deferred) queueMicrotask(() => error ? this.onerror?.() : this.onloadeddata?.()); },
        removeAttribute() { this.src = ''; } };
      videos.push(video); return video;
    }
    return original(tag, ...args);
  });
  return { urls, revoked, draws, videos, canvases };
}

test('video decoding produces an actual JPEG first frame, bounds dimensions and releases its object URL', async t => {
  const f = decodeFixture(t);
  const frame = await extractVideoFirstFrame(new File(['clip'], '参考.mp4', { type: 'video/mp4' }));
  assert.equal(frame.name, '参考-首帧.jpg');
  assert.equal(frame.type, 'image/jpeg');
  assert.equal(await frame.text(), 'frame-bytes');
  assert.equal(f.canvases[0].width, 2048);
  assert.equal(f.canvases[0].height, 1152);
  assert.equal(f.draws.length, 1);
  assert.deepEqual(f.revoked, f.urls);
  assert.equal(f.videos[0].src, '');
});

for (const [name, options, message] of [
  ['unsupported codec', { error: true }, /无法解码/],
  ['audio-only file', { width: 0, height: 0 }, /没有可读取的画面/],
]) test(`${name} does not create a reference and releases its object URL`, async t => {
  const f = decodeFixture(t, options);
  await assert.rejects(extractVideoFirstFrame(new File(['clip'], 'clip.mp4', { type: 'video/mp4' })), message);
  assert.equal(f.draws.length, 0);
  assert.deepEqual(f.revoked, f.urls);
});

test('oversized videos fail before allocating media resources', async t => {
  const f = decodeFixture(t);
  await assert.rejects(extractVideoFirstFrame({ type: 'video/mp4', size: 100 * 1024 * 1024 + 1 }), /100 MB/);
  assert.equal(f.urls.length, 0);
});

test('video source is previewed locally while only its JPEG frame reaches the upload controller', async t => {
  const f = decodeFixture(t);
  const uploads = [];
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let state, referenceId = null;
  function Harness() { state = useStudioMediaInput(async file => { uploads.push(file); referenceId = 'frame-reference'; return { id: referenceId }; }, false, referenceId); return null; }
  await act(async () => root.render(createElement(Harness)));
  const video = new File(['clip'], 'reference.mp4', { type: 'video/mp4' });
  await act(async () => { await state.receiveFile(video); });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].type, 'image/jpeg');
  assert.equal(uploads[0].name, 'reference-首帧.jpg');
  assert.equal(state.sourceVideo.name, 'reference.mp4');
  assert.equal(state.processing, false);
  assert.equal(f.urls.length, 2, 'separate decode and local playback URLs');
  await act(async () => root.unmount()); container.remove();
  assert.deepEqual(f.revoked, f.urls);
});

test('rejected uploads keep the previous video preview paired with its saved reference', async t => {
  const f = decodeFixture(t);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let state, accepted = true, referenceId = null;
  function Harness() { state = useStudioMediaInput(async file => { if (!accepted) return null; referenceId = file.name; return { id: referenceId }; }, false, referenceId); return null; }
  await act(async () => root.render(createElement(Harness)));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => state.receiveFile(new File(['old'], 'old.mp4', { type: 'video/mp4' })));
  const original = state.sourceVideo;
  accepted = false;
  await act(async () => state.receiveFile(new File(['new'], 'new.mp4', { type: 'video/mp4' })));
  assert.deepEqual(state.sourceVideo, original);
  assert.equal(f.revoked.includes(original.url), false);
  await act(async () => state.receiveFile(new File(['image'], 'replacement.png', { type: 'image/png' })));
  assert.deepEqual(state.sourceVideo, original);
  assert.equal(state.processing, false);
  accepted = true;
  await act(async () => state.receiveFile(new File(['image'], 'replacement.png', { type: 'image/png' })));
  assert.equal(state.sourceVideo, null);
  assert.ok(f.revoked.includes(original.url));
});

for (const nextReference of ['gallery-reference', null]) test(`an external reference change to ${nextReference} clears the old video source`, async t => {
  const f = decodeFixture(t);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let state, referenceId = null;
  function Harness() {
    state = useStudioMediaInput(async () => { referenceId = 'video-frame'; return { id: referenceId }; }, false, referenceId);
    return null;
  }
  await act(async () => root.render(createElement(Harness)));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => state.receiveFile(new File(['video'], 'source.mp4', { type: 'video/mp4' })));
  const original = state.sourceVideo;
  assert.equal(original.referenceId, 'video-frame');
  referenceId = nextReference;
  await act(async () => root.render(createElement(Harness)));
  assert.equal(state.sourceVideo, null);
  assert.ok(f.revoked.includes(original.url));
});

test('leaving during video decode cancels local work and never uploads a stale frame', async t => {
  const f = decodeFixture(t, { deferred: true });
  const uploads = [];
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let state;
  function Harness() { state = useStudioMediaInput(async file => { uploads.push(file); return null; }, false, null); return null; }
  await act(async () => root.render(createElement(Harness)));
  let pending;
  await act(async () => { pending = state.receiveFile(new File(['clip'], 'clip.mp4', { type: 'video/mp4' })); });
  assert.equal(state.processing, true);
  await act(async () => root.unmount()); container.remove(); await pending;
  assert.deepEqual(uploads, []);
  assert.deepEqual(f.revoked, f.urls);
});

test('a clipboard response arriving after the page unmounts never decodes or uploads media', async t => {
  const f = decodeFixture(t);
  const uploads = [];
  let finishRead;
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read: () => new Promise(resolve => { finishRead = resolve; }) } });
  t.after(() => { if (previous) Object.defineProperty(navigator, 'clipboard', previous); else delete navigator.clipboard; });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let state;
  function Harness() { state = useStudioMediaInput(async file => { uploads.push(file); return null; }, false, null); return null; }
  await act(async () => root.render(createElement(Harness)));
  let pending;
  await act(async () => { pending = state.pasteClipboard(); });
  assert.equal(state.processing, true);
  await act(async () => root.unmount()); container.remove();
  finishRead([{ types: ['video/mp4'], getType: async () => new Blob(['video'], { type: 'video/mp4' }) }]);
  await pending;
  assert.deepEqual(uploads, []);
  assert.deepEqual(f.urls, []);
});

test.after(() => window.close());
