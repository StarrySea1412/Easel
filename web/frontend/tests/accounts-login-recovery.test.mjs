import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Synthetic DOM and local HTTP responses only. No platform login is performed.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: AccountsPage } = await loadTsModule('../src/components/AccountsPage.tsx', import.meta.url);
const snapshot = (state, message = '', qr = '') => ({ mode: 'qr', state, message, qr });
const response = value => ({ ok: true, json: async () => value });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const accounts = [
  { platform: 'xiaohongshu', name: '小红书', backend: 'xhs', supported: true, loggedIn: false },
  { platform: 'wechat-oa', name: '微信公众号', backend: 'wechat-oa', supported: true, loggedIn: false },
];

async function fixture(t) {
  localStorage.clear();
  localStorage.setItem('easel_whoami', JSON.stringify(Object.fromEntries(accounts.map(account => [account.platform, {
    loggedIn: false, name: '', avatar: '', ts: Date.now(),
  }]))));
  const timers = new Map();
  let timerId = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { assert.equal(delay, 2000); const id = ++timerId; timers.set(id, callback); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const state = {
    requests: [], start: async () => snapshot('qr_ready', '', '_login/synthetic-current.png'),
    read: async () => snapshot('qr_ready', '', '_login/synthetic-current.png'),
    sms: async () => ({ ok: true }), analyzed: 0, whoamiCalls: 0,
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    state.requests.push({ url, method: options?.method || 'GET' });
    assert.equal(options.cache, 'no-store');
    if (url === '/api/accounts') return response(accounts);
    if (url.endsWith('/whoami')) { state.whoamiCalls++; return response({ loggedIn: true, name: 'Synthetic account', avatar: '' }); }
    if (url.endsWith('/sms')) return response(await state.sms());
    if (url.endsWith('/status')) return response(await state.read(url));
    if (url.split('?')[0] === '/api/login/xiaohongshu' || url === '/api/accounts/wechat-oa/mp-login') return response(await state.start(url));
    assert.fail(`Unexpected request ${url}`);
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(AccountsPage, {
    onNavigateAnalysis: () => {}, onAnalysisLogin: () => state.analyzed++,
  })));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); });
  const modal = () => container.querySelector('.account-login-modal');
  const start = async (name = '小红书') => {
    const card = [...container.querySelectorAll('article')].find(item => item.querySelector('h3')?.textContent === name);
    const button = card.querySelector('.account-actions > button');
    await act(async () => { button.focus(); button.click(); });
    return button;
  };
  const click = async text => {
    const button = [...modal().querySelectorAll('button')].find(item => item.textContent === text);
    assert.ok(button, `Missing button ${text}`);
    await act(async () => button.click());
  };
  const tick = async () => {
    assert.equal(timers.size, 1, 'only one status check can be scheduled');
    const [id, callback] = timers.entries().next().value; timers.delete(id);
    await act(async () => { void callback(); });
  };
  return { state, container, modal, start, click, tick, timers };
}

test('initial terminal failure is shown once and never schedules a status retry', async t => {
  const view = await fixture(t);
  const message = '小红书登录页面返回错误，尚未确认具体原因。';
  view.state.start = async () => snapshot('error', message);
  const trigger = await view.start();
  assert.equal(view.modal().textContent.split(message).length - 1, 1);
  assert.doesNotMatch(view.modal().textContent, /换干净|IP|代理/);
  assert.match(view.modal().textContent, /不会自动重试/);
  assert.equal(view.timers.size, 0);
  assert.equal(view.state.requests.filter(item => item.url.endsWith('/status')).length, 0);
  await view.click('关闭');
  assert.equal(view.modal(), null);
  assert.equal(document.activeElement, trigger);
});

test('closing during startup ignores the late error and cannot reopen the window', async t => {
  const view = await fixture(t);
  const first = deferred();
  view.state.start = () => first.promise;
  await view.start();
  assert.match(view.modal().textContent, /启动中/);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(view.modal(), null);
  await act(async () => first.resolve(snapshot('error', 'STALE_START_ERROR')));
  assert.equal(view.modal(), null);
  assert.equal(view.timers.size, 0);
  assert.doesNotMatch(view.container.textContent, /STALE_START_ERROR/);
});

test('an old startup response cannot replace a new attempt or clear its pending state', async t => {
  const view = await fixture(t);
  const first = deferred(), second = deferred();
  let starts = 0;
  view.state.start = () => (++starts === 1 ? first : second).promise;
  await view.start();
  await view.click('关闭');
  await view.start();
  await act(async () => first.resolve(snapshot('error', 'STALE_START_ERROR')));
  assert.match(view.modal().textContent, /启动中/);
  assert.doesNotMatch(view.modal().textContent, /STALE_START_ERROR/);
  assert.match(view.container.querySelector('.account-actions > button').textContent, /正在启动/);
  await act(async () => second.resolve(snapshot('qr_ready', '', '_login/new-attempt.png')));
  assert.match(view.modal().querySelector('img').src, /new-attempt.png/);
  assert.equal(view.timers.size, 1);
});

