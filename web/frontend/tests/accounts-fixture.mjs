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
    loggedIn: false, authState: 'not_connected', verified: true, name: '', avatar: '', checkedAt: Date.now(), ts: Date.now(),
  }]))));
  if (rawCache !== undefined) localStorage.setItem('easel_whoami', rawCache);
  const timers = new Map();
  let timerId = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { assert.equal(delay, 2000); const id = ++timerId; timers.set(id, callback); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const refreshTimers = new Map();
  t.mock.method(window, 'setInterval', (callback, delay) => { assert.ok([60000, 600000].includes(delay)); const id = ++timerId; refreshTimers.set(id, callback); return id; });
  t.mock.method(window, 'clearInterval', id => refreshTimers.delete(id));
  const state = {
    requests: [], start: async () => snapshot('qr_ready', '', '_login/synthetic-current.png'),
    read: async () => snapshot('qr_ready', '', '_login/synthetic-current.png'),
    sms: async () => ({ ok: true }), cancel: async () => ({ cancelled: true, state: 'cancelled' }), analyzed: 0, whoamiCalls: 0,
    accountRows: accounts, whoami: () => ({ loggedIn: true, verified: true, checkedAt: Date.now(), name: 'Synthetic account', avatar: '' }),
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

export { fixture, snapshot, response, deferred, accounts, act };
export const {setWhoamiCache, accountConnection} = await loadTsModule('../src/lib/whoami.ts', import.meta.url);
