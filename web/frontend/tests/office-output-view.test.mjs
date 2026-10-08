import { selectOption } from './select-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Simulated DOM and metadata only; browser/file playback is checked separately.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { selectOfficeOutputs } = await loadTsModule('../src/components/agent-office/officeOutputView.ts', import.meta.url);
const { default: Monitor } = await loadTsModule('../src/components/agent-office/OfficeOutputMonitor.tsx', import.meta.url);

function file(name, patch = {}) {
  return { id: name, name, path: `Project/${name}`, href: `/api/media/Project/${encodeURIComponent(name)}`, kind: 'text', size: 10, modifiedAt: '2026-10-01T00:00:00Z', ...patch };
}
const select = (items, patch = {}) => selectOfficeOutputs(items, { query: '', kind: 'all', sort: 'recent', ...patch });

test('output search combines visible filename/path terms with type and ignores hidden payloads', () => {
  const one = file('Draft-2.txt', { rawOutput: 'PRIVATE_OUTPUT' }), two = file('Draft-10.png', { kind: 'image' });
  assert.deepEqual(select([one, two], { query: ' PROJECT  draft ', kind: 'text' }), [one]);
  assert.deepEqual(select([one, two], { query: 'PRIVATE_OUTPUT' }), []);
  assert.deepEqual(select([one, two], { query: '<script>' }), []);
  assert.equal(select([one, two], { query: '  ' }).length, 2);
});

test('recent/name/size sorts are deterministic and do not mutate the source snapshot', () => {
  const small = file('Draft-2.txt', { size: 5 }), large = file('Draft-10.txt', { size: 100 }), recent = file('Draft-1.txt', { size: 25, modifiedAt: '2026-10-01T01:00:00Z' });
  const items = Object.freeze([Object.freeze(large), Object.freeze(small), Object.freeze(recent)]);
  assert.deepEqual(select(items).map(item => item.name), ['Draft-1.txt', 'Draft-2.txt', 'Draft-10.txt']);
  assert.deepEqual(select(items, { sort: 'name' }).map(item => item.name), ['Draft-1.txt', 'Draft-2.txt', 'Draft-10.txt']);
  assert.deepEqual(select(items, { sort: 'size' }).map(item => item.size), [100, 25, 5]);
  assert.deepEqual(items.map(item => item.name), ['Draft-10.txt', 'Draft-2.txt', 'Draft-1.txt']);
  const same = file('Draft-2.txt', { path: 'Another/Draft-2.txt' });
  assert.deepEqual(select([small, same], { sort: 'name' }).map(item => item.path), ['Another/Draft-2.txt', 'Project/Draft-2.txt']);
});

test('undated demo files stay in authored order and missing dates never sort ahead of real timestamps', () => {
  const first = file('Z.txt', { modifiedAt: '' }), second = file('A.txt', { modifiedAt: '' }), dated = file('B.txt');
  assert.deepEqual(select([first, second]), [first, second]);
  assert.deepEqual(select([first, dated, second]), [dated, first, second]);
});

