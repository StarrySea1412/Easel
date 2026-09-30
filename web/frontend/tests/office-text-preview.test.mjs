import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Actual readers and components with controlled streams/metadata in a simulated
// DOM. These checks do not claim real file or browser-download verification.
globalThis.window = new Window({ url: 'https://easel.test/workbench/index.html' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { readOfficeTextPreview, canPreviewOfficeText, OFFICE_TEXT_PREVIEW_LIMIT: LIMIT } = await loadTsModule('../src/components/agent-office/officeTextPreview.ts', import.meta.url);
const { default: Monitor } = await loadTsModule('../src/components/agent-office/OfficeOutputMonitor.tsx', import.meta.url);
const encoder = new TextEncoder();
function item(name = 'notes.md', patch = {}) {
  return { id: name, name, path: `project/${name}`, kind: 'text', size: 20, modifiedAt: '2026-10-01T00:00:00Z', href: `/api/media/project/${encodeURIComponent(name)}`, ...patch };
}
function response(body = '正文', mime = 'text/plain; charset=utf-8', status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': mime } });
}
function stream(chunks) {
  const h = { pulls: 0, canceled: 0 };
  h.body = new ReadableStream({
    pull(controller) { const value = chunks[h.pulls++]; if (value === undefined) controller.close(); else controller.enqueue(value); },
    cancel() { h.canceled++; },
  }, { highWaterMark: 0 });
  return h;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const read = file => readOfficeTextPreview(file || item(), new AbortController().signal);

test('only supported local text extensions fetch, with no redirects and no cache', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push({ url, init }); return response(); });
  for (const name of ['notes.txt', 'notes.md', 'notes.srt', 'notes.vtt']) {
    assert.equal(canPreviewOfficeText(item(name)), true); await read(item(name));
  }
  for (const file of [item('page.html'), item('page.htm'), item('image.svg'), item('data.json'), item('data.csv'), item('notes.txt', { kind: 'document' }),
    item('notes.txt', { href: 'https://other.test/file.txt' }), item('notes.txt', { path: '../secret.txt', href: '/api/media/../secret.txt' }),
    item('notes.txt', { href: '/api/media/project/other.txt' })]) {
    await assert.rejects(read(file), /安全文本预览/);
  }
  assert.equal(requests.length, 4);
  const { url, init } = requests[0];
  assert.equal(new URL(url).origin, 'https://easel.test');
  assert.equal(new URL(url).pathname, '/workbench/api/media/project/notes.txt');
  assert.equal(new URL(url).searchParams.get('v'), item().modifiedAt);
  assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); assert.equal(init.mode, 'same-origin');
});

test('MIME, declared encoding and redirect checks reject before consuming the body', async t => {
  let reply;
  t.mock.method(globalThis, 'fetch', async () => reply);
  for (const mime of ['text/html', 'image/svg+xml', 'application/octet-stream', '', 'text/plain; charset=iso-8859-1']) {
    const body = stream([encoder.encode('正文')]); reply = response(body.body, mime);
    await assert.rejects(read(), /文件类型或编码/);
    assert.equal(body.pulls, 0); assert.equal(body.canceled, 1);
  }
  reply = response('正文'); Object.defineProperty(reply, 'redirected', { value: true });
  await assert.rejects(read(), /来源发生跳转/);
  reply = response('正文'); Object.defineProperty(reply, 'url', { value: 'https://other.test/notes.md' });
  await assert.rejects(read(), /来源发生跳转/);
});

