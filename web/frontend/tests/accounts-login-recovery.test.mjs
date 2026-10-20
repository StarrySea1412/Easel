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
  { platform: 'zhihu', name: '知乎', backend: 'web', supported: true, loggedIn: false },
];

async function fixture(t, { rawCache } = {}) {
  localStorage.clear();
  localStorage.setItem('easel_whoami', JSON.stringify(Object.fromEntries(accounts.map(account => [account.platform, {
    loggedIn: false, name: '', avatar: '', ts: Date.now(),
  }]))));
  if (rawCache !== undefined) localStorage.setItem('easel_whoami', rawCache);
  const timers = new Map();
  let timerId = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { assert.equal(delay, 2000); const id = ++timerId; timers.set(id, callback); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const refreshTimers = new Map();
  t.mock.method(window, 'setInterval', (callback, delay) => { assert.equal(delay, 60000); const id = ++timerId; refreshTimers.set(id, callback); return id; });
  t.mock.method(window, 'clearInterval', id => refreshTimers.delete(id));
  const state = {
    requests: [], start: async () => snapshot('qr_ready', '', '_login/synthetic-current.png'),
    read: async () => snapshot('qr_ready', '', '_login/synthetic-current.png'),
    sms: async () => ({ ok: true }), cancel: async () => ({ cancelled: true, state: 'cancelled' }), analyzed: 0, whoamiCalls: 0,
    accountRows: accounts, whoami: () => ({ loggedIn: true, name: 'Synthetic account', avatar: '' }),
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    state.requests.push({ url, method: options?.method || 'GET' });
    assert.equal(options.cache, 'no-store');
    if (url === '/api/accounts') return response(state.accountRows);
    if (url.endsWith('/whoami') || url.endsWith('/whoami?force=true')) { state.whoamiCalls++; return response(await state.whoami()); }
    if (url.endsWith('/sms')) return response(await state.sms());
    if (url.includes('/cancel?')) return response(await state.cancel(url));
    if (url.endsWith('/status')) return response(await state.read(url));
    if (url.startsWith('/api/login/') || url.startsWith('/api/accounts/wechat-oa/mp-login')) return response(await state.start(url));
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
    const button = card.querySelector('.account-actions > button') || [...card.querySelectorAll('.account-secondary-actions button')].find(item => item.textContent === '重新连接');
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
  return { state, container, modal, start, click, tick, timers, refreshTimers, unmount: () => act(async () => root.unmount()) };
}

for (const rawCache of ['null', JSON.stringify({ zhihu: { loggedIn: true, name: { nickname: 'invalid' }, avatar: '', ts: Date.now() } })]) {
  test('account center opens with malformed stored identities and survives cross-tab cache changes: ' + rawCache.slice(0, 20), async t => {
    const view = await fixture(t, { rawCache });
    assert.match(view.container.textContent, /账号中心/);
    assert.equal(view.container.querySelectorAll('article').length, accounts.length);
    await act(async () => {
      localStorage.setItem('easel_whoami', rawCache);
      window.dispatchEvent(new window.StorageEvent('storage', { key: 'easel_whoami' }));
    });
    assert.match(view.container.textContent, /账号中心/);
    assert.equal(view.container.querySelectorAll('article').length, accounts.length);
    assert.equal(view.modal(), null);
  });
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

test('closing pending startup waits for its ID and cancellation before another platform can start', async t => {
  const view = await fixture(t);
  const first = deferred(), cancelled = deferred();
  let starts = 0;
  view.state.start = () => { starts++; return first.promise; };
  view.state.cancel = () => cancelled.promise;
  await view.start();
  await view.click('关闭');
  await view.start('知乎');
  assert.equal(starts, 1);
  assert.equal(view.modal(), null);
  assert.match(view.container.textContent, /正在结束登录流程/);
  await act(async () => first.resolve({ ...snapshot('qr_ready', '', '_login/old-attempt.png'), attemptId: 'a'.repeat(32) }));
  assert.equal(view.modal(), null);
  assert.equal(view.state.requests.filter(item => item.url.includes('/cancel?')).length, 1);
  assert.equal(view.state.requests.at(-1).url, '/api/login/xiaohongshu/cancel?attemptId=' + 'a'.repeat(32));
  await view.start('知乎');
  assert.equal(starts, 1);
  await act(async () => cancelled.resolve({ cancelled: true, state: 'cancelled' }));
  view.state.start = async () => snapshot('qr_ready', '', '_login/new-attempt.png');
  await view.start('知乎');
  assert.match(view.modal().querySelector('img').src, /new-attempt.png/);
  assert.equal(view.timers.size, 1);
});

test('failed cancellation is retryable and never claims resources have been released', async t => {
  const view = await fixture(t);
  view.state.start = async () => ({ ...snapshot('qr_ready', '', '_login/current.png'), attemptId: 'b'.repeat(32) });
  view.state.cancel = async () => { throw new Error('offline stop failure'); };
  await view.start('知乎');
  await view.click('关闭');
  assert.equal(view.modal(), null);
  assert.match(view.container.querySelector('[role="alert"]').textContent, /尚未确认登录流程已结束/);
  const started = view.state.requests.filter(item => item.url === '/api/login/zhihu').length;
  await view.start('知乎');
  assert.equal(view.state.requests.filter(item => item.url === '/api/login/zhihu').length, started);
  view.state.cancel = async () => ({ cancelled: true, state: 'cancelled' });
  const retry = [...view.container.querySelectorAll('button')].find(button => button.textContent === '重试结束登录');
  await act(async () => retry.click());
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  await view.start('知乎');
  assert.ok(view.modal());
});

test('success closes without cancellation and cancelled status stops polling', async t => {
  const view = await fixture(t);
  view.state.start = async () => ({ ...snapshot('success'), attemptId: 'c'.repeat(32) });
  await view.start('知乎');
  await view.click('完成');
  assert.equal(view.state.requests.filter(item => item.url.includes('/cancel?')).length, 0);
  view.state.start = async () => ({ ...snapshot('qr_ready', '', '_login/current.png'), attemptId: 'd'.repeat(32) });
  await view.start();
  view.state.read = async () => ({ ...snapshot('cancelled', '已取消本次登录'), attemptId: 'd'.repeat(32) });
  await view.tick();
  assert.equal(view.timers.size, 0);
  assert.equal(view.modal().querySelector('img'), null);
  assert.match(view.modal().textContent, /已取消登录/);
});

test('another window replacing the runner never transfers cancellation ownership', async t => {
  const view = await fixture(t);
  view.state.start = async () => ({ ...snapshot('qr_ready', '', '_login/owned.png'), attemptId: 'e'.repeat(32) });
  await view.start('知乎');
  view.state.read = async () => ({ ...snapshot('qr_ready', '', '_login/other.png'), attemptId: 'f'.repeat(32) });
  await view.tick();
  assert.equal(view.timers.size, 0);
  assert.equal(view.modal().querySelector('img'), null);
  assert.match(view.modal().textContent, /已由其他窗口更新/);
  await view.click('关闭');
  assert.match(view.state.requests.find(item => item.url.includes('/cancel?')).url, /attemptId=e{32}$/);
});

test('leaving the account page cancels its owned runner and stops polling', async t => {
  const view = await fixture(t);
  view.state.start = async () => ({ ...snapshot('qr_ready', '', '_login/owned.png'), attemptId: 'a'.repeat(32) });
  await view.start('知乎');
  await view.unmount();
  assert.equal(view.timers.size, 0);
  const cancellations = view.state.requests.filter(item => item.url.includes('/cancel?'));
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].url, '/api/login/zhihu/cancel?attemptId=' + 'a'.repeat(32));
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
  assert.ok(view.modal().querySelector('.account-login-success-icon svg'));
  assert.doesNotMatch(view.modal().textContent, /✅|正在为你自动抓取/);
  await view.click('完成');
  assert.equal(view.modal(), null);
});

test('scan acknowledgement is announced before phone confirmation and success', async t => {
  const view = await fixture(t);
  await view.start();
  assert.match(view.modal().textContent, /等待手机扫码，每2秒/);
  view.state.read = async () => snapshot('scanned', '请在手机确认');
  await view.tick();
  assert.match(view.modal().querySelector('.account-login-status').textContent, /已扫码，等待手机确认/);
  assert.equal(view.modal().querySelector('[aria-current="step"]').textContent, '3确认并保存');
  assert.equal(view.modal().querySelector('img'), null);
  assert.equal(view.timers.size, 1);
  view.state.read = async () => snapshot('success');
  await view.tick();
  assert.ok(view.modal().querySelector('.account-login-success-icon svg'));
  assert.equal(view.timers.size, 0);
});

test('expired positive cache keeps identity during automatic checks and transient failures', async t => {
  const cache = { xiaohongshu: { loggedIn: true, name: '上次确认账号', avatar: '', checkedAt: Date.now() - 180000, ts: Date.now() - 180000 } };
  const view = await fixture(t, { rawCache: JSON.stringify(cache) });
  // Initial automatic check completed. Age it, then observe the next refresh.
  localStorage.setItem('easel_whoami', JSON.stringify(cache));
  await act(async () => window.dispatchEvent(new window.StorageEvent('storage', { key: 'easel_whoami' })));
  const pending = deferred(); view.state.whoami = () => pending.promise;
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  const card = view.container.querySelector('article');
  assert.match(card.querySelector('.account-nick').textContent, /上次确认账号/);
  assert.match(card.textContent, /正在自动检测/);
  assert.doesNotMatch(card.textContent, /连接后，在这里/);
  assert.ok(![...card.querySelectorAll('button')].some(button => button.textContent === '检查登录状态'));
  await act(async () => pending.reject(new Error('synthetic offline')));
  assert.match(card.querySelector('.account-nick').textContent, /上次确认账号/);
  assert.match(card.querySelector('.badge').textContent, /状态待确认/);
  assert.doesNotMatch(card.querySelector('.badge').textContent, /未连接|失效/);
  assert.ok(card.textContent.includes('上次在线确认'));
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
  assert.deepEqual(view.state.requests.filter(item => item.method === 'POST').map(item => item.url), [
    '/api/login/xiaohongshu', '/api/login/xiaohongshu?restart=true',
  ]);
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
    '/api/accounts/wechat-oa/mp-login', '/api/accounts/wechat-oa/mp-login?restart=true',
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
    '/api/login/xiaohongshu?visibleBrowser=true&restart=true');
  assert.match(view.modal().textContent, /工作台所在电脑的小红书窗口/);
  assert.doesNotMatch(view.modal().textContent, /正在验证验证码/);
  assert.equal(view.timers.size, 1);
  view.state.read = async () => ({ ...snapshot('expired', '用户关闭窗口'), visibleBrowser: true });
  await view.tick();
  assert.equal(view.timers.size, 0);
  await view.click('重新连接');
  assert.equal(view.state.requests.filter(item => item.method === 'POST').at(-1).url,
    '/api/login/xiaohongshu?visibleBrowser=true&restart=true');
});

