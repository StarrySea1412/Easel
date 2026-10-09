import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Panel } = await loadTsModule('../src/components/ChatExecutionPanel.tsx', import.meta.url);
const payload = (session = 'a', operations = [], warnings = []) => ({ sessionId: session, turnId: 't1', operations, warnings });
async function setup(t) {
  const requests = []; let opened = 0;
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })));
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const render = async (sessionId = 'a') => act(async () => root.render(createElement(Panel, { sessionId, turnId: 't1', streaming: false, onOpen: () => opened++ })));
  await render();
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return { requests, container, render, opened: () => opened,
    respond: async (index, data) => act(async () => requests[index].resolve(new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }))),
    click: async text => act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === text).click()) };
}
test('empty execution results retain backend warnings and can retry or open the matching record', async t => {
  const view = await setup(t);
  await view.respond(0, payload('a', [], ['执行记录正在更新，请稍后查看。']));
  assert.match(view.container.textContent, /执行记录正在更新/);
  await view.click('运行记录 ↗'); assert.equal(view.opened(), 1);
  await view.click('重新读取'); assert.equal(view.requests.length, 2);
  await view.respond(1, payload()); assert.equal(view.container.textContent, '');
});
test('switching sessions hides old errors immediately and aborts pending old requests', async t => {
  const view = await setup(t);
  await act(async () => view.requests[0].reject(new Error('offline')));
  assert.match(view.container.textContent, /执行记录暂不可读/);
  await view.render('b'); assert.equal(view.container.textContent, '');
  assert.equal(view.requests[0].options.signal.aborted, true);
  await view.respond(1, payload('b')); assert.equal(view.container.textContent, '');
});
test('a failed refresh preserves real file diff receipts and offers recovery', async t => {
  const view = await setup(t);
  const row = { id: 'write1', name: 'write', status: 'returned', command: '', path: 'proof.txt', output: '', diff: '+1 alpha\n+2 beta', added: 2, removed: 0, elapsedSeconds: .4 };
  await view.respond(0, payload('a', [row], ['记录尚未完整。']));
  assert.match(view.container.textContent, /1 个文件有修改回执/);
  assert.match(view.container.textContent, /\+2 −0/);
  await view.click('重新读取');
  await act(async () => view.requests[1].reject(new Error('offline')));
  assert.match(view.container.textContent, /\+1 alpha/);
  assert.match(view.container.textContent, /已有回执保留/);
});
test('an old session response cannot become current execution evidence', async t => {
  const view = await setup(t); await view.render('b');
  await view.respond(0, payload('a', [], ['OLD PRIVATE WARNING']));
  assert.equal(view.container.textContent, '');
  await view.respond(1, payload('b', [], ['CURRENT WARNING']));
  assert.match(view.container.textContent, /CURRENT WARNING/);
  assert.doesNotMatch(view.container.textContent, /OLD PRIVATE WARNING/);
});