test('UTF-8 characters survive chunk boundaries and malformed or binary content is rejected', async t => {
  let reply;
  t.mock.method(globalThis, 'fetch', async () => reply);
  const encoded = encoder.encode('你好\n正文🙂');
  reply = response(stream([...encoded].map(byte => Uint8Array.of(byte))).body);
  assert.deepEqual(await read(), { text: '你好\n正文🙂', bytesRead: encoded.byteLength, truncated: false });
  for (const bytes of [Uint8Array.of(0xc3, 0x28), Uint8Array.of(0xe4, 0xb8), Uint8Array.of(65, 0, 66)]) {
    reply = response(bytes);
    await assert.rejects(read(), /UTF-8|非文本数据/);
  }
  reply = response('<!DOCTYPE html><html><body>not text</body></html>');
  await assert.rejects(read(), /HTML 或 SVG/);
  reply = response('<svg><script>alert(1)</script></svg>');
  await assert.rejects(read(), /HTML 或 SVG/);
});

test('huge streams stop after the 64 KiB prefix and cancel without reading the rest', async t => {
  const body = stream([new Uint8Array(LIMIT * 16).fill(65), encoder.encode('must not read')]);
  t.mock.method(globalThis, 'fetch', async () => response(body.body));
  const result = await read();
  assert.equal(result.bytesRead, LIMIT); assert.equal(result.text.length, LIMIT); assert.equal(result.truncated, true);
  assert.equal(body.pulls, 1); assert.equal(body.canceled, 1);
});

test('the cap safely omits an incomplete final UTF-8 character instead of reporting corruption', async t => {
  const body = stream([encoder.encode('a'.repeat(LIMIT - 1) + '中🙂')]);
  t.mock.method(globalThis, 'fetch', async () => response(body.body));
  const result = await read();
  assert.equal(result.bytesRead, LIMIT); assert.equal(result.text, 'a'.repeat(LIMIT - 1));
  assert.equal(result.truncated, true); assert.equal(body.canceled, 1);
});

test('empty responses finish normally and pre-canceled reads never fetch', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => response(''));
  assert.deepEqual(await read(), { text: '', bytesRead: 0, truncated: false });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readOfficeTextPreview(item(), controller.signal), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 1);
});

test('timeout settles a stalled stream, aborts transport and cancels the reader', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let canceled = 0, signal;
  const body = new ReadableStream({ pull() {}, cancel() { canceled++; } }, { highWaterMark: 0 });
  t.mock.method(globalThis, 'fetch', async (_url, init) => { signal = init.signal; return response(body); });
  const pending = read();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const rejected = assert.rejects(pending, /读取超时/);
  t.mock.timers.tick(12_000); await rejected;
  assert.equal(signal.aborted, true); assert.equal(canceled, 1);
});

async function fixture(t, mode = 'live') {
  const h = { requests: [], files: [item()], media: async () => response('默认正文') };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    h.requests.push({ url, ...init });
    return String(url).endsWith('/api/workspace-outputs')
      ? { ok: true, json: async () => ({ scope: 'workspace', source: 'local_output_metadata', observedAt: item().modifiedAt, items: h.files, truncated: false, warnings: [] }) }
      : h.media(url, init);
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); let mounted = true;
  const render = async nextMode => act(async () => root.render(createElement(Monitor, { mode: nextMode || mode })));
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } };
  t.after(async () => { await unmount(); container.remove(); });
  return { h, container, render, unmount,
    button: label => [...container.querySelectorAll('button')].find(button => button.textContent === label),
    mediaRequests: () => h.requests.filter(request => String(request.url).includes('/api/media/')),
    click: async button => act(async () => button.click()),
    async select(name) { await act(async () => container.querySelector(`[aria-label="查看 ${name}"]`).click()); },
  };
}

test('selection loads text on demand and renders markup literally without links, images or scripts', async t => {
  const view = await fixture(t);
  const content = '# 标题\n<script>globalThis.executed = true</script>\n<img src="https://other.test/image">\n[link](https://other.test)';
  view.h.media = async () => response(content, 'text/markdown');
  await view.render(); assert.equal(view.mediaRequests().length, 0);
  await view.select('notes.md');
  assert.equal(view.container.querySelector('pre').textContent, content);
  assert.match(view.container.textContent, /本次读取的文件内容，可能与列表快照不同/);
  assert.equal(view.container.querySelectorAll('pre script, pre img, pre a, iframe').length, 0);
  assert.equal(globalThis.executed, undefined);
  assert.equal(view.container.querySelector('a[download]').getAttribute('href'), '/workbench/api/media/project/notes.md');
});