test('browser login is reachable from the Xiaohongshu card and respects an existing QR flow', async t => {
  const view = await fixture(t);
  const buttons = [...view.container.querySelectorAll('.account-browser-login')];
  assert.equal(buttons.length, 1);
  view.state.start = async () => ({ ...snapshot('verifying'), visibleBrowser: false });
  await act(async () => buttons[0].click());
  assert.equal(view.state.requests.filter(item => item.method === 'POST').at(-1).url,
    '/api/login/xiaohongshu?visibleBrowser=true&restart=true');
  assert.doesNotMatch(view.modal().textContent, /工作台所在电脑的小红书窗口/);
  await view.click('关闭');
  assert.equal(view.modal(), null);
  assert.equal(view.timers.size, 0);
});

test('verified QR metadata has a code view, local enlargement and an original-image fallback', async t => {
  const view = await fixture(t);
  view.state.start = async () => ({ ...snapshot('qr_ready', '', '_login/zhihu-code.png'),
    qrKind: 'qr', qrWidth: 220, qrHeight: 220, qrTs: 123 });
  const trigger = await view.start('知乎');
  const image = view.modal().querySelector('img');
  assert.equal(image.alt, '登录二维码');
  assert.ok(view.modal().querySelector('.account-login-image-code'));
  assert.match(image.src, /zhihu-code.png\?v=123$/);
  const original = view.modal().querySelector('.account-login-image-tools a');
  assert.equal(original.href, image.src);
  assert.equal(original.target, '_blank');
  const postsBefore = view.state.requests.filter(item => item.method === 'POST').length;
  await view.click('放大查看');
  assert.equal(image.style.width, '480px');
  assert.ok(view.modal().querySelector('.account-login-image-viewport.is-expanded'));
  assert.equal(view.state.requests.filter(item => item.method === 'POST').length, postsBefore);
  await view.click('恢复大小');
  assert.equal(image.style.width, '');
  const retry = [...view.modal().querySelectorAll('button')].find(item => item.textContent === '重新连接');
  retry.focus();
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
  assert.equal(document.activeElement.textContent, '放大查看');
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(view.modal(), null);
  assert.equal(document.activeElement, trigger);
});

