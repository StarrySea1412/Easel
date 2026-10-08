import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Real page + hook + API client, with controlled HTTP and a simulated DOM.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: TrendsPage } = await loadTsModule('../src/components/TrendsPage.tsx', import.meta.url);
const { TREND_PREFERENCES_KEY } = await loadTsModule('../src/lib/trendPreferences.ts', import.meta.url);

const labels = { weibo: '微博', douyin: '抖音', zhihu: '知乎', ithome: 'IT之家' };
const group = (platform, patch = {}) => ({ platform, label: labels[platform],
  items: [{ title: `${platform}的选题`, url: 'https://example.test/article', hot: '120', linkKind: 'article' }],
  status: 'fresh', fetchedAt: 1790800000, checkedAt: 1790800000, sourceUpdatedAt: null,
  source: { name: '测试来源', url: 'https://example.test/feed', kind: '公开讨论' }, error: null, ...patch });

async function fixture(t, stored) {
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(TREND_PREFERENCES_KEY, stored);
  const requests = [], used = [];
  t.mock.method(globalThis, 'fetch', (url, options = {}) => new Promise((resolve, reject) => {
    requests.push({ url, options, resolve, reject });
  }));
  const container = document.createElement('div'); document.body.append(container);
  let root = createRoot(container);
  await act(async () => root.render(createElement(TrendsPage, { onUseTopic: title => used.push(title) })));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); });
  return {
    container, requests, used,
    card: platform => container.querySelector(`[aria-label="${labels[platform]}来源"]`),
    calls: platform => requests.filter(request => new URL(request.url, 'https://easel.test').searchParams.get('platforms') === platform),
    click: async element => act(async () => element.click()),
    reply: async (request, value) => act(async () => request.resolve(new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }))),
    fail: async request => act(async () => request.reject(new Error('网络连接中断'))),
    async respond(platform, patch = {}) { await this.reply(this.calls(platform).at(-1), { trends: [group(platform, patch)], updated: 1790800000 }); },
    toggle: async label => act(async () => [...container.querySelectorAll('.trend-platforms button')].find(button => button.textContent === label).click()),
    saveSources: async () => act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存热榜').click()),
    remount: async () => { await act(async () => root.unmount()); root = createRoot(container); await act(async () => root.render(createElement(TrendsPage, { onUseTopic: title => used.push(title) }))); },
  };
}

test('each source has its own skeleton and resolves without waiting for another source', async t => {
  const f = await fixture(t);
  assert.equal(f.container.querySelectorAll('.trend-skeleton').length, 3);
  assert.equal(f.requests.length, 3);
  await f.respond('weibo');
  assert.match(f.card('weibo').textContent, /weibo的选题/);
  assert.equal(f.card('weibo').getAttribute('aria-busy'), 'false');
  assert.equal(f.card('douyin').querySelectorAll('.trend-skeleton').length, 1);
  assert.equal(f.card('zhihu').querySelectorAll('.trend-skeleton').length, 1);
  assert.equal(f.container.querySelectorAll('.trend-skeleton').length, 2);
});

test('an upstream source error remains visible and retries only that source', async t => {
  const f = await fixture(t);
  await f.respond('weibo'); await f.respond('douyin');
  await f.respond('zhihu', { items: [], status: 'error', fetchedAt: null,
    error: { code: 'rate_limited', message: '来源请求限流（HTTP 429），请稍后重试。' } });
  assert.match(f.card('zhihu').textContent, /HTTP 429/);
  assert.doesNotMatch(f.card('zhihu').textContent, /暂无数据/);
  assert.match(f.card('weibo').textContent, /weibo的选题/);
  await f.click([...f.card('zhihu').querySelectorAll('button')].find(button => button.textContent === '重试知乎'));
  assert.equal(f.calls('zhihu').length, 2);
  assert.equal(f.calls('weibo').length, 1);
  assert.equal(f.calls('douyin').length, 1);
  assert.match(f.calls('zhihu').at(-1).url, /refresh=true/);
  assert.ok(f.card('zhihu').querySelector('.trend-skeleton'));
  await f.respond('zhihu');
  assert.match(f.card('zhihu').textContent, /zhihu的选题/);
  assert.equal(f.card('zhihu').querySelector('.trend-source-error'), null);
});

test('adding a source gets a skeleton and deselection aborts only that source', async t => {
  const f = await fixture(t);
  const oldWeibo = f.calls('weibo')[0];
  await f.toggle('IT之家');
  assert.ok(f.card('ithome').querySelector('.trend-skeleton'));
  assert.equal(f.calls('ithome').length, 1);
  assert.equal(f.calls('weibo').length, 1);
  await f.toggle('微博');
  assert.equal(oldWeibo.options.signal.aborted, true);
  assert.equal(f.calls('douyin')[0].options.signal.aborted, false);
  await f.reply(oldWeibo, { trends: [group('weibo')], updated: 1790800000 });
  assert.equal(f.card('weibo'), null, 'a late reply cannot resurrect a removed card');
  await f.toggle('微博');
  assert.equal(f.calls('weibo').length, 2);
  assert.ok(f.card('weibo').querySelector('.trend-skeleton'));
});

test('refresh retains visible results and a network failure preserves their original fetched time', async t => {
  const f = await fixture(t);
  await f.respond('weibo'); await f.respond('douyin'); await f.respond('zhihu');
  const firstTime = f.card('weibo').querySelector('time').dateTime;
  await f.click(f.card('weibo').querySelector('[aria-label="刷新微博"]'));
  assert.match(f.card('weibo').textContent, /weibo的选题/);
  assert.equal(f.card('weibo').getAttribute('aria-busy'), 'true');
  await f.fail(f.calls('weibo').at(-1));
  assert.match(f.card('weibo').textContent, /网络连接中断/);
  assert.match(f.card('weibo').textContent, /上次可用数据/);
  assert.equal(f.card('weibo').querySelector('time').dateTime, firstTime);
  assert.match(f.card('douyin').textContent, /douyin的选题/);
});

