import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'https://easel.test/workbench/index.html' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Editor } = await loadTsModule('../src/components/UsagePriceEditor.tsx', import.meta.url);
const price = { currency: 'USD', input: '3', output: '15', cacheRead: '.3', cacheWrite: '3.75', multiplier: '1.5', source: 'fixture quote' };

async function setup(t, failSave = false) {
  const requests = []; let saves = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(options.method === 'PUT' && failSave
      ? { detail: '价格保存失败，请重试' } : { prices: { 'fixture/model': price } }),
    { status: options.method === 'PUT' && failSave ? 400 : 200, headers: { 'Content-Type': 'application/json' } });
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Editor, { provider: 'fixture', model: 'model', onSaved: () => saves++ })));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  assert.equal(requests.length, 0, 'no price read until expanded');
  await act(async () => {
    const details = container.querySelector('details'); details.open = true;
    details.dispatchEvent(new window.Event('toggle'));
  });
  await act(async () => {});
  return { container, requests, saves: () => saves };
}

test('price editor reads and saves within the mounted path, including all price buckets', async t => {
  const view = await setup(t);
  assert.equal(view.requests[0].url, '/workbench/api/usage/pricing');
  assert.equal(view.container.querySelector('input').value, '3');
  await act(async () => view.container.querySelector('button').click());
  assert.equal(view.requests[1].url, '/workbench/api/usage/pricing');
  assert.equal(view.requests[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(view.requests[1].options.body), { provider: 'fixture', model: 'model', pricing: price });
  assert.equal(view.saves(), 1);
  assert.match(view.container.textContent, /价格已保存/);
});

test('rejected price save keeps values and exposes the server error without a successful refresh', async t => {
  const view = await setup(t, true);
  await act(async () => view.container.querySelector('button').click());
  assert.equal(view.saves(), 0);
  assert.match(view.container.querySelector('[role="status"]').textContent, /价格保存失败，请重试/);
  assert.equal(view.container.querySelector('input').value, '3');
  assert.equal(view.container.querySelector('button').disabled, false);
});
