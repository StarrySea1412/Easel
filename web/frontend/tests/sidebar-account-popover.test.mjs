import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Component behavior with simulated DOM and controlled HTTP responses. These
// checks do not claim an online platform session or real-browser validation.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: SidebarAccountPopover } = await loadTsModule('../src/components/SidebarAccountPopover.tsx', import.meta.url);
const platforms = ['xiaohongshu', 'kuaishou', 'weixin-channels', 'zhihu', 'bilibili', 'douyin', 'wechat-oa'];
const accounts = connected => platforms.map(platform => ({ platform, loggedIn: platform === connected, note: 'PRIVATE_SESSION_SHOULD_NOT_RENDER' }));
const response = value => ({ ok: true, json: async () => value });

async function fixture(t) {
  localStorage.clear();
  const requests = [];
  const state = { read: async () => response(accounts()), visits: 0 };
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, options }); return state.read(); });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(SidebarAccountPopover, { active: false, onNavigate: () => state.visits++ })));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const trigger = container.querySelector('button');
  return { state, requests, trigger,
    panel: () => document.querySelector('.sidebar-account-popover'),
    open: async () => act(async () => trigger.click()),
    escape: async () => act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))),
  };
}

test('local account snapshots never claim logout without online evidence', async t => {
  const view = await fixture(t);
  assert.deepEqual(view.requests, []);
  await view.open();
  assert.deepEqual(view.requests.map(item => item.url), ['/api/accounts']);
  assert.equal(view.requests[0].options.cache, 'no-store');
  assert.match(view.panel().textContent, /尚无可确认的已登录平台/);
  assert.doesNotMatch(view.panel().textContent, /均未登录|已退出/);
  assert.doesNotMatch(view.panel().textContent, /本地登录快照|在线结论与账号中心共用/);
  assert.equal(view.panel().querySelectorAll('img.sidebar-account-brand').length, 7);
  assert.doesNotMatch(view.panel().textContent, /PRIVATE_SESSION_SHOULD_NOT_RENDER/);
  await act(async () => view.panel().querySelector('.sidebar-account-open').click());
  assert.equal(view.state.visits, 1);
  assert.equal(view.panel(), null);
});

test('reopening clears old success while a fresh snapshot is pending, and failures never reuse it', async t => {
  const view = await fixture(t);
  view.state.read = async () => response(accounts('xiaohongshu'));
  await view.open();
  assert.match(view.panel().querySelector('.account-connection-dot button').title, /连接状态待确认/);
  await view.escape();
  assert.equal(document.activeElement, view.trigger);
  let fail;
  view.state.read = () => new Promise((_, reject) => { fail = reject; });
  await view.open();
  assert.match(view.panel().textContent, /正在读取本次账号快照/);
  assert.doesNotMatch(view.panel().textContent, /1 个平台记录为已登录/);
  await act(async () => fail(new Error('PRIVATE_BACKEND_DETAIL')));
  assert.match(view.panel().textContent, /账号信息暂时无法读取/);
  assert.doesNotMatch(view.panel().textContent, /已登录 · 待校验|PRIVATE_BACKEND_DETAIL/);
  assert.deepEqual(view.requests.map(item => item.url), ['/api/accounts', '/api/accounts']);
});

test('a late response from a closed preview cannot overwrite the new opening', async t => {
  const view = await fixture(t);
  let finishOld;
  view.state.read = () => new Promise(resolve => { finishOld = resolve; });
  await view.open();
  await view.escape();
  view.state.read = async () => response(accounts());
  await view.open();
  await act(async () => finishOld(response(accounts('douyin'))));
  assert.match(view.panel().textContent, /尚无可确认的已登录平台/);
  assert.doesNotMatch(view.panel().textContent, /1 个平台记录为已登录/);
});

test('focus opens the preview, arrow moves into it, and outside pointer dismisses it', async t => {
  const view = await fixture(t);
  await act(async () => view.trigger.focus());
  assert.ok(view.panel());
  await act(async () => view.trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  assert.equal(document.activeElement, view.panel().querySelector('[aria-label="关闭账号预览"]'));
  await act(async () => document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })));
  assert.equal(view.panel(), null);
  assert.equal(document.activeElement, view.trigger);
});