test('a verifying full-page screenshot is labeled as a page and can be inspected without starting another login', async t => {
  const view = await fixture(t);
  view.state.start = async () => ({ ...snapshot('verifying', '等待官方页面确认', '_login/zhihu-page.png'),
    qrKind: 'page', qrWidth: 1360, qrHeight: 768 });
  await view.start('知乎');
  assert.ok(view.modal().querySelector('.account-login-image-page'));
  const image = view.modal().querySelector('img');
  assert.equal(image.alt, '官方登录页面预览');
  assert.doesNotMatch(view.modal().textContent, /用手机 App 扫描下方二维码/);
  assert.match(view.modal().textContent, /如页面未出现二维码，请重新连接/);
  assert.doesNotMatch(view.modal().textContent, /本机官方浏览器/);
  await view.click('放大查看');
  assert.equal(image.style.width, '1360px');
  assert.equal(view.state.requests.filter(item => item.method === 'POST').length, 1);
  assert.equal(view.timers.size, 1);
  view.state.read = async () => ({ ...snapshot('qr_ready', '', '_login/zhihu-code.png'), qrKind: 'qr', qrWidth: 220, qrHeight: 220 });
  await view.tick();
  assert.equal(view.modal().querySelector('img').alt, '登录二维码');
  assert.ok(view.modal().querySelector('.account-login-image-code'));
});

