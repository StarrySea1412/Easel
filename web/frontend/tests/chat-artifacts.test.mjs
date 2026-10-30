import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Artifacts } = await loadTsModule('../src/components/ChatArtifacts.tsx', import.meta.url);
const artifact = (patch = {}) => ({ id: 'a'.repeat(32), sessionId: 'chat', turnId: 'turn', name: '页面.html', path: 'topic/page.html',
  mimeType: 'text/html', version: 'first', revision: 1, size: 500, status: 'ready', ...patch });

test('manual studio receipts and old misregistered files never become assistant turns', async () => {
  const { decodeImageJobs, decodeArtifacts } = await loadTsModule('../src/lib/chatArtifacts.ts', import.meta.url);
  const assistant = {jobId:'b'.repeat(32), sessionId:'chat', turnId:'assistant-turn', prompt:'image', phase:'done'};
  const manual = {...assistant, jobId:'c'.repeat(32), turnId:'studio-'+'d'.repeat(40)};
  assert.deepEqual(decodeImageJobs([assistant,manual], 'chat'), [assistant]);
  const ordinary = artifact();
  assert.deepEqual(decodeArtifacts([ordinary,artifact({id:'d'.repeat(32),turnId:manual.turnId})], 'chat'), [ordinary]);
});

async function setup(t, initial) {
  let items = initial; const requests = [];
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })));
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const render = async (next = items) => { items = next; await act(async () => root.render(createElement(Artifacts, { artifacts: items, onUpdated: value => { items = items.map(item => item.id === value.id ? value : item); void render(); } }))); };
  await render(); t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return { container, requests, render,
    refresh: async () => act(async () => container.querySelector('button').click()),
    respond: async value => act(async () => requests.at(-1).resolve(new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }))) };
}

test('HTML is visible without assistant prose, remains sandboxed and refreshes its browsing context', async t => {
  const view = await setup(t, [artifact()]);
  const frame = view.container.querySelector('iframe'); assert.ok(frame);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  await view.refresh();
  assert.match(view.requests[0].url, /\/refresh\?/); assert.equal(view.requests[0].options.method, 'POST');
  await view.respond(artifact({ version: 'next', revision: 2 }));
  const refreshed = view.container.querySelector('iframe');
  assert.notEqual(refreshed, frame); assert.match(refreshed.src, /v=next/);
  assert.match(view.container.querySelector('footer a').href, /download=true/);
  assert.ok(view.requests.every(request => !/imagegen|chat\/stream/.test(request.url)));
});

test('video artifacts render an inline player and keep the refresh path', async t => {
  const video = artifact({ name: 'result.mp4', mimeType: 'video/mp4', size: 1024 });
  const view = await setup(t, [video]);
  const player = view.container.querySelector('video');
  assert.ok(player);
  assert.equal(player.controls, true);
  assert.match(player.getAttribute('aria-label'), /播放/);
  assert.match(view.container.querySelector('footer a').textContent, /视频/);
  await view.refresh();
  assert.match(view.requests[0].url, /\/refresh\?/);
});

test('same-version image retry replaces failed image and deletion removes live preview', async t => {
  const image = artifact({ name: 'image.png', mimeType: 'image/png' });
  const view = await setup(t, [image]);
  await act(async () => view.container.querySelector('img').dispatchEvent(new window.Event('error')));
  assert.match(view.container.textContent, /预览加载失败/);
  await view.refresh(); await view.respond(image);
  assert.ok(view.container.querySelector('img')); assert.match(view.container.querySelector('img').src, /attempt=1/);
  await view.refresh(); await view.respond({ ...image, status: 'missing', revision: 2 });
  assert.equal(view.container.querySelector('img'), null); assert.match(view.container.textContent, /已移动或删除/);
});

test('switching artifacts aborts refresh and late old result cannot update current chat', async t => {
  const view = await setup(t, [artifact()]); await view.refresh();
  await view.render([artifact({ id: 'b'.repeat(32), sessionId: 'other', name: '其他.html' })]);
  assert.equal(view.requests[0].options.signal.aborted, true);
  await view.respond(artifact({ name: '过期内容', version: 'stale', revision: 9 }));
  assert.match(view.container.textContent, /其他.html/); assert.doesNotMatch(view.container.textContent, /过期内容/);
});

test('snapshot polling preserves a newer manual refresh and isolates late results after switching sessions', async t => {
  const { useChatArtifacts } = await loadTsModule('../src/hooks/useChatArtifacts.ts', import.meta.url);
  const requests = [];
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise(resolve => requests.push({ url, options, resolve })));
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  let current;
  function Harness({ session }) { current = useChatArtifacts(session, true, false); return null; }
  const render = session => act(async () => root.render(createElement(Harness, { session })));
  const respond = (request, session, items) => act(async () => request.resolve(new Response(JSON.stringify({sessionId:session,artifacts:items}))));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await render('chat'); await respond(requests[0], 'chat', [artifact()]);
  await act(async () => current.updated(artifact({ revision:3, version:'manual' })));
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  await respond(requests[1], 'chat', [artifact({ revision:2, version:'stale' })]);
  assert.equal(current.items[0].version, 'manual');
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  const old = requests[2]; await render('other');
  assert.equal(old.options.signal.aborted, true); assert.deepEqual(current.items, []);
  await respond(old, 'chat', [artifact({ revision:8 })]);
  assert.deepEqual(current.items, []);
  await respond(requests[3], 'other', [artifact({sessionId:'other',version:'other-file'})]);
  assert.equal(current.items[0].version, 'other-file');
});
