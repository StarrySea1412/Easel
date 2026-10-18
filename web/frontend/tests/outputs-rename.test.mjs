import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// 内容库卡片重命名走 jsdom（jsdom 下 React 受控输入的值追踪与真实输入一致）。
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:7880/' }).window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: OutputsPage } = await loadTsModule('../src/components/OutputsPage.tsx', import.meta.url);

test('library card rename commits on Enter, cancels on Escape and refreshes the tree', async t => {
  const calls = [];
  let tree = [{ name: 'project', type: 'dir', path: 'project', children: [{ name: 'notes.md', type: 'file', kind: 'text', path: 'project/notes.md' }] }];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([String(url), init?.method || 'GET', init?.body ?? null]);
    if (String(url).endsWith('/api/outputs')) return { ok: true, json: async () => tree };
    return { ok: true, json: async () => ({ ok: true, renamed: 'project/会议记录.md', old: 'project/notes.md' }) };
  });
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  t.after(async () => { await act(async () => root.unmount()); node.remove(); });
  const type = (input, value) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  await act(async () => root.render(createElement(OutputsPage)));
  assert.deepEqual([...node.querySelectorAll('.gcard-name')].map(el => el.textContent.trim()), ['project']);
  await act(async () => [...node.querySelectorAll('.gcard-name')].find(el => el.textContent.includes('project')).click());
  await act(async () => node.querySelector('.gcard-rename').click());
  const escaped = node.querySelector('.gcard-rename-input');
  assert.equal(escaped.value, 'notes.md');
  await act(async () => escaped.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(node.querySelector('.gcard-rename-input'), null);
  assert.equal(calls.filter(call => call[1] === 'POST').length, 0);
  await act(async () => node.querySelector('.gcard-rename').click());
  const input = node.querySelector('.gcard-rename-input');
  await act(async () => type(input, '会议记录'));
  tree = [{ name: 'project', type: 'dir', path: 'project', children: [{ name: '会议记录.md', type: 'file', kind: 'text', path: 'project/会议记录.md' }] }];
  await act(async () => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 0)); });
  const post = calls.find(call => call[1] === 'POST');
  assert.ok(post, 'rename POST expected');
  assert.equal(post[0], '/api/output/project/notes.md/rename');
  assert.deepEqual(JSON.parse(post[2]), { name: '会议记录' });
  assert.equal(calls.filter(call => call[0].endsWith('/api/outputs')).length, 2);
  assert.deepEqual([...node.querySelectorAll('.gcard-name')].map(el => el.textContent.trim()), ['会议记录.md']);
});

test('unchanged name closes the editor without calling the backend', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([String(url), init?.method || 'GET']);
    return { ok: true, json: async () => [{ name: 'notes.md', type: 'file', kind: 'text', path: 'notes.md' }] };
  });
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  t.after(async () => { await act(async () => root.unmount()); node.remove(); });
  await act(async () => root.render(createElement(OutputsPage)));
  await act(async () => node.querySelector('.gcard-rename').click());
  const input = node.querySelector('.gcard-rename-input');
  await act(async () => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.equal(node.querySelector('.gcard-rename-input'), null);
  assert.equal(calls.filter(call => call[1] === 'POST').length, 0);
  assert.equal(calls.filter(call => call[0].endsWith('/api/outputs')).length, 1);
});
