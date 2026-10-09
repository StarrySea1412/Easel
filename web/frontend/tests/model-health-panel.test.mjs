import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
const { createRoot } = await import('react-dom/client');
const { default: Panel } = await loadTsModule('../src/components/settings/ModelHealthPanel.tsx', import.meta.url);
const REF = 'relay/model-a';
async function fixture(t, props = {}) {
  const calls = [], h = { enabled: false, fail: false, failHealthRead: false };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, ...init }); const body = init?.body ? JSON.parse(init.body) : undefined;
    if (body?.schedules) h.enabled = body.schedules[0].enabled;
    const data = String(url).includes('/agent-office/models') ? { available: true, scope: 'next_turn', options: [{ id: REF, provider: 'relay', model: 'model-a', label: '模型A', configured: true }] }
      : h.fail && body ? { detail: '服务拒绝测试' } : { results: [{ modelRef: REF, mode: 'text', state: 'unverified' }], schedules: h.enabled ? [{ modelRef: REF, enabled: true, intervalSeconds: 900, prompt: '自己的提示词' }] : [], limit: { requests: 2, windowSeconds: 60, automaticModelsPerProvider: 2 }, staleAfterSeconds: 900 };
    if (h.failHealthRead && String(url).endsWith('/models/health')) return { ok: false, status: 503, json: async () => ({ detail: '状态暂不可读' }) };
    return { ok: !(h.fail && body), status: h.fail && body ? 400 : 200, json: async () => data };
  });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(createElement(Panel, props))); t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const button = text => [...container.querySelectorAll('button')].find(element => element.textContent === text);
  const click = async element => { assert.ok(element); await act(async () => element.click()); };
  return { calls, h, container, button, click, async choose() { const trigger = container.querySelector('[role=combobox]'); await click(trigger); await click(document.querySelector(`[role=option][data-value="${REF}"]`)); },
    async prompt(text) { const input = container.querySelector('textarea'); await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, text); input.dispatchEvent(new window.Event('input', { bubbles: true })); }); },
  };
}
test('opening the panel reads status and leaves automatic tests disabled without model POST', async t => {
  const view = await fixture(t); assert.ok(view.calls.every(call => !call.body)); assert.equal(view.container.querySelector('input[type=checkbox]').checked, false);
  assert.equal(view.button('测试文本').disabled, true); assert.match(view.container.textContent, /四格测试图/);
});
test('explicit text and image test clicks send exact model/mode/prompt and re-read state', async t => {
  const view = await fixture(t); await view.choose(); await view.prompt('自己的提示词'); await view.click(view.button('测试文本')); await view.click(view.button('测试图片识别'));
  assert.deepEqual(view.calls.filter(call => call.url.endsWith('/probe')).map(call => JSON.parse(call.body)), [{ modelRef: REF, mode: 'text', prompt: '自己的提示词' }, { modelRef: REF, mode: 'vision', prompt: '自己的提示词' }]);
  assert.match(view.container.textContent, /结果以最新状态为准/); assert.equal(view.container.querySelector('input[type=checkbox]').checked, false);
});
test('automatic tests require explicit checkbox and save; failure does not claim a saved plan', async t => {
  const view = await fixture(t); await view.choose(); await view.prompt('自己的提示词'); await view.click(view.container.querySelector('input[type=checkbox]'));
  assert.equal(view.calls.some(call => call.body), false); await view.click(view.button('保存自动测活'));
  assert.deepEqual(JSON.parse(view.calls.find(call => call.url.endsWith('/health/schedules')).body), { schedules: [{ modelRef: REF, enabled: true, intervalSeconds: 900, prompt: '自己的提示词' }] });
  view.h.fail = true; await view.click(view.button('测试文本')); assert.match(view.container.querySelector('[role=alert]').textContent, /服务拒绝测试/);
});

test('a failed state refresh cannot overwrite schedules using an older snapshot', async t => {
  const view = await fixture(t); await view.choose(); view.h.failHealthRead = true; await view.click(view.button('刷新状态'));
  assert.match(view.container.querySelector('[role=alert]').textContent, /状态暂不可读/);
  assert.equal(view.button('保存自动测活').disabled, true); await view.click(view.button('保存自动测活'));
  assert.ok(view.calls.every(call => !call.body));
});

test('a provider card probes its fixed model without another model picker', async t => {
  const view = await fixture(t, { targetModelRef: REF });
  assert.equal(view.container.querySelector('[aria-label="测活模型"]'), null);
  assert.match(view.container.textContent, /relay\/model-a/);
  await view.click(view.button('测试文本'));
  assert.deepEqual(JSON.parse(view.calls.find(call => call.url.endsWith('/probe')).body), { modelRef: REF, mode: 'text', prompt: '请只回复：连接成功' });
});

test('an unsaved provider draft cannot probe or overwrite the saved schedule', async t => {
  const view = await fixture(t, { targetModelRef: REF, dirty: true });
  assert.equal(view.container.querySelector('fieldset').disabled, true);
  await view.click(view.button('测试文本'));
  await view.click(view.button('保存自动测活'));
  assert.ok(view.calls.every(call => !call.body));
});
