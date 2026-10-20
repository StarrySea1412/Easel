import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { sourceUrl, operationSources, collectSources, recordPageSource, readPageSources, sourceTurns } = await loadTsModule('../src/lib/chatSources.ts', import.meta.url);
const { default: Panel } = await loadTsModule('../src/components/ChatSourcesPanel.tsx', import.meta.url);
const operation = (id, more = {}) => ({ id, name: 'web_search', kind: 'search', status: 'returned', command: '', path: '', diff: '', output: '', ...more });
const session = id => ({ id, title: id, created: 1, messages: [{ role: 'user', content: '资料检索' }, { role: 'assistant', content: 'https://not-a-source.example/', turnId: 'turn' }] });
const snapshot = (sid, tid, operations, more = {}) => ({ sessionId: sid, turnId: tid, operations, warnings: [], nextBefore: null, ...more });

async function setup(t, props, fetcher) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url: String(url), options }); return fetcher(url, options); });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const render = next => act(async () => { root.render(createElement(Panel, next)); await new Promise(resolve => setTimeout(resolve, 0)); });
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await render(props);
  return { container, requests, render, click: element => act(async () => element.click()),
    type: value => act(async () => { const input = container.querySelector('input'); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })); }) };
}
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('observed web results preserve titles, safe query URLs and exact source scope', () => {
  const links = operationSources(operation('s', { output: JSON.stringify({ results: [{ title: '官方资料', url: 'https://docs.example/guide#intro' }] }), url: 'https://docs.example/guide' }));
  assert.deepEqual(links, [{ url: 'https://docs.example/guide', title: '官方资料' }]);
  assert.equal(sourceUrl('https://example.org/?q=文档'), 'https://example.org/?q=%E6%96%87%E6%A1%A3');
  for (const value of ['javascript:alert(1)', 'file:///tmp/test', 'https://user:pass@example.org/', 'https://example.org/?token=', 'https://example.org/?api_key=secret', 'https://example.org/ a']) assert.equal(sourceUrl(value), null);
  assert.deepEqual(operationSources(operation('shell', { name: 'exec', output: 'https://not-a-source.example/' })), []);
  assert.deepEqual(operationSources(operation('failure', { status: 'failed', output: 'https://not-a-source.example/' })), []);
  assert.deepEqual(operationSources(operation('private', { contentHidden: true, url: 'https://private.example/' })), []);
  assert.equal(operationSources(operation('md', { output: '[官网](https://example.org/guide)' }))[0].title, '官网');
});

test('structured MCP references merge by URL and preserve each turn and observed tool count', () => {
  const result = collectSources([{ turnId: 'a', rows: [operation('one', { name: 'lookup_docs', webSources: [{ url: 'https://example.org/', title: '文档' }] })] },
    { turnId: 'b', rows: [operation('two', { url: 'https://example.org/#other' }), operation('fail', { name: 'web_fetch', status: 'failed' })] }], []);
  assert.equal(result.pages.length, 1); assert.equal(result.pages[0].title, '文档');
  assert.deepEqual(result.pages[0].evidence.map(item => item.turnId), ['a', 'b']);
  assert.equal(result.tools.find(tool => tool.name === 'web_fetch').failed, 1);
});

test('manual page evidence persists only metadata, is bounded and stays within its session', () => {
  for (let i = 0; i < 202; i++) recordPageSource('manual', { id: String(i), url: `https://example.org/${i}`, title: '实际观察', at: '2026-10-20T00:00:00Z', kind: 'browser' });
  recordPageSource('manual', { id: '201', url: 'https://other.example/', title: '重复事件', at: '', kind: 'browser' });
  assert.equal(readPageSources('manual').length, 200);
  assert.equal(readPageSources('manual')[0].id, '2');
  assert.deepEqual(readPageSources('other'), []);
  assert.deepEqual(sourceTurns({ ...session('backup'), importedFromBackup: true }), []);
});

