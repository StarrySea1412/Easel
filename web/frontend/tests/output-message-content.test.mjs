import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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

test('expanded Markdown disclosures survive message rerenders', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ exists: true }) }));
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const props = { content: '<details>\n<summary>补充：西甲声明要点</summary>\n\n补充正文应能展开。\n\n</details>' };
  await act(async () => root.render(createElement(OutputMessageContent, props)));
  const summary = container.querySelector('summary');
  assert.ok(summary, 'the sanitized assistant message keeps its disclosure summary');
  await act(async () => summary.click());
  assert.equal(container.querySelector('details').open, true, 'mouse click expands the disclosure');

  await act(async () => root.render(createElement(OutputMessageContent, props)));
  assert.equal(container.querySelector('details').open, true, 'a routine parent rerender does not replace the expanded HTML');

  await act(async () => root.render(createElement(OutputMessageContent, { ...props, content: props.content.replace('补充正文应能展开。', '正文更新后仍保持展开。') })));
  assert.equal(container.querySelector('details').open, true, 'a body update with the same summary keeps the matching disclosure open');

  await act(async () => root.render(createElement(OutputMessageContent, {
    ...props,
    streaming: true,
    content: props.content.replace('补充：西甲声明要点', '补充：西甲声明要点与背景').replace('补充正文应能展开。', '流式正文继续到达。'),
  })));
  assert.equal(container.querySelector('details').open, true, 'streaming text changes keep the disclosure at the same position open');
});

test('link verification preserves independent duplicate and nested disclosures and keyboard focus', async t => {
  let finish;
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ exists: true }) }); }));
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const content = '<details><summary>补充</summary><p>第一组</p><details><summary>来源</summary><p>嵌套正文</p></details></details>\n\n<details open><summary>补充</summary><p>第二组</p></details>\n\n[交付](outputs/主题/good.md)';
  await act(async () => root.render(createElement(OutputMessageContent, { content })));
  const summaries = [...container.querySelectorAll('summary')];
  await act(async () => { summaries[0].click(); summaries[1].click(); summaries[2].click(); });
  summaries[1].focus();
  assert.deepEqual([...container.querySelectorAll('details')].map(item => item.open), [true, true, false]);
  await act(async () => { finish(); });
  assert.deepEqual([...container.querySelectorAll('details')].map(item => item.open), [true, true, false], 'async file verification preserves both open and user-closed choices');
  assert.equal(document.activeElement, container.querySelectorAll('summary')[1], 'the focused disclosure can continue receiving native keyboard input');
  assert.ok(container.querySelector('a[href]'), 'the link actually changed after verification');
});

test('static and inert transcripts include sanitized disclosure bodies before effects run', () => {
  const content = '<details><summary>补充</summary><p>原始完整正文</p><script>alert(1)</script><img src="https://invalid.test/track"></details>';
  const html = renderToStaticMarkup(createElement(OutputMessageContent, { content, inert: true }));
  assert.match(html, /原始完整正文/);
  assert.match(html, /<details>/);
  assert.doesNotMatch(html, /<script|<img/);
});