test('legacy full-page responses remain inspectable without pretending they are extracted QR codes', async t => {
  const view = await fixture(t);
  view.state.start = async () => snapshot('qr_ready', '', '_login/legacy-page.png');
  await view.start('知乎');
  const image = view.modal().querySelector('img');
  Object.defineProperty(image, 'naturalWidth', { value: 1440 });
  Object.defineProperty(image, 'naturalHeight', { value: 900 });
  await act(async () => image.dispatchEvent(new window.Event('load')));
  assert.equal(image.alt, '登录图像');
  assert.ok(view.modal().querySelector('.account-login-image-page'));
  await view.click('放大查看');
  assert.equal(image.style.width, '1440px');
  await view.click('重新连接');
  assert.equal(view.state.requests.filter(item => item.method === 'POST').length, 2);
  assert.equal(view.modal().querySelector('.is-expanded'), null);
});

test('failed login images show recovery controls and do not trigger an automatic reconnect', async t => {
  const view = await fixture(t);
  view.state.start = async () => ({ ...snapshot('qr_ready', '', '_login/code.png'), qrKind: 'qr' });
  await view.start();
  await act(async () => view.modal().querySelector('img').dispatchEvent(new window.Event('error')));
  assert.match(view.modal().querySelector('[role="alert"]').textContent, /登录图片加载失败/);
  assert.ok(view.modal().querySelector('.account-login-image-tools a'));
  assert.equal(view.state.requests.filter(item => item.method === 'POST').length, 1);
  await view.click('重新连接');
  assert.equal(view.modal().querySelector('[role="alert"]'), null);
  assert.ok(view.modal().querySelector('img'));
  assert.equal(view.timers.size, 1);
});