test('source links, cached provenance, topic use and saved source category stay accurate', async t => {
  const f = await fixture(t);
  await f.respond('weibo', { status: 'cached', items: [{ title: '真实标题', url: 'https://example.test/search?q=topic', hot: '', linkKind: 'search' }] });
  assert.match(f.card('weibo').textContent, /缓存数据/);
  assert.match(f.card('weibo').textContent, /来源未提供榜单时间/);
  assert.match(f.card('weibo').textContent, /打开平台搜索/);
  assert.equal(f.card('weibo').querySelector('.trend-source a').getAttribute('href'), 'https://example.test/feed');
  const article = f.card('weibo').querySelector('.trend-title');
  assert.equal(article.target, '_blank');
  assert.match(article.rel, /noopener/);
  await f.click(f.card('weibo').querySelector('.trend-use'));
  assert.deepEqual(f.used, ['真实标题']);
  await f.click(f.card('weibo').querySelector('.trend-save'));
  const save = f.requests.find(request => request.options.method === 'POST');
  assert.deepEqual(JSON.parse(save.options.body), { title: '真实标题', source: '微博 · 公开讨论', status: 'pending' });
  await f.reply(save, { id: 'saved', title: '真实标题' });
  assert.equal(f.card('weibo').querySelector('.trend-save').disabled, true);
});

test('source selection saves explicitly, restores on remount and leaves unsaved changes out of storage', async t => {
  const f = await fixture(t);
  await f.toggle('IT之家');
  assert.equal(localStorage.getItem(TREND_PREFERENCES_KEY), null, 'toggling is a draft, not an implicit save');
  await f.saveSources();
  assert.deepEqual(JSON.parse(localStorage.getItem(TREND_PREFERENCES_KEY)).sources, ['weibo','douyin','zhihu','ithome']);
  assert.match(f.container.querySelector('.trend-preference-status').textContent, /已保存/);
  await f.toggle('微博');
  assert.match(f.container.querySelector('.trend-preference-status').textContent, /尚未保存/);
  await f.remount();
  assert.ok(f.card('weibo')); assert.ok(f.card('ithome'));
  assert.equal(f.container.querySelectorAll('.trend-platforms button[aria-pressed="true"]').length, 4);
});

test('empty saved selection stays empty instead of reverting to default sources', async t => {
  const f = await fixture(t);
  for (const label of ['微博','抖音','知乎']) await f.toggle(label);
  await f.saveSources();
  assert.deepEqual(JSON.parse(localStorage.getItem(TREND_PREFERENCES_KEY)).sources, []);
  const previous = f.requests.length;
  await f.remount();
  assert.equal(f.requests.length, previous);
  assert.equal(f.container.querySelectorAll('.trend-col').length, 0);
  assert.match(f.container.textContent, /选择至少一个来源/);
});

test('invalid saved selections fall back visibly and remain untouched until an explicit save', async t => {
  const f = await fixture(t, '{unreadable');
  assert.match(f.container.querySelector('.trend-preference-error').textContent, /原记录已保留/);
  assert.equal(localStorage.getItem(TREND_PREFERENCES_KEY), '{unreadable');
  await f.toggle('IT之家');
  assert.equal(localStorage.getItem(TREND_PREFERENCES_KEY), '{unreadable');
  await f.saveSources();
  assert.equal(JSON.parse(localStorage.getItem(TREND_PREFERENCES_KEY)).version, 1);
});

test('blocked storage keeps the old saved list and a retryable draft', async t => {
  const original = JSON.stringify({version:1,sources:['zhihu']});
  const f = await fixture(t, original);
  await f.toggle('IT之家');
  const write = t.mock.method(localStorage, 'setItem', () => { throw new Error('Storage unavailable'); });
  await f.saveSources();
  assert.match(f.container.querySelector('.trend-preference-error').textContent, /尚未保存/);
  assert.equal(localStorage.getItem(TREND_PREFERENCES_KEY), original);
  assert.ok(f.card('ithome'));
  write.mock.restore();
  await f.saveSources();
  assert.deepEqual(JSON.parse(localStorage.getItem(TREND_PREFERENCES_KEY)).sources, ['zhihu','ithome']);
});

test('sources include an accessible label and a local identifying icon', async t => {
  const f = await fixture(t);
  const choices = [...f.container.querySelectorAll('.trend-platforms button')];
  assert.equal(choices.length, 9);
  for (const choice of choices) {
    assert.ok(choice.getAttribute('aria-label'));
    assert.ok(choice.querySelector('.trend-platform-icon'));
    assert.equal(choice.querySelector('[aria-hidden="true"]').textContent, '', 'decorative icons do not duplicate button names');
  }
  for (const key of ['weibo','douyin','zhihu']) assert.ok(f.card(key).querySelector('.trend-platform-icon'));
});

test('Zhihu question time and provider retry time never become a ranking update time', async t => {
  const f = await fixture(t);
  await f.respond('zhihu', { status:'stale', nextRetryAt:1790800900, error:{code:'rate_limited',message:'HTTP 429'},
    items:[{title:'问题标题',url:'https://www.zhihu.com/question/123',hot:'热度 120',createdAt:1790800000}], sourceUpdatedAt:null });
  assert.match(f.card('zhihu').textContent, /提问于/);
  assert.match(f.card('zhihu').textContent, /建议.*后重试/);
  assert.match(f.card('zhihu').textContent, /来源未提供榜单时间/);
  assert.doesNotMatch(f.card('zhihu').textContent, /来源更新/);
});

test.after(() => window.close());