test('status requests are serial and a late old result cannot overwrite a retried QR', async t => {
  const view = await fixture(t);
  const old = deferred();
  view.state.read = () => old.promise;
  await view.start();
  await view.tick();
  assert.equal(view.timers.size, 0, 'a slow status request must not overlap another poll');
  await view.click('关闭');
  view.state.start = async () => snapshot('qr_ready', '', '_login/new-attempt.png');
  await view.start();
  await act(async () => old.resolve(snapshot('error', 'STALE_POLL_ERROR')));
  assert.match(view.modal().querySelector('img').src, /new-attempt.png/);
  assert.doesNotMatch(view.modal().textContent, /STALE_POLL_ERROR/);
  assert.equal(view.timers.size, 1, 'the old result must not cancel the new timer');
});

test('three consecutive status failures stop with one actionable error', async t => {
  const view = await fixture(t);
  view.state.read = async () => { throw new Error('PRIVATE_TRANSPORT_DETAIL'); };
  await view.start();
  await view.tick(); await view.tick(); await view.tick();
  assert.equal(view.timers.size, 0);
  assert.match(view.modal().textContent, /暂时无法读取登录进度/);
  assert.equal(view.modal().querySelectorAll('[role="alert"]').length, 1);
  assert.doesNotMatch(view.modal().textContent, /PRIVATE_TRANSPORT_DETAIL|IP|代理/);
  await view.click('关闭');
  assert.equal(view.modal(), null);
});

test('a successful status read resets the transient failure count', async t => {
  const view = await fixture(t);
  let reads = 0;
  view.state.read = async () => {
    if (++reads === 2) return snapshot('qr_ready', '', '_login/current.png');
    throw new Error('synthetic transport failure');
  };
  await view.start();
  await view.tick(); await view.tick(); await view.tick(); await view.tick();
  assert.equal(view.timers.size, 1);
  assert.equal(view.modal().querySelector('[role="alert"]'), null);
  await view.tick();
  assert.equal(view.timers.size, 0);
  assert.match(view.modal().textContent, /暂时无法读取登录进度/);
});

test('success in the initial response verifies identity once without polling', async t => {
  const view = await fixture(t);
  view.state.start = async () => snapshot('success', 'synthetic login completed');
  await view.start();
  assert.equal(view.state.whoamiCalls, 1);
  assert.equal(view.state.analyzed, 1);
  assert.equal(view.timers.size, 0);
  assert.match(view.modal().textContent, /登录成功/);
  await view.click('完成');
  assert.equal(view.modal(), null);
});

test('a terminal polling result stops further checks and manual retry starts a fresh attempt', async t => {
  const view = await fixture(t);
  view.state.read = async () => snapshot('expired', '二维码已过期');
  await view.start();
  await view.tick();
  assert.equal(view.timers.size, 0);
  assert.equal(view.modal().querySelector('img'), null);
  await view.click('重新连接');
  assert.match(view.modal().querySelector('img').src, /synthetic-current.png/);
  assert.equal(view.timers.size, 1);
  assert.equal(view.state.requests.filter(item => item.url === '/api/login/xiaohongshu').length, 2);
});

test('WeChat backend retries keep their own endpoint and share terminal polling behavior', async t => {
  const view = await fixture(t);
  view.state.start = async () => snapshot('error', '后台暂不可用');
  await view.start('微信公众号');
  assert.equal(view.timers.size, 0);
  view.state.start = async () => snapshot('qr_ready', '', '_login/mp-current.png');
  await view.click('重新连接');
  assert.match(view.modal().querySelector('img').src, /mp-current.png/);
  assert.deepEqual(view.state.requests.filter(item => item.method === 'POST').map(item => item.url), [
    '/api/accounts/wechat-oa/mp-login', '/api/accounts/wechat-oa/mp-login',
  ]);
  assert.equal(view.timers.size, 1);
});

test('a failed QR flow can open the official browser with an explicit request', async t => {
  const view = await fixture(t);
  view.state.start = async () => snapshot('error', 'synthetic login error');
  await view.start();
  view.state.start = async () => ({ ...snapshot('verifying', '请在小红书窗口完成登录'), visibleBrowser: true });
  await view.click('在浏览器中登录');
  assert.equal(view.state.requests.filter(item => item.method === 'POST').at(-1).url,
    '/api/login/xiaohongshu?visibleBrowser=true');
  assert.match(view.modal().textContent, /工作台所在电脑的小红书窗口/);
  assert.doesNotMatch(view.modal().textContent, /正在验证验证码/);
  assert.equal(view.timers.size, 1);
  view.state.read = async () => ({ ...snapshot('expired', '用户关闭窗口'), visibleBrowser: true });
  await view.tick();
  assert.equal(view.timers.size, 0);
  await view.click('重新连接');
  assert.equal(view.state.requests.filter(item => item.method === 'POST').at(-1).url,
    '/api/login/xiaohongshu?visibleBrowser=true');
});

test('browser login is reachable from the Xiaohongshu card and respects an existing QR flow', async t => {
  const view = await fixture(t);
  const buttons = [...view.container.querySelectorAll('.account-browser-login')];
  assert.equal(buttons.length, 1);
  view.state.start = async () => ({ ...snapshot('verifying'), visibleBrowser: false });
  await act(async () => buttons[0].click());
  assert.equal(view.state.requests.filter(item => item.method === 'POST').at(-1).url,
    '/api/login/xiaohongshu?visibleBrowser=true');
  assert.doesNotMatch(view.modal().textContent, /工作台所在电脑的小红书窗口/);
  await view.click('关闭');
  assert.equal(view.modal(), null);
  assert.equal(view.timers.size, 0);
});
