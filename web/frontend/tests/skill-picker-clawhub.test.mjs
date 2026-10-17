import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Actual picker with controlled HTTP; external catalog replies are never executed.
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:7880/' }).window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1024 });
const { createRoot } = await import('react-dom/client');
const { default: Picker } = await loadTsModule('../src/components/BrushEntry.tsx', import.meta.url);
const external = { id: 'alice/card-quote', slug: 'card-quote', displayName: 'External Quote', ownerHandle: 'alice', summary: '<img src=x onerror=bad()>', version: '1.2.3', updatedAt: 1792000000000, canonicalUrl: 'https://clawhub.ai/alice/card-quote', stats: { downloads: 5609, installs: 148, stars: 7, versions: 7, comments: 3 } };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

async function fixture(t) {
  const calls = [], picked = [];
  t.mock.method(globalThis, 'fetch', (url, options = {}) => {
    if (String(url) === '/api/skills') return Promise.resolve(json([{ name: 'card-quote', description: 'Local Quote' }]));
    return new Promise((resolve, reject) => calls.push({ url: String(url), options, resolve, reject }));
  });
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(createElement(Picker, { selectedSkills: ['card-quote'], onPick: (...args) => picked.push(args), onRemove() {} })));
  const click = async element => { assert.ok(element); await act(async () => { element.focus(); element.click(); }); };
  const button = text => [...document.querySelectorAll('button')].find(row => row.textContent.trim() === text);
  await click(node.querySelector('button'));
  await click(button('ClawHub'));
  t.after(async () => { await act(async () => root.unmount()); node.remove(); });
  return {
    node, calls, picked, click, button,
    async search(term) {
      const input = document.querySelector('.brush-search');
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, term);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await act(async () => document.querySelector('.skill-picker form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    },
    async reply(index, data) { await act(async () => calls[index].resolve(json(data))); },
  };
}

test('picker searches ClawHub, keeps external identity separate, retries details and returns focus on Escape', async t => {
  const v = await fixture(t); await v.search('quote');
  assert.match(v.calls[0].url, /clawhub\/search\?q=quote/);
  await v.reply(0, { query: 'quote', results: [external], limit: 12 });
  assert.equal(document.querySelector('.skill-picker img'), null);
  assert.match(document.querySelector('.brush-clawhub-item').textContent, /alice\/card-quote/);
  assert.match(document.querySelector('.brush-clawhub-item').textContent, /下载 5,609 · 评论 3/, 'public counters show on the result row');
  assert.equal(document.querySelector('.brush-item'), null, 'same slug does not become a local selectable skill');
  const opener = document.querySelector('.brush-clawhub-open'); await v.click(opener);
  assert.match(v.calls[1].url, /card-quote\?owner=alice/);
  await act(async () => v.calls[1].reject(new Error('temporary failure')));
  await v.click(v.button('重试详情'));
  await v.reply(2, { skill: { ...external, description: '<script>bad()</script>', topics: ['writing'] }, owner: { handle: 'alice' }, latestVersion: { version: '1.2.3', changelog: 'Improved' } });
  assert.equal(document.querySelector('.skill-picker script'), null);
  assert.match(document.querySelector('.brush-clawhub-detail').textContent, /尚未在 Easel 中验证/);
  const detailText = document.querySelector('.brush-clawhub-detail').textContent;
  assert.match(detailText, /下载 5,609/, 'detail lists downloads');
  assert.match(detailText, /安装 148/, 'detail lists installs');
  assert.match(detailText, /评论 3/, 'detail lists comments as the registry counter, not an invented issue tracker');
  await act(async () => document.querySelector('.brush-clawhub-detail h3').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.ok(document.querySelector('.skill-picker'), 'Escape closes details first');
  assert.equal(document.activeElement, opener);
  assert.deepEqual(v.picked, []);
  assert.match(document.querySelector('.skill-picker-footer').textContent, /已选 1 个/);
});

test('switching sources aborts stale searches and closing a pending search does not leave the picker stuck', async t => {
  const v = await fixture(t); await v.search('old');
  await v.click(v.button('本机已安装'));
  assert.equal(v.calls[0].options.signal.aborted, true);
  await v.click(v.button('ClawHub')); await v.search('new');
  await v.reply(1, { query: 'new', results: [], limit: 12 });
  await v.reply(0, { query: 'old', results: [external], limit: 12 });
  assert.match(document.querySelector('.skill-picker').textContent, /没有找到匹配「new」/);
  assert.equal(document.querySelector('.brush-clawhub-item'), null);
  await v.search('pending');
  await v.click(document.querySelector('[aria-label="关闭技能选择"]'));
  assert.equal(v.calls[2].options.signal.aborted, true);
  await v.click(v.node.querySelector('button'));
  assert.equal(document.querySelector('.brush-search-submit').disabled, false);
  await v.search('pending again');
  await v.click(v.node.querySelector('button'));
  assert.equal(v.calls[3].options.signal.aborted, true);
  await v.click(v.node.querySelector('button'));
  assert.equal(document.querySelector('.brush-search-submit').disabled, false, 'trigger-close also clears loading');
});

test('search timeout is explicit and can be retried without installing or picking skills', async t => {
  const v = await fixture(t);
  let expire;
  const original = window.setTimeout.bind(window);
  t.mock.method(window, 'setTimeout', (fn, ms, ...args) => ms === 10000 ? (expire = fn, 123456) : original(fn, ms, ...args));
  await v.search('timeout');
  await act(async () => { expire(); v.calls[0].reject(new Error('aborted')); });
  assert.match(document.querySelector('[role="alert"]').textContent, /检索超时/);
  await v.click(v.button('重新搜索'));
  await v.reply(1, { query: 'timeout', results: [], limit: 12 });
  assert.match(document.querySelector('.skill-picker').textContent, /没有找到匹配/);
  assert.deepEqual(v.picked, []);
});
