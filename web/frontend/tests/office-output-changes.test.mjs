import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Controlled metadata and a simulated DOM verify observation semantics. They
// do not verify a real browser, on-disk changes, or actual file contents.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Monitor } = await loadTsModule('../src/components/agent-office/OfficeOutputMonitor.tsx', import.meta.url);
const { createOfficeOutputChanges: create, observeOfficeOutputs: observe, acknowledgeOfficeOutputs: acknowledge, countOfficeOutputChanges: counts } = await loadTsModule('../src/components/agent-office/officeOutputChanges.ts', import.meta.url);

function item(name = 'a.pdf', patch = {}) {
  return { id: name, name, path: `project/${name}`, kind: 'document', size: 20, modifiedAt: '2026-10-01T00:00:00Z', href: `/api/media/project/${encodeURIComponent(name)}`, ...patch };
}
function reply(files) {
  return { ok: true, json: async () => ({ scope: 'workspace', source: 'local_output_metadata', observedAt: '2026-10-01T00:01:00Z', items: files, truncated: false, warnings: [] }) };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('first snapshot is baseline; path identity, size and modification time drive subsequent indicators', () => {
  const first = item(), samePath = item('a.pdf', { id: 'new-id', name: 'renamed label' });
  let state = observe(create(), [first]);
  assert.equal(state.initialized, true);
  assert.deepEqual(counts(state, [first]), { new: 0, updated: 0 });
  state = observe(state, [samePath]);
  assert.equal(state.files.get(first.path).change, undefined);
  const sizeChanged = { ...samePath, size: 21 };
  state = observe(state, [sizeChanged]);
  assert.equal(state.files.get(first.path).change, 'updated');
  state = acknowledge(state);
  state = observe(state, [{ ...sizeChanged, modifiedAt: '2026-10-01T00:02:00Z' }, item('b.pdf')]);
  assert.deepEqual(counts(state, [first, item('b.pdf')]), { new: 1, updated: 1 });
});

test('unread marks persist across identical snapshots and clearing never re-establishes the baseline', () => {
  let state = observe(create(), []);
  state = observe(state, [item()]);
  assert.equal(state.files.get(item().path).change, 'new');
  const changed = item('a.pdf', { size: 50 });
  state = observe(state, [changed]);
  assert.equal(state.files.get(item().path).change, 'new');
  state = acknowledge(state, item().path);
  assert.deepEqual(counts(observe(state, [changed]), [changed]), { new: 0, updated: 0 });
  state = observe(state, [{ ...changed, size: 51 }, item('b.pdf')]);
  state = acknowledge(state, item('b.pdf').path);
  assert.deepEqual(counts(state, [changed, item('b.pdf')]), { new: 0, updated: 1 });
  assert.deepEqual(counts(acknowledge(state), [changed, item('b.pdf')]), { new: 0, updated: 0 });
});

test('bounded snapshots and filters count only displayed rows without treating missing paths as deleted or new', () => {
  const original = Array.from({ length: 20 }, (_, index) => item(`old-${index}.pdf`));
  let state = observe(create(), original);
  const next = Array.from({ length: 20 }, (_, index) => item(`next-${index}.pdf`));
  state = observe(state, next);
  assert.deepEqual(counts(state, next), { new: 20, updated: 0 });
  state = observe(state, [original[0]]);
  assert.deepEqual(counts(state, [original[0]]), { new: 0, updated: 0 });
  state = observe(state, [{ ...original[1], size: 99 }, next[0]]);
  assert.deepEqual(counts(state, [original[1], next[0]]), { new: 1, updated: 1 });
  assert.deepEqual(counts(state, [next[0]]), { new: 1, updated: 0 });
  assert.deepEqual(counts(state, []), { new: 0, updated: 0 });
});

async function fixture(t) {
  const h = { files: [item()], requests: [] };
  h.metadata = async () => reply(h.files);
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    h.requests.push({ url, ...init });
    if (String(url).endsWith('/api/workspace-outputs')) return h.metadata();
    return new Response('文本正文', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = async (mode = 'live') => act(async () => root.render(createElement(Monitor, { mode })));
  const click = async button => { assert.ok(button, 'expected a rendered button'); await act(async () => button.click()); };
  const button = label => [...container.querySelectorAll('button')].find(node => node.textContent === label);
  return { h, container, render, click, button,
    refresh: async () => click(button('刷新产出')),
    open: async name => click(container.querySelector(`[aria-label="查看 ${name}"]`)),
    marks: () => [...container.querySelectorAll('.office-output-change')].map(node => node.textContent),
    status: () => container.querySelector('.office-output-change-toolbar [role="status"]')?.textContent,
    leave: async () => act(async () => root.render(null)),
  };
}

test('failed and pending requests cannot establish baseline; first successful response is unmarked', async t => {
  const view = await fixture(t);
  view.h.metadata = async () => ({ ok: false, status: 503 });
  await view.render();
  assert.match(view.status(), /等待首次成功快照/);
  assert.equal(view.button('标记已查看').disabled, true);
  const pending = deferred(); view.h.metadata = () => pending.promise;
  await view.refresh();
  assert.match(view.status(), /等待首次成功快照/);
  await act(async () => pending.resolve(reply([item(), item('b.pdf')])));
  assert.deepEqual(view.marks(), []);
  assert.match(view.status(), /新发现 0 · 更新 0/);
  assert.equal(view.h.requests.length, 2);
});

test('opening clears just that file and mark-viewed clears remaining indicators without extra requests', async t => {
  const view = await fixture(t); await view.render();
  view.h.files = [item('a.pdf', { size: 30 }), item('b.pdf')];
  await view.refresh();
  assert.deepEqual(view.marks(), ['更新', '新发现']);
  assert.match(view.status(), /新发现 1 · 更新 1/);
  const newButton = view.container.querySelector('[aria-label="查看 b.pdf"]');
  assert.equal(view.container.querySelector(`[id="${newButton.getAttribute('aria-describedby')}"]`).textContent, '新发现');
  await view.open('b.pdf');
  assert.deepEqual(view.marks(), ['更新']);
  assert.ok(view.container.querySelector('a[download="b.pdf"]'));
  await view.click(view.button('标记已查看'));
  assert.deepEqual(view.marks(), []);
  assert.equal(view.button('标记已查看').disabled, true);
  assert.equal(view.h.requests.length, 2);
  await view.refresh();
  assert.deepEqual(view.marks(), []);
  assert.match(view.container.textContent, /仅比较本次页面观察的文件路径、时间和大小/);
  assert.match(view.container.textContent, /新发现不代表刚创建，更新不代表内容已验收/);
  assert.match(view.container.textContent, /每次最多 20 项/);
});

test('refresh failures preserve indicators and filtered counts include only visible rows', async t => {
  const view = await fixture(t); await view.render();
  view.h.files = [item('a.pdf', { size: 30 }), item('b.txt', { kind: 'text' })];
  await view.refresh();
  view.h.metadata = async () => ({ ok: false, status: 503 });
  await view.refresh();
  assert.deepEqual(view.marks(), ['更新', '新发现']);
  assert.match(view.container.textContent, /上次快照 · 更新中断/);
  const select = view.container.querySelector('select');
  await act(async () => { select.value = 'text'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.deepEqual(view.marks(), ['新发现']);
  assert.match(view.status(), /新发现 1 · 更新 0/);
  await view.open('b.txt');
  assert.equal(view.container.querySelector('pre').textContent, '文本正文');
  assert.deepEqual(view.marks(), []);
  assert.equal(view.h.requests.filter(request => String(request.url).includes('/api/media/')).length, 1);
});

test('mode changes reset the data hook and baseline, including pending or failed first responses', async t => {
  const view = await fixture(t); await view.render();
  view.h.files = [item('b.pdf')]; await view.refresh();
  assert.deepEqual(view.marks(), ['新发现']);
  await view.render('demo');
  assert.equal(view.status(), undefined);
  assert.deepEqual(view.marks(), []);
  const pending = deferred(); view.h.metadata = () => pending.promise;
  await view.render('live');
  assert.match(view.status(), /等待首次成功快照/);
  assert.equal(view.container.querySelector('[aria-label="查看 b.pdf"]'), null);
  await act(async () => pending.resolve({ ok: false, status: 503 }));
  assert.match(view.status(), /等待首次成功快照/);
  view.h.files = [item('c.pdf')]; view.h.metadata = async () => reply(view.h.files);
  await view.refresh();
  assert.deepEqual(view.marks(), []);
  view.h.files = [item('d.pdf')]; await view.refresh();
  assert.deepEqual(view.marks(), ['新发现']);
});

test('mark-viewed after filtering preserves indicators for files outside the visible type', async t => {
  const view = await fixture(t); await view.render();
  view.h.files = [item('notes.txt', { kind: 'text' }), item('picture.png', { kind: 'image' })];
  await view.refresh();
  const select = view.container.querySelector('select');
  const filter = async type => act(async () => { select.value = type; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await filter('text');
  assert.match(view.status(), /新发现 1 · 更新 0/);
  await view.click(view.button('标记已查看'));
  assert.deepEqual(view.marks(), []);
  assert.equal(view.button('标记已查看').disabled, true);
  await filter('image');
  assert.deepEqual(view.marks(), ['新发现']);
  assert.match(view.status(), /新发现 1 · 更新 0/);
  await filter('all');
  assert.deepEqual(view.marks(), ['新发现']);
  assert.match(view.status(), /新发现 1 · 更新 0/);
  assert.equal(view.h.requests.length, 2);
});

test('leaving and re-entering the page starts a fresh baseline and aborts the departed request', async t => {
  const view = await fixture(t); await view.render();
  const old = deferred(); view.h.metadata = () => old.promise;
  await view.refresh();
  await view.leave();
  assert.equal(view.h.requests[1].signal.aborted, true);
  view.h.files = [item('new-session.pdf')]; view.h.metadata = async () => reply(view.h.files);
  await view.render();
  await act(async () => old.resolve(reply([item('departed.pdf')])));
  assert.deepEqual(view.marks(), []);
  assert.match(view.container.textContent, /new-session.pdf/);
  assert.doesNotMatch(view.container.textContent, /departed.pdf/);
});

test.after(() => window.close());
