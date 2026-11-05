import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { useShareAppends } = await loadTsModule('../src/hooks/useShareAppends.ts', import.meta.url);
const { pendingShareAppends, mergeShareAppends } = await loadTsModule('../src/lib/conversationShare.ts', import.meta.url);
const session = { id: 'chat', messages: [{ role: 'user', content: 'original' }], share: { token: 'share-one' } };
const append = { appendId: 'one', messages: [{ role: 'assistant', content: '3 images' }], source: {}, at: 1 };
function Harness({ session }) { return createElement('span', null, useShareAppends(session)); }
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }

test('pending records ignore loaded, blank and duplicate entries', () => {
  const entries = [append, append, { appendId: 'empty', messages: [{ content: ' ' }] }];
  assert.equal(pendingShareAppends(session, entries).length, 1);
  const result = mergeShareAppends(session, entries);
  assert.equal(result.added, 1);
  assert.equal(pendingShareAppends(result.session, entries).length, 0);
});

test('discovery announces once, focus finds updates, loading clears, and errors retain the notice', async t => {
  let replies = [], fail = false, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++; if (fail) throw new Error('offline');
    return { ok: true, json: async () => ({ appends: replies }) };
  });
  const notices = [];
  const listen = event => notices.push(event.detail.message);
  window.addEventListener('easel:toast', listen);
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  t.after(async () => { await act(async () => root.unmount()); element.remove(); window.removeEventListener('easel:toast', listen); });
  await act(async () => root.render(createElement(Harness, { session })));
  await flush(); assert.equal(element.textContent, '0');
  replies = [append];
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  await flush(); assert.equal(element.textContent, '1'); assert.equal(notices.length, 1);
  fail = true;
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  await flush(); assert.equal(element.textContent, '1'); assert.equal(notices.length, 1);
  await act(async () => root.render(createElement(Harness, { session: { ...session, loadedShareAppends: ['one'] } })));
  assert.equal(element.textContent, '0');
  fail = false;
  replies = [append, { ...append, appendId: 'two' }];
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  await flush(); assert.equal(element.textContent, '1'); assert.equal(notices.length, 2);
  assert.ok(calls >= 4);
});

test('switching chats aborts the old request and excludes its late response', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise(resolve => requests.push({ url, options, resolve })));
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  t.after(async () => { await act(async () => root.unmount()); element.remove(); });
  await act(async () => root.render(createElement(Harness, { session })));
  await act(async () => root.render(createElement(Harness, { session: { ...session, id: 'other', share: { token: 'share-two' } } })));
  assert.equal(requests[0].options.signal.aborted, true);
  await act(async () => requests[0].resolve({ ok: true, json: async () => ({ appends: [append] }) }));
  await flush(); assert.equal(element.textContent, '0');
  await act(async () => requests[1].resolve({ ok: true, json: async () => ({ appends: [] }) }));
  await flush(); assert.equal(element.textContent, '0');
});

test('30 page remounts keep pending visible without repeating the toast; focus bursts never overlap requests', async t => {
  let pendingResolve, inFlight = 0, maximum = 0;
  t.mock.method(globalThis, 'fetch', () => {
    inFlight++; maximum = Math.max(maximum, inFlight);
    return new Promise(resolve => { pendingResolve = () => { inFlight--; resolve({ ok: true, json: async () => ({ appends: [append] }) }); }; });
  });
  const current = { ...session, share: { token: 'stress-remount' } };
  const notices = [];
  const listen = event => notices.push(event.detail.message);
  window.addEventListener('easel:toast', listen);
  t.after(() => window.removeEventListener('easel:toast', listen));
  for (let round = 0; round < 30; round++) {
    const element = document.createElement('div'); document.body.append(element);
    const root = createRoot(element);
    await act(async () => root.render(createElement(Harness, { session: current })));
    await act(async () => { for (let i = 0; i < 30; i++) window.dispatchEvent(new window.Event('focus')); });
    assert.equal(inFlight, 1);
    await act(async () => pendingResolve()); await flush();
    assert.equal(element.textContent, '1');
    await act(async () => root.unmount()); element.remove();
  }
  assert.equal(maximum, 1); assert.equal(notices.length, 1);
});
