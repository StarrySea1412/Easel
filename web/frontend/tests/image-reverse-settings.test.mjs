import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window = new JSDOM('<html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
const { createRoot } = await import('react-dom/client');
const { default: Panel } = await loadTsModule('../src/components/settings/ImageReverseSettings.tsx', import.meta.url);
const REF = 'vision/model-a';
async function fixture(t, props = {}) {
  const calls = [], state = { passed: false, fail: false };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url, ...init });
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.endsWith('/probe')) state.passed = true;
    const value = url.endsWith('/image-reverse/config') ? body || { modelRef: REF, providers: [{ id: 'vision', model: 'model-a', name: 'Vision', configured: true }] }
      : { results: state.passed ? [{ modelRef: REF, mode: 'vision', state: 'success', testedAt: 1720000000, detail: '四格全部匹配' }] : [], schedules: [] };
    return new Response(JSON.stringify(state.fail && body ? { detail: '测试限流' } : value), { status: state.fail && body ? 429 : 200, headers: { 'Content-Type': 'application/json' } });
  });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(createElement(Panel, { revision: 'saved', editor: createElement('p', null, '供应商编辑器'), ...props })));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const button = text => [...container.querySelectorAll('button')].find(element => element.textContent === text);
  const click = async element => { assert.ok(element); await act(async () => element.click()); };
  return { container, calls, state, button, click };
}
test('opening image settings never calls a model and explicit vision test uses the selected exact model', async t => {
  const view = await fixture(t); assert.ok(view.calls.every(call => !call.body)); assert.match(view.container.textContent, /未测活/);
  await view.click(view.button('视觉测试'));
  assert.deepEqual(JSON.parse(view.calls.find(call => call.url.endsWith('/probe')).body), { modelRef: REF, mode: 'vision', prompt: '' });
  assert.match(view.container.textContent, /通过/); assert.match(view.container.textContent, /四格全部匹配/);
});
test('configuration drafts disable visual tests and failed requests do not show success', async t => {
  const draft = await fixture(t, { dirty: true }); assert.equal(draft.button('视觉测试').disabled, true);
  await draft.click(draft.button('视觉测试')); assert.ok(draft.calls.every(call => !call.body));
  const view = await fixture(t); view.state.fail = true; await view.click(view.button('视觉测试'));
  assert.match(view.container.querySelector('[role=alert]').textContent, /测试限流/); assert.match(view.container.textContent, /未测活/);
});
test('saving the metadata-only selection persists an empty exact model ref', async t => {
  const view = await fixture(t); await view.click(view.container.querySelector('[role=combobox]'));
  await view.click(document.querySelector('[role=option][data-value=""]'));
  await view.click(view.button('保存反推模型'));
  assert.deepEqual(JSON.parse(view.calls.find(call => call.url.endsWith('/image-reverse/config') && call.body).body), { modelRef: '' });
  assert.match(view.container.textContent, /已保存/);
});