test('the panel searches observed sources, keeps original links safe and locates their conversation', async t => {
  const located = [];
  const view = await setup(t, { session: session('panel'), active: true, onLocate: id => located.push(id) }, () => response(snapshot('panel', 'turn', [
    operation('one', { query: '查证资料', output: '[官方参考](https://docs.example/guide)' }),
    operation('two', { name: 'mcp_lookup', webSources: [{ url: 'https://other.example/', title: '<script>不执行</script>' }] }),
  ])));
  assert.equal(view.container.querySelectorAll('.source-page-title').length, 2);
  const link = view.container.querySelector('a[href="https://docs.example/guide"]');
  assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(view.container.querySelector('script'), null);
  assert.doesNotMatch(view.container.textContent, /not-a-source/);
  await view.type('查证');
  assert.equal(view.container.querySelectorAll('.source-page-title').length, 1);
  await view.click(view.container.querySelector('.source-evidence button'));
  assert.deepEqual(located, ['turn']); assert.match(view.container.textContent, /第 1 轮对话/);
  assert.equal(view.requests.length, 1, 'source exploration never sends a model request');
});

test('older operation pages are read and failures preserve evidence with a retry', async t => {
  let fail = false;
  const view = await setup(t, { session: session('paging'), active: true, onLocate() {} }, url => {
    if (fail) return new Response('{}', { status: 503 });
    return response(snapshot('paging', 'turn', [operation(String(url).includes('before=') ? 'old' : 'new', { url: String(url).includes('before=') ? 'https://older.example/' : 'https://newer.example/' })], { nextBefore: String(url).includes('before=') ? null : 5 }));
  });
  assert.equal(view.requests.length, 2); assert.equal(view.container.querySelectorAll('a').length, 2);
  fail = true; await view.click(view.container.querySelector('[aria-label="刷新来源"]'));
  assert.match(view.container.querySelector('[role=alert]').textContent, /部分来源/);
  assert.equal(view.container.querySelectorAll('a').length, 2);
});

test('hidden panels and imported backups do not request live execution records', async t => {
  const view = await setup(t, { session: session('hidden'), active: false, onLocate() {} }, () => { throw new Error('must not request'); });
  assert.equal(view.requests.length, 0);
  await view.render({ session: { ...session('backup'), importedFromBackup: true }, active: true, onLocate() {} });
  assert.equal(view.requests.length, 0); assert.match(view.container.textContent, /备份中的附件/);
});

test('a late response from the previous session never enters the newly selected conversation', async t => {
  let complete;
  const view = await setup(t, { session: session('old-session'), active: true, onLocate() {} }, url => String(url).includes('old-session')
    ? new Promise(resolve => { complete = resolve; }) : response(snapshot('new-session', 'turn', [])));
  await view.render({ session: session('new-session'), active: true, onLocate() {} });
  await act(async () => complete(response(snapshot('old-session', 'turn', [operation('old', { url: 'https://private-old.example/' })]))));
  assert.doesNotMatch(view.container.textContent, /private-old/); assert.equal(view.container.querySelectorAll('a').length, 0);
});

test('source batches expose older turns and live events stay bound to the selected conversation', async t => {
  const chat = { id: 'history', title: '历史', created: 1, messages: Array.from({ length: 12 }, (_, index) => ({ role: 'assistant', content: '', turnId: `t${index}` })) };
  const view = await setup(t, { session: chat, active: true, onLocate() {} }, url => {
    const turn = String(url).split('/').at(-1);
    return response(snapshot('history', turn, [operation(turn, { url: `https://example.org/${turn}` })]));
  });
  assert.equal(view.container.querySelectorAll('a').length, 10);
  await view.click(view.container.querySelector('.source-load-more'));
  assert.equal(view.container.querySelectorAll('a').length, 12);
  await act(async () => window.dispatchEvent(new window.CustomEvent('easel:execution', { detail: snapshot('foreign', 't0', [operation('foreign', { url: 'https://foreign.example/' })]) })));
  assert.equal(view.container.querySelector('a[href="https://foreign.example/"]'), null);
  await act(async () => window.dispatchEvent(new window.CustomEvent('easel:execution', { detail: snapshot('history', 't0', [operation('new', { url: 'https://live.example/' })]) })));
  assert.ok(view.container.querySelector('a[href="https://live.example/"]'));
});