test('switching files and leaving the page abort old reads and suppress late text', async t => {
  const view = await fixture(t);
  view.h.files = [item('a.txt'), item('b.txt')];
  const a = deferred(), b = deferred();
  view.h.media = url => String(url).includes('a.txt') ? a.promise : b.promise;
  await view.render(); await view.select('a.txt');
  assert.match(view.container.textContent, /正在限量读取文本/);
  await view.select('b.txt');
  assert.equal(view.mediaRequests()[0].signal.aborted, true);
  await act(async () => a.resolve(response('旧文件内容')));
  assert.doesNotMatch(view.container.textContent, /旧文件内容/);
  await view.unmount(); assert.equal(view.mediaRequests()[1].signal.aborted, true);
  await act(async () => b.resolve(response('已离开页面的内容')));
  assert.equal(view.container.textContent, '');
});

test('same-name metadata changes cancel and replace the preview; unchanged polling does not reread it', async t => {
  const view = await fixture(t); const first = deferred(); let count = 0;
  view.h.media = async () => ++count === 1 ? first.promise : response(`版本 ${count}`);
  await view.render(); await view.select('notes.md');
  view.h.files = [item('notes.md', { modifiedAt: '2026-10-01T00:01:00Z' })];
  await view.click(view.button('刷新产出'));
  assert.equal(view.mediaRequests()[0].signal.aborted, true);
  assert.equal(view.container.querySelector('pre').textContent, '版本 2');
  await act(async () => first.resolve(response('晚到旧版')));
  assert.doesNotMatch(view.container.textContent, /晚到旧版/);
  await view.click(view.button('刷新产出')); assert.equal(count, 2);
  view.h.files = [{ ...view.h.files[0], size: 100 }];
  await view.click(view.button('刷新产出'));
  assert.equal(view.container.querySelector('pre').textContent, '版本 3');
  assert.equal(new URL(view.mediaRequests()[2].url).searchParams.get('size'), '100');
});

test('failed previews can retry, empty files are explicit, and truncated previews show the limit', async t => {
  const view = await fixture(t); view.h.media = async () => response('not displayed', 'text/plain', 503);
  await view.render(); await view.select('notes.md');
  assert.match(view.container.querySelector('[role="alert"]').textContent, /HTTP 503/);
  assert.equal(view.container.querySelector('pre'), null);
  view.h.media = async () => response(''); await view.click(view.button('重试文本预览'));
  assert.match(view.container.textContent, /文件为空/);
  await view.select('notes.md');
  view.h.media = async () => response(Uint8Array.of(0xef, 0xbb, 0xbf));
  await view.select('notes.md');
  assert.match(view.container.textContent, /没有可显示正文/);
  assert.doesNotMatch(view.container.textContent, /文件为空/);
  await view.select('notes.md');
  view.h.media = async () => response(new Uint8Array(LIMIT + 20).fill(65));
  await view.select('notes.md');
  assert.equal(view.container.querySelector('pre').textContent.length, LIMIT);
  assert.match(view.container.textContent, /已达到 64 KiB 读取上限/);
});

test('HTML remains download-only and demo mode never requests file content', async t => {
  const view = await fixture(t); view.h.files = [item('page.html')];
  await view.render(); await view.select('page.html');
  assert.match(view.container.textContent, /不在面板中嵌入预览/);
  assert.equal(view.mediaRequests().length, 0); assert.equal(view.container.querySelector('pre'), null);
  await view.render('demo'); const before = view.h.requests.length;
  await view.select('品牌提案摘要.md');
  assert.match(view.container.textContent, /模拟产出示例/);
  assert.equal(view.h.requests.length, before); assert.equal(view.container.querySelectorAll('a').length, 0);
});

test.after(() => window.close());
