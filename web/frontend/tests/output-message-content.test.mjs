import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' }).window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: OutputMessageContent } = await loadTsModule('../src/components/OutputMessageContent.tsx', import.meta.url);

test('local delivery links require existing files; remote sources stay links and missing files can be rechecked', async t => {
  const checked = [];
  let exists = false;
  t.mock.method(globalThis, 'fetch', async url => {
    checked.push(url);
    return { ok: true, json: async () => ({ exists: exists || url.includes('good.md') }) };
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const props = { content: '[有效](outputs/主题/good.md)\n\n[缺失](C:/Easel/outputs/主题/missing.docx)\n\n[来源](https://example.test/page)' };
  await act(async () => root.render(createElement(OutputMessageContent, { ...props, streaming: true })));
  assert.equal(checked.length, 0);
  assert.equal(container.querySelectorAll('a[href]').length, 1, 'local links wait for final response verification');
  await act(async () => root.render(createElement(OutputMessageContent, props)));
  const anchor = label => [...container.querySelectorAll('a')].find(item => item.textContent === label);
  assert.ok(anchor('有效').getAttribute('href').startsWith('#/outputs/'));
  assert.equal(anchor('缺失').getAttribute('href'), null);
  assert.equal(anchor('来源').getAttribute('href'), 'https://example.test/page');
  assert.ok(container.textContent.includes('当前数据目录未找到文件'));
  assert.equal(checked.length, 2);
  exists = true;
  await act(async () => container.querySelector('button').click());
  assert.ok(anchor('缺失').getAttribute('href'));
  assert.equal(container.querySelector('[role="status"]'), null);
  await act(async () => root.render(createElement(OutputMessageContent, { ...props, streaming: true })));
  assert.equal(anchor('有效').getAttribute('href'), null, 'a new stream must not reuse the last completed verification');
});

test('unavailable sandbox links and backups never initiate filesystem or external fetches', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => { requests.push(url); throw new Error('unexpected'); });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(createElement(OutputMessageContent, { content: '[文件](sandbox:/mnt/data/result.docx)' })));
  assert.equal(container.querySelector('a[href]'), null);
  assert.ok(container.textContent.includes('本地路径未保存'));
  await act(async () => root.render(createElement(OutputMessageContent, { content: '[备份](outputs/主题/file.docx)', inert: true })));
  assert.equal(requests.length, 0);
});