test('Xiaohongshu page previews offer an explicit browser login before terminal failure', async t => {
  const view = await fixture(t);
  view.state.start = async () => ({ ...snapshot('verifying', '等待验证', '_login/xhs-page.png'), qrKind: 'page' });
  await view.start();
  assert.equal(view.modal().querySelector('img').alt, '官方登录页面预览');
  assert.equal(view.state.requests.filter(item => item.method === 'POST').length, 1);
  view.state.start = async () => ({ ...snapshot('verifying', '请完成官方登录'), visibleBrowser: true });
  await view.click('在浏览器中登录');
  assert.equal(view.state.requests.filter(item => item.method === 'POST').at(-1).url,
    '/api/login/xiaohongshu?visibleBrowser=true&restart=true');
  assert.equal(view.modal().querySelector('img'), null);
  assert.match(view.modal().textContent, /工作台所在电脑的小红书窗口/);
  assert.equal(view.timers.size, 1);
});

test('visible account page periodically detects expiry and does not count an unverified snapshot as connected', async t => {
  const view = await fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  view.state.accountRows = [{platform:'zhihu',name:'知乎',backend:'web',supported:true,loggedIn:true,hasLocalSession:true}];
  localStorage.setItem('easel_whoami', JSON.stringify({zhihu:{loggedIn:true,verified:true,checkedAt:now,name:'old identity',avatar:''}}));
  view.state.whoami = () => ({loggedIn:false,verified:true,checkedAt:now,name:'',avatar:''});
  now += 121000;
  await act(async () => { for (const refresh of view.refreshTimers.values()) refresh(); });
  assert.equal(view.state.whoamiCalls, 1);
  assert.match(view.container.querySelector('.accounts-summary').textContent, /0 \/ 1 个平台已确认在线/);
  assert.match(view.container.querySelector('article').textContent, /登录已失效/);
  assert.ok([...view.container.querySelectorAll('article button')].some(button => button.textContent === '连接账号'));
  // A stale quick endpoint cannot erase the fresh confirmed offline result.
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  assert.equal(view.state.whoamiCalls, 1);
  assert.equal(JSON.parse(localStorage.getItem('easel_whoami')).zhihu.loggedIn, false);
  await view.unmount();
  assert.equal(view.refreshTimers.size, 0);
});

test('account checking remains unknown on transport failure and periodic checks pause while hidden or logging in', async t => {
  const view = await fixture(t);
  let now = Date.now(); t.mock.method(Date,'now',()=>now);
  view.state.accountRows = [{platform:'zhihu',name:'知乎',backend:'web',supported:true,loggedIn:true,hasLocalSession:true}];
  localStorage.setItem('easel_whoami', JSON.stringify({zhihu:{loggedIn:true,verified:true,checkedAt:now,name:'retained',avatar:''}}));
  view.state.whoami = () => {throw new Error('synthetic offline');};
  now += 121000;
  Object.defineProperty(document, 'visibilityState', {configurable:true,value:'hidden'});
  const before = view.state.requests.length;
  await act(async () => { for (const refresh of view.refreshTimers.values()) refresh(); });
  assert.equal(view.state.requests.length, before);
  Object.defineProperty(document, 'visibilityState', {configurable:true,value:'visible'});
  await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
  assert.match(view.container.querySelector('article .badge').textContent, /状态待确认/);
  assert.match(view.container.querySelector('.accounts-summary').textContent, /0 \/ 1 个平台已确认在线/);
  assert.equal(JSON.parse(localStorage.getItem('easel_whoami')).zhihu.name, 'retained');
  await view.start('知乎');
  const calls = view.state.requests.length;
  await act(async () => { for (const refresh of view.refreshTimers.values()) refresh(); });
  assert.equal(view.state.requests.length, calls);
});