test('mouse hover opens the snapshot and leaving both surfaces dismisses it', async t => {
  const view = await fixture(t);
  await act(async () => view.trigger.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  assert.ok(view.panel());
  assert.equal(view.requests.length, 1);
  await act(async () => {
    view.trigger.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    await new Promise(resolve => setTimeout(resolve, 220));
  });
  assert.equal(view.panel(), null);
});

test('missing platform statuses stay unknown instead of claiming all platforms are logged out', async t => {
  const view = await fixture(t);
  view.state.read = async () => response([]);
  await view.open();
  assert.match(view.panel().textContent, /尚无可确认的已登录平台/);
  assert.doesNotMatch(view.panel().textContent, /7 个平台均未登录/);
  assert.equal(view.panel().querySelectorAll('.account-connection-dot.is-unknown').length, 7);
});

test('open preview shares online and unknown transitions without treating the local snapshot as proof', async t => {
  const { setWhoamiCache, markWhoamiUnverified } = await loadTsModule('../src/lib/whoami.ts');
  const view = await fixture(t);
  await view.open();
  await act(async () => setWhoamiCache('xiaohongshu', {loggedIn:true,verified:true,checkedAt:Date.now(),name:'shared',avatar:''}));
  assert.match(view.panel().textContent, /1 个平台已确认在线/);
  assert.ok(view.panel().querySelector('.account-connection-dot.is-online'));
  assert.equal(view.panel().querySelector('.sidebar-account-name').textContent, 'shared');
  assert.match(view.panel().querySelector('.account-connection-dot button').title, /上次核验/);
  assert.doesNotMatch(view.panel().textContent, /登录状态有效|上次核验/);
  await act(async () => markWhoamiUnverified('xiaohongshu','检查超时'));
  assert.equal(view.panel().querySelector('.sidebar-account-name').textContent, 'shared');
  assert.ok(view.panel().querySelector('.account-connection-dot.is-unknown'));
  assert.doesNotMatch(view.panel().textContent,/已退出|均未登录/);
});

test('opening another sidebar panel closes account hover preview without refocusing it', async t => {
  const view = await fixture(t);
  await view.open(); assert.ok(view.panel());
  await act(async()=>window.dispatchEvent(new window.CustomEvent('easel:sidebar-panel',{detail:'notification-center'})));
  assert.equal(view.panel(),null);
  assert.equal(view.trigger.getAttribute('aria-expanded'),'false');
});

test('workbench login expiry offers login without mislabeling platform sessions or exposing backend details',async t=>{
 const view=await fixture(t);view.state.read=async()=>{throw Object.assign(new Error('PRIVATE_AUTH_DETAIL'),{status:401,code:'workbench_login_required'});};
 await view.open();
 assert.match(view.panel().textContent,/工作台登录已过期/);
 assert.doesNotMatch(view.panel().textContent,/PRIVATE_AUTH_DETAIL|快照读取失败|均未登录/);
 assert.equal(view.panel().querySelector('a').getAttribute('href'),'/login');
 assert.equal(view.panel().querySelector('.sidebar-account-open').textContent.trim(),'重新登录工作台 →');
 assert.equal(view.state.visits,0);
});

test('an ordinary business 401 remains a retryable read failure',async t=>{
 const view=await fixture(t);view.state.read=async()=>({ok:false,status:401,json:async()=>({detail:'PRIVATE_PLATFORM_DETAIL'})});
 await view.open();
 assert.match(view.panel().textContent,/账号信息暂时无法读取，请重试/);
 assert.doesNotMatch(view.panel().textContent,/工作台登录已过期|PRIVATE_PLATFORM_DETAIL/);
 assert.equal(view.panel().querySelector('a'),null);
});

test('a hanging snapshot settles, aborts, and retries successfully without closing the preview',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const view=await fixture(t);let finish;
 view.state.read=()=>new Promise(resolve=>{finish=resolve;});
 await view.open();assert.match(view.panel().textContent,/正在读取本次账号快照/);
 await act(async()=>t.mock.timers.tick(10000));
 assert.match(view.panel().textContent,/账号信息暂时无法读取/);
 assert.equal(view.requests[0].options.signal.aborted,true);
 view.state.read=async()=>response(accounts());
 await act(async()=>[...view.panel().querySelectorAll('button')].find(b=>b.textContent.includes('重新读取')).click());
 assert.equal(view.panel().querySelectorAll('li').length,7);
 await act(async()=>finish(response([])));
 assert.equal(view.panel().querySelectorAll('li').length,7);
 assert.equal(view.requests.length,2);
});
