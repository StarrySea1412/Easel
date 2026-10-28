import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
const { createRoot } = await import('react-dom/client');
const { ProviderBoard } = await loadTsModule('../src/components/settings/ProviderBoard.tsx', import.meta.url);

async function fixture(t, slot = 'direct-api') {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container), calls = [];
  let row = { slot, providerId: slot, name: slot, channelName: 'API 直连', order: 1,
    type: 'openai', protocol: 'openai', protocolEditable: false, model: 'saved-model',
    baseUrl: 'http://127.0.0.1:17938/v1', keyMasked: '—', role: '主', result: '已配置',
    enabled: true, deletable: false, chatModels: ['saved-model'] };
  const render = () => root.render(createElement(ProviderBoard, { rows: [row], modelLoading: false,
    resultText: () => ({ text: '已配置', cls: 'good' }), ops: { channel: 'chat',
      onRow: (_i, patch) => { row = { ...row, ...patch }; render(); },
      onSaveRow: () => calls.push({ kind: 'save', model: row.model, baseUrl: row.baseUrl }),
      onDiscover: () => calls.push({ kind: 'discover' }),
      onMove: () => calls.push({ kind: 'move' }), onRemove: () => calls.push({ kind: 'remove' }),
    } }));
  await act(async () => render());
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const button = text => [...container.querySelectorAll('button')].find(node => node.textContent === text);
  const click = async node => { assert.ok(node); await act(async () => node.click()); };
  await click(container.querySelector('[aria-label="展开API 直连配置"]'));
  return { container, calls, button, click, async input(label, value) {
    const node = container.querySelector(`[aria-label="${label}"]`); assert.ok(node);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value);
      node.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  } };
}

test('API users can edit and save the actual model/address without a mandatory key', async t => {
  const view = await fixture(t);
  assert.equal(view.container.querySelector('[aria-label="模型名称"]').value, 'saved-model');
  assert.equal(view.container.querySelector('[aria-label="Base URL"]').value, 'http://127.0.0.1:17938/v1');
  assert.ok(view.container.querySelector('[aria-label="API Key"]'));
  assert.equal(view.button('获取模型列表').disabled, false);
  await view.click(view.button('获取模型列表'));
  await view.input('模型名称', 'another-model');
  await view.input('Base URL', 'https://models.example/v1');
  await view.click(view.button('保存配置'));
  assert.deepEqual(view.calls, [{ kind: 'discover' }, { kind: 'save', model: 'another-model', baseUrl: 'https://models.example/v1' }]);
  assert.equal(view.container.querySelector('[aria-label="上下文窗口（Token）"]'), null);
  assert.equal(view.container.querySelector('[aria-label="支持思考"]'), null);
  assert.equal(view.container.querySelector('.provider-drag-handle'), null);
  assert.equal(view.container.querySelector('[aria-label="供应商更多操作：API 直连"]'), null);
  assert.doesNotMatch(view.container.textContent, /此能力使用内建配置/);
});

test('other cloud providers retain the key requirement for model discovery', async t => {
  const view = await fixture(t, 'openai');
  assert.equal(view.button('获取模型列表').disabled, true);
  assert.ok(view.container.querySelector('[aria-label="上下文窗口（Token）"]'));
});

test('OpenClaw reasoning controls appear only when enabled and use the shared selector', async t => {
  const view = await fixture(t, 'openai');
  const toggle = view.container.querySelector('[aria-label="支持思考"]');
  assert.equal(toggle.indeterminate, true);
  assert.equal(view.container.querySelector('[aria-label="思考格式"]'), null);
  await view.click(toggle);
  assert.equal(view.container.querySelector('[aria-label="支持思考"]').checked, true);
  const format = view.container.querySelector('[aria-label="思考格式"]');
  assert.ok(format);
  assert.equal(format.getAttribute('role'), 'combobox');
  await view.click(format);
  await view.click([...document.querySelectorAll('[role="option"]')].find(node => node.textContent === 'deepseek'));
  assert.match(view.container.querySelector('[aria-label="思考格式"]').textContent, /deepseek/);
  await view.click(view.container.querySelector('[aria-label="支持思考"]'));
  assert.equal(view.container.querySelector('[aria-label="支持思考"]').checked, false);
  assert.equal(view.container.querySelector('[aria-label="思考格式"]'), null);
});
