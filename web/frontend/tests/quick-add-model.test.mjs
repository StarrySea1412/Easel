import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: QuickAdd } = await loadTsModule('../src/components/settings/QuickAddModel.tsx', import.meta.url);

test('draft model enumeration and adding use one channel request, clear credentials and reject duplicate submission', async t => {
  const calls = [], saved = [], container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let finishSave;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url === '/api/models/discover') return new Response(JSON.stringify({ ok: true, models: ['real-fixture-model'], message: 'found' }));
    assert.equal(url, '/api/settings/models/add');
    return new Promise(resolve => { finishSave = () => resolve(new Response(JSON.stringify({ ok: true, channels: { chat: { rows: [] } } }))); });
  });
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(createElement(QuickAdd, { presets: [], disabled: false, onSaved: value => saved.push(value) })));
  async function fill(label, value) {
    const input = container.querySelector(`input[aria-label="${label}"]`);
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  }
  await fill('快速添加渠道名称', '我的测试渠道'); await fill('快速添加服务地址', 'https://fixture.test/v1'); await fill('快速添加 API Key', 'fixture-private-key');
  const discover = [...container.querySelectorAll('button')].find(button => button.textContent === '获取模型列表');
  await act(async () => discover.click());
  assert.equal(container.querySelector('[aria-label="快速添加模型 ID"]').value, 'real-fixture-model');
  assert.equal(calls.length, 1);
  await act(async () => { container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { name: '我的测试渠道', baseUrl: 'https://fixture.test/v1', apiKey: 'fixture-private-key', model: 'real-fixture-model', protocol: 'openai', makeDefault: true });
  assert.equal(container.querySelector('fieldset').disabled, true);
  await act(async () => finishSave());
  assert.equal(saved.length, 1); assert.equal(container.querySelector('[aria-label="快速添加 API Key"]').value, '');
  assert.match(container.textContent, /已添加并设为默认模型/);
});