async function fixture(t, initialMode = 'live') {
  const h = { files: [file('Draft-2.txt'), file('Draft-10.txt', { size: 100 })], requests: [], metadataResponse: null };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    h.requests.push({ url, ...init });
    if (String(url).endsWith('/api/workspace-outputs')) return h.metadataResponse ? h.metadataResponse() : { ok: true, json: async () => ({ scope: 'workspace', source: 'local_output_metadata', observedAt: '2026-10-01T00:01:00Z', items: h.files, truncated: false, warnings: [] }) };
    return new Response('真实返回的测试文本', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = async (mode = 'live') => act(async () => root.render(createElement(Monitor, { mode })));
  const click = async button => act(async () => button.click());
  const button = label => [...container.querySelectorAll('button')].find(node => node.textContent === label);
  const query = async value => act(async () => {
    const input = container.querySelector('input[type="search"]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const option = async (label, value) => selectOption(container.querySelector(`[role="combobox"][aria-label="${label}"]`), value);
  await render(initialMode);
  return { h, container, render, click, button, query, option,
    rows: () => [...container.querySelectorAll('.office-output-file-main strong')].map(item => item.textContent),
    open: async name => click(container.querySelector(`[aria-label="查看 ${name}"]`)),
  };
}

test('search/type filters compose without network reads and clear restores focus and the full list', async t => {
  const view = await fixture(t);
  await view.query('project DRAFT-2');
  assert.deepEqual(view.rows(), ['Draft-2.txt']);
  assert.match(view.container.textContent, /显示 1 \/ 2 个文件/);
  await view.option('筛选产出类型', 'image');
  assert.deepEqual(view.rows(), []);
  assert.match(view.container.textContent, /没有同时匹配关键词和类型/);
  const clear = view.button('清除筛选'); await act(async () => clear.focus()); await view.click(clear);
  assert.equal(document.activeElement, view.container.querySelector('input'));
  assert.equal(view.container.querySelector('input').value, '');
  assert.equal(view.container.querySelector('[aria-label="筛选产出类型"]').value, 'all');
  assert.equal(view.rows().length, 2);
  assert.equal(view.h.requests.length, 1);
});

test('sorting preserves the selected preview and does not reread the file, while searching closes it', async t => {
  const view = await fixture(t);
  await view.open('Draft-2.txt');
  const preview = view.container.querySelector('pre');
  assert.equal(preview.textContent, '真实返回的测试文本');
  await view.option('产出排序方式', 'size');
  assert.deepEqual(view.rows(), ['Draft-10.txt', 'Draft-2.txt']);
  assert.equal(view.container.querySelector('pre'), preview);
  assert.equal(view.h.requests.length, 2);
  await view.query('10');
  assert.deepEqual(view.rows(), ['Draft-10.txt']);
  assert.equal(view.container.querySelector('pre'), null);
  await view.click(view.button('清除筛选'));
  assert.equal(view.container.querySelector('pre'), null, 'clearing search does not reopen an old hidden file');
});

test('search limits change counts and acknowledgment to matching paths, preserving other unread files', async t => {
  const view = await fixture(t);
  view.h.files = [...view.h.files, file('Alpha.txt'), file('Beta.txt')];
  await view.click(view.button('刷新产出'));
  await view.query('alpha');
  assert.match(view.container.querySelector('.office-output-change-toolbar').textContent, /新发现 1 · 更新 0/);
  await view.click(view.button('标记已查看'));
  await view.click(view.button('清除筛选'));
  assert.match(view.container.querySelector('.office-output-change-toolbar').textContent, /新发现 1 · 更新 0/);
  const markedRow = view.container.querySelector('.office-output-file.has-change');
  assert.equal(markedRow.getAttribute('aria-label'), '查看 Beta.txt');
  assert.equal(view.h.requests.length, 2);
});

test('mode changes reset search/type/sort and demo search never reads real files', async t => {
  const view = await fixture(t);
  await view.query('none'); await view.option('产出排序方式', 'size'); await view.option('筛选产出类型', 'image');
  await view.render('demo');
  assert.equal(view.container.querySelector('input').value, '');
  assert.equal(view.container.querySelector('[aria-label="产出排序方式"]').value, 'recent');
  assert.equal(view.container.querySelector('[aria-label="筛选产出类型"]').value, 'all');
  const before = view.h.requests.length;
  await view.query('品牌');
  assert.deepEqual(view.rows(), ['品牌提案摘要.md']);
  await view.open('品牌提案摘要.md');
  assert.match(view.container.textContent, /模拟产出示例/);
  assert.equal(view.h.requests.length, before);
  assert.equal(view.container.querySelectorAll('a').length, 0);
});

test('switching away from demo removes its files and open preview while live metadata is pending, failed or empty', async t => {
  const view = await fixture(t, 'demo');
  await view.open('品牌提案摘要.md');
  assert.ok(view.container.querySelector('.office-output-demo-preview'));
  assert.equal(view.h.requests.length, 0);
  let resolve;
  view.h.metadataResponse = () => new Promise(done => { resolve = done; });
  await view.render('live');
  assert.equal(typeof resolve, 'function');
  assert.deepEqual(view.rows(), []);
  assert.equal(view.container.querySelector('.office-output-demo-preview'), null);
  assert.doesNotMatch(view.container.textContent, /品牌提案摘要|春日视觉方案|交付检查清单|模拟产出示例/);
  assert.match(view.container.querySelector('.office-output-empty').textContent, /正在读取工作区的真实文件清单/);
  await act(async () => resolve({ ok: false, status: 503 }));
  assert.deepEqual(view.rows(), []);
  assert.match(view.container.querySelector('.office-output-error').textContent, /HTTP 503/);
  assert.equal(view.container.querySelectorAll('a').length, 0);
  view.h.metadataResponse = null;
  view.h.files = [];
  await view.click(view.button('刷新产出'));
  assert.deepEqual(view.rows(), []);
  assert.match(view.container.querySelector('.office-output-empty').textContent, /未发现可展示的近期产出/);
  view.h.files = [file('Actual.txt')];
  await view.click(view.button('刷新产出'));
  assert.deepEqual(view.rows(), ['Actual.txt']);
  assert.equal(view.container.querySelector('.office-output-preview'), null, 'the former demo selection cannot open a real file');
  await view.open('Actual.txt');
  assert.equal(view.container.querySelector('pre').textContent, '真实返回的测试文本');
});

test.after(() => window.close());
