import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule, tsModuleUrl } from './load-ts.mjs';

// Simulated DOM and controlled HTTP only; no real model requests or layout QA.
globalThis.window = new Window({ url: 'http://127.0.0.1:7880/' });
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.sessionStorage = window.sessionStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const events = await loadTsModule('../src/lib/eventNotifications.ts', import.meta.url);
const { default: Center } = await loadTsModule('../src/components/EventNotificationCenter.tsx', import.meta.url);
const { default: Usage } = await loadTsModule('../src/components/ChatUsageDialog.tsx', import.meta.url);
const { default: Catalog } = await loadTsModule('../src/components/ClawHubPanel.tsx', import.meta.url);

async function view(t, Component, props = {}) {
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(createElement(Component, props)));
  t.after(async () => { await act(async () => root.unmount()); node.remove(); });
  return { node, root, click: async element => act(async () => element.click()) };
}
const key = value => new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('notification clear, bounded history and reload retain deduplication and safe destinations', async () => {
  events.clearEvents();
  assert.equal(events.recordEvent('完成', 'success', undefined, 'same', { page: 'chat', sessionId: 's1' }), true);
  events.clearEvents();
  assert.equal(events.recordEvent('完成', 'success', undefined, 'same'), false);
  for (let i = 0; i < 110; i++) events.recordEvent(`事件${i}`, 'info', undefined, `bound-${i}`);
  assert.equal(events.readEvents().length, 100);
  events.markEventsRead();
  assert.ok(events.readEvents().every(row => row.read));
  const reloaded = await import(`${await tsModuleUrl(new URL('../src/lib/eventNotifications.ts', import.meta.url))}#reload`);
  assert.equal(reloaded.readEvents().length, 100);
  assert.equal(reloaded.recordEvent('完成', 'success', undefined, 'same'), false);
  assert.equal(events.notificationOutputPath('/api/media/project/a%20b.mp4'), 'project/a b.mp4');
  for (const path of ['https://evil.example/api/media/a.mp4', '/api/media/a%2F..%2Fb', '/api/media/a%5Cb', '/api/media/a%00b']) {
    assert.equal(events.notificationOutputPath(path), undefined);
  }
});

test('global notifications mark the selected event read, route to its target and restore keyboard focus', async t => {
  events.clearEvents();
  events.recordEvent('需要回答', 'info', undefined, 'question-ui', { page: 'chat', sessionId: 'pending-session' });
  const opened = [];
  const v = await view(t, Center, { onOpen: target => opened.push(target) });
  const trigger = v.node.querySelector('.global-events-entry');
  await v.click(trigger);
  assert.equal(document.activeElement, v.node.querySelector('[role="dialog"]'));
  await v.click(v.node.querySelector('[aria-label="查看：需要回答"]'));
  assert.deepEqual(opened, [{ page: 'chat', sessionId: 'pending-session' }]);
  assert.equal(events.readEvents()[0].read, true);
  assert.equal(document.activeElement, trigger);
  await v.click(trigger);
  await act(async () => document.dispatchEvent(key('Escape')));
  assert.equal(v.node.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, trigger);
});

test('usage dialog scopes OpenClaw HTTP to current session and closes on session changes', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => { requests.push(String(url)); return new Response('{}', { status: 503 }); });
  const v = await view(t, Usage, { sessionId: 'session one', refreshKey: 0, streaming: false });
  const trigger = v.node.querySelector('button');
  await v.click(trigger);
  assert.ok(requests.some(url => new URL(url, window.location.href).searchParams.get('sessionId') === 'session one'));
  assert.match(v.node.textContent, /未上报字段保持未知/);
  assert.equal(document.activeElement, v.node.querySelector('[role="dialog"]'));
  await act(async () => document.dispatchEvent(key('Tab')));
  assert.equal(document.activeElement.getAttribute('aria-label'), '关闭消耗细则');
  await act(async () => document.dispatchEvent(key('Escape')));
  assert.equal(document.activeElement, trigger);
  await v.click(trigger);
  await act(async () => v.root.render(createElement(Usage, { sessionId: 's2', refreshKey: 1, streaming: false })));
  assert.equal(v.node.querySelector('[role="dialog"]'), null);
});

test('Codex usage stays explicitly unknown without querying the OpenClaw ledger', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('no OpenClaw usage request for Codex'));
  const v = await view(t, Usage, { sessionId: 'c1', refreshKey: 0, streaming: false, engine: 'codex' });
  await v.click(v.node.querySelector('button'));
  assert.match(v.node.textContent, /Codex 引擎尚未接入/);
  assert.match(v.node.textContent, /未提供数据不代表没有消耗/);
});

async function catalogView(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise(resolve => calls.push({ url: String(url), options, resolve })));
  const v = await view(t, Catalog);
  const input = v.node.querySelector('input');
  // Input state commits before form submission, matching separate user events.
  const search = async value => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => v.node.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  };
  return { ...v, calls, search };
}
const skill = { id: 'alice/research', slug: 'research', displayName: 'Research', ownerHandle: 'alice',
  summary: '<img src=x onerror=alert(1)>', version: null, updatedAt: null, canonicalUrl: 'https://clawhub.ai/alice/skills/research' };

test('ClawHub stale searches cannot replace current results; empty results remain clear', async t => {
  const v = await catalogView(t);
  await v.search('old');
  assert.equal(v.calls.length, 1);
  await v.search('new');
  assert.equal(v.calls[0].options.signal.aborted, true);
  await act(async () => v.calls[1].resolve(json({ query: 'new', results: [], limit: 12 })));
  await act(async () => v.calls[0].resolve(json({ query: 'old', results: [skill], limit: 12 })));
  assert.match(v.node.textContent, /没有找到匹配技能/);
  assert.doesNotMatch(v.node.textContent, /Research/);
});

test('ClawHub renders author text safely, retries details, and Escape returns to the opener', async t => {
  const v = await catalogView(t);
  await v.search('research');
  await act(async () => v.calls[0].resolve(json({ query: 'research', results: [skill], limit: 12 })));
  assert.equal(v.node.querySelector('img'), null);
  assert.match(v.node.textContent, /<img src=x/);
  const opener = v.node.querySelector('[aria-label="查看 Research 详情"]');
  opener.focus(); await v.click(opener);
  assert.match(v.calls[1].url, /research\?owner=alice/);
  await act(async () => v.calls[1].resolve(new Response(JSON.stringify({ detail: '暂时失败' }), { status: 502 })));
  assert.match(v.node.querySelector('[role="alert"]').textContent, /暂时失败/);
  const retry = [...v.node.querySelectorAll('button')].find(button => button.textContent === '重试详情');
  retry.focus(); await v.click(retry);
  await act(async () => v.calls[2].resolve(json({ skill: { ...skill, description: '<script>bad()</script>', topics: [] },
    owner: { handle: 'alice' }, latestVersion: { version: '1.2.3' } })));
  assert.equal(v.node.querySelector('script'), null);
  assert.match(v.node.textContent, /1\.2\.3/);
  assert.equal(v.node.querySelector('.clawhub-detail a').getAttribute('href'), skill.canonicalUrl);
  await act(async () => v.node.querySelector('h2[tabindex]').dispatchEvent(key('Escape')));
  assert.equal(v.node.querySelector('.clawhub-detail'), null);
  // The retry control disappears when closing: focus must return to the result.
  assert.equal(document.activeElement, opener);
});
