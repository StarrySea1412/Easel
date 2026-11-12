import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/', pretendToBeVisual: true }).window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage });
const { createRoot } = await import('react-dom/client');
const { default: Accounts } = await loadTsModule('../src/components/SocialAccountsPanel.tsx');
const { defaultAccountInventory } = await loadTsModule('../src/lib/accountInventory.ts');
const { setWhoamiCache, WHOAMI_TTL_MS } = await loadTsModule('../src/lib/whoami.ts');
const { DistributionEditor } = await loadTsModule('../src/components/SocialDistributionPanel.tsx');
const { PublishReceiptCard } = await loadTsModule('../src/components/PublishReceiptCenter.tsx');

const a = { accountId: 'a'.repeat(32), platform: 'xiaohongshu', label: '品牌号', name: '甲', externalAccountId: 'a'.repeat(24), status: 'ready', checkedAt: new Date().toISOString(), busy: false, attemptId: 'e'.repeat(32), updatedAt: '2026-11-09T00:00:00Z' };
const b = { ...a, accountId: 'b'.repeat(32), platform: 'douyin', label: '视频号乙', externalAccountId: '12345' };
const seed = { title: '通用稿', body: '原正文', media: ['cover.png'], tags: '测试' };
const job = (account, outcome, changes = {}) => ({ jobId: account.accountId, platform: account.platform, accountId: account.accountId, accountLabel: account.label,
  externalAccountId: account.externalAccountId, payload: { ...seed, title: '原确认稿', media: ['video.mp4'] }, state: 'finished', outcome, message: '模拟结果', receiptId: 'f'.repeat(32), ...changes });

async function fixture(t, component = DistributionEditor, props = {}) {
  localStorage.clear();
  const h = { accounts: [structuredClone(a), structuredClone(b)], batches: [], posts: [], events: [], submit: null, creates: [], requests: [] };
  t.mock.method(window, 'confirm', () => true);
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = String(url), body = options.body ? JSON.parse(options.body) : undefined;
    h.requests.push({ path, method: options.method || 'GET' });
    let result;
    if (path === '/api/social-accounts' && options.method === 'POST') {
      h.creates.push(body); result = { ...a, ...body, accountId: 'c'.repeat(32), status: 'logged_out' }; h.accounts.push(result);
    } else if (path === '/api/social-accounts') result = h.accounts;
    else if (path === '/api/social-accounts/batches' && options.method === 'POST') {
      h.posts.push(body);
      result = h.submit ? await h.submit(body) : { batchId: 'd'.repeat(32), state: 'running', createdAt: a.updatedAt, jobs: [] };
    } else if (path === '/api/social-accounts/batches') result = h.batches;
    else if (path.endsWith('/history') || path.endsWith('/default-history')) result = h.events;
    else throw new Error(`Unexpected simulated endpoint: ${path}`);
    return { ok: true, json: async () => structuredClone(result) };
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  h.render = async (extra = {}) => act(async () => { root.render(createElement(component, { seed, files: [], ...props, ...extra })); });
  h.text = () => container.textContent;
  h.find = label => [...container.querySelectorAll('button')].find(button => button.textContent.trim() === label);
  h.click = async label => {
    const button = typeof label === 'string' ? h.find(label) : label;
    assert.ok(button, `Missing button ${label}`);
    await act(async () => { button.click(); });
  };
  h.input = async (element, value) => act(async () => {
    const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  h.container = container;
  h.choose = async account => {
    const platform = container.querySelector(`[data-platform="${account.platform}"]`);
    if(platform.getAttribute('aria-pressed') !== 'true') await h.click(platform);
    await h.click(container.querySelector(`[data-account-id="${account.accountId}"]`));
  };
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await h.render();
  return h;
}

test('account inspector opens the exact selected analysis and publish identity',async t=>{
  const analysis=[],publish=[];
  const h=await fixture(t,Accounts,{initialAccountId:a.accountId,onNavigateAnalysis:(...args)=>analysis.push(args),onNavigatePublish:account=>publish.push(account.accountId)});
  await h.click('分析此账号');await h.click('去发布');
  assert.deepEqual(analysis,[[a.platform,a.accountId]]);assert.deepEqual(publish,[a.accountId]);assert.equal(h.posts.length,0);
});

test('account publish focus preserves existing edited drafts and does not submit',async t=>{
  const focus={accountId:a.accountId,platform:a.platform,nonce:100,workspaceId:'publish'};
  const h=await fixture(t,DistributionEditor,{accountFocus:focus});
  assert.ok(h.container.querySelector(`[data-account-id="${a.accountId}"]`).checked);
  await h.input(h.container.querySelector('textarea'),'甲账号独立正文');
  await h.render({accountFocus:{...focus,accountId:b.accountId,platform:b.platform,nonce:101}});
  await h.render({accountFocus:{...focus,nonce:102}});
  assert.equal(h.container.querySelector('textarea').value,'甲账号独立正文');assert.equal(h.posts.length,0);
});

test('empty account deep link waits for content before freezing the target draft',async t=>{
  const steps=[];const focus={accountId:a.accountId,platform:a.platform,nonce:104,workspaceId:'publish'};
  const h=await fixture(t,DistributionEditor,{step:'content',seed:{title:'',body:'',media:[],tags:''},accountFocus:focus,onStepChange:step=>steps.push(step)});
  assert.equal(localStorage.getItem('easel_social_distribution_v1'),'{}');assert.equal(steps.at(-1),'content');
  await h.render({step:'targets',seed:{...seed,title:'准备后的标题',body:'准备后的正文'}});
  assert.equal(h.container.querySelector(`[data-account-id="${a.accountId}"]`).checked,true);
  const drafts=JSON.parse(localStorage.getItem('easel_social_distribution_v1'));
  assert.equal(drafts[a.accountId].title,'准备后的标题');assert.equal(drafts[a.accountId].body,'准备后的正文');assert.equal(h.posts.length,0);
});

test('unknown accepted request prevents account deep-link from replacing confirmed targets',async t=>{
  const h=await fixture(t);await h.choose(a);
  h.submit=async()=>{throw new Error('network lost');};await h.click('确认发布到 1 个账号');
  const frozen=localStorage.getItem('easel_social_distribution_pending_v1');
  await h.render({accountFocus:{accountId:b.accountId,platform:b.platform,nonce:103,workspaceId:'publish'}});
  assert.equal(localStorage.getItem('easel_social_distribution_pending_v1'),frozen);
  assert.match(h.text(),/先核对本次受理结果/);assert.equal(h.posts.length,1);
});

test('account page offers all seven platforms with a shared keyboard selector', async t => {
  const h = await fixture(t, Accounts);
  await h.click('新增独立账号');
  await h.click(h.container.querySelector('[aria-label="新增账号的平台"]'));
  const options = [...document.querySelectorAll('[role="option"]')];
  assert.equal(options.length, 7);
  await h.click(options.find(option => option.textContent.includes('B站')));
  await h.input(h.container.querySelector('input[placeholder="例如：品牌号 / 主理人号"]'), '第二个B站账号');
  await act(async () => h.container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(h.creates, [{ label: '第二个B站账号', platform: 'bilibili' }]);
  assert.equal(h.container.querySelectorAll('select').length, 0);
});

test('login history displays persistent timestamps and attempt identifiers separately from credentials', async t => {
  const h = await fixture(t, Accounts);
  h.events = [{ id: 1, attemptId: 'e'.repeat(32), action: 'logout', state: 'logged_out', message: '该账号已退出，历史保留', at: a.updatedAt }];
  await h.click(h.container.querySelector('[aria-label="管理 小红书 / 品牌号"]'));
  assert.ok(h.text().includes('该账号已退出，历史保留'));
  assert.equal(h.container.querySelector('time').getAttribute('dateTime'), a.updatedAt);
  assert.ok(h.text().includes('e'.repeat(32)));
  await h.click('默认账号登录记录');
  assert.ok(h.text().includes('默认账号 · 登录记录'));
});

test('account inventory filters platform, status and search without losing other accounts', async t => {
  const h = await fixture(t, Accounts);
  assert.equal(h.container.querySelectorAll('[role="listitem"]').length, 2);
  const rail = h.container.querySelector('[aria-label="按平台筛选账号"]');
  await h.click([...rail.querySelectorAll('button')].find(el => el.textContent.startsWith('抖音')));
  assert.equal(h.container.querySelectorAll('[role="listitem"]').length, 1);
  await h.input(h.container.querySelector('[aria-label="搜索账号"]'), '不存在');
  assert.equal(h.container.querySelectorAll('[role="listitem"]').length, 0);
  await h.click('清除筛选');
  assert.equal(h.container.querySelectorAll('[role="listitem"]').length, 2);
});

test('privacy hides names and platform identity in list and inspector while preserving account labels', async t => {
  const h = await fixture(t, Accounts, {hideIdentity:true});
  await h.click(h.container.querySelector('[aria-label="管理 小红书 / 品牌号"]'));
  assert.ok(h.text().includes('品牌号'));
  assert.ok(h.text().includes('账号身份已隐藏'));
  assert.equal(h.container.querySelectorAll('.account-identity-details dd')[1].textContent, '身份已隐藏');
  assert.ok(!h.text().includes('小红书 · 甲'));
});

const savedZhihu = { platform: 'zhihu', name: '知乎', backend: 'web', supported: true, loggedIn: true,
  hasLocalSession: true, identityKey: 'synthetic-default-zhihu', identity: {
    identityKey: 'synthetic-default-zhihu', loggedIn: true, name: '测试知乎身份', avatar: '',
    verified: false, checkedAt: Date.now() - WHOAMI_TTL_MS * 2,
  } };

test('saved default identity is counted and visible when independent registry is empty', async t => {
  let managed = '';
  const h = await fixture(t, Accounts, { defaultAccounts: [savedZhihu], onManageDefault: platform => { managed = platform; } });
  h.accounts = [];
  await h.click(h.container.querySelector('[aria-label="刷新账号状态"]'));
  assert.deepEqual([...h.container.querySelectorAll('.account-metrics strong')].map(el => el.textContent), ['1', '0', '1']);
  const rail = h.container.querySelector('[aria-label="按平台筛选账号"]');
  await h.click([...rail.querySelectorAll('button')].find(el => el.textContent.startsWith('知乎')));
  assert.match(rail.textContent, /知乎1 个账号/);
  assert.equal(h.container.querySelectorAll('[role="listitem"]').length, 1);
  assert.match(h.text(), /测试知乎身份/);
  assert.match(h.text(), /状态待确认/);
  assert.doesNotMatch(h.text(), /你的下一位创作分身/);
  h.events = [{ id: 1, platform: 'zhihu', action: 'check', at: a.updatedAt, message: '仅知乎记录' },
    { id: 2, platform: 'douyin', action: 'check', at: a.updatedAt, message: '其他平台记录' }];
  await h.click(h.container.querySelector('[aria-label="查看默认账号 知乎"]'));
  assert.match(h.text(), /仅知乎记录/);
  assert.doesNotMatch(h.text(), /其他平台记录/);
  await h.click('管理默认账号');
  assert.equal(managed, 'zhihu');
  assert.ok(h.requests.some(row => row.path.endsWith('/default-history')));
  assert.ok(h.requests.every(row => row.method === 'GET'));
  assert.ok(h.requests.every(row => !row.path.includes('/default:')));
});

test('default and independent identities coexist and filters keep ready scope truthful', async t => {
  const h = await fixture(t, Accounts, { defaultAccounts: [savedZhihu] });
  assert.equal(h.container.querySelectorAll('[role="listitem"]').length, 3);
  assert.deepEqual([...h.container.querySelectorAll('.account-metrics strong')].map(el => el.textContent), ['3', '2', '1']);
  await h.click(h.container.querySelector('[aria-label="筛选账号状态"]'));
  await h.click([...document.querySelectorAll('[role="option"]')].find(el => el.textContent === '可分发'));
  assert.equal(h.container.querySelectorAll('[role="listitem"]').length, 2);
  assert.equal(h.container.querySelector('[aria-label="查看默认账号 知乎"]'), null);
  await h.click(h.container.querySelector('[aria-label="筛选账号状态"]'));
  await h.click([...document.querySelectorAll('[role="option"]')].find(el => el.textContent === '待处理'));
  assert.equal(h.container.querySelectorAll('[role="listitem"]').length, 1);
  await h.input(h.container.querySelector('[aria-label="搜索账号"]'), '测试知乎身份');
  assert.equal(h.container.querySelectorAll('[role="listitem"]').length, 1);
  await h.render({ hideIdentity: true });
  assert.doesNotMatch(h.text(), /测试知乎身份/);
  assert.equal(h.container.querySelectorAll('[role="listitem"]').length, 0, 'hidden identity is not searchable');
  await h.click('清除筛选');
  await h.click(h.container.querySelector('[aria-label="查看默认账号 知乎"]'));
  assert.doesNotMatch(h.text(), /测试知乎身份|synthetic-default-zhihu/);
  assert.match(h.text(), /账号身份已隐藏/);
});

test('default snapshot never proves online, ignores orphan profiles and mismatched identity keys', () => {
  const cache = { ...savedZhihu.identity, ts: Date.now() };
  const rows = [savedZhihu, { ...savedZhihu, platform: 'douyin', loggedIn: false, identity: null }];
  assert.equal(defaultAccountInventory(rows, {}).length, 1, 'an empty profile is not an account');
  assert.equal(defaultAccountInventory([savedZhihu], {}).at(0).connection, 'unknown');
  assert.equal(defaultAccountInventory([savedZhihu], { zhihu: cache }).at(0).connection, 'unknown');
  const proof = { ...cache, verified: true, checkedAt: Date.now() };
  assert.equal(defaultAccountInventory([savedZhihu], { zhihu: proof }).at(0).connection, 'online');
  assert.equal(defaultAccountInventory([savedZhihu], { zhihu: { ...proof, checkedAt: Date.now() - WHOAMI_TTL_MS * 2 } }).at(0).connection, 'unknown');
  const expired = { ...proof, loggedIn: false, authState: 'login_required', name: '' };
  assert.equal(defaultAccountInventory([savedZhihu], { zhihu: expired }).at(0).connection, 'login_required');
  assert.equal(defaultAccountInventory([{ ...savedZhihu, loggedIn: false, hasLocalSession: false }], { zhihu: proof }).length, 1, 'fresh proof wins over a local marker');
  assert.equal(defaultAccountInventory([{ ...savedZhihu, loggedIn: false, hasLocalSession: false }], { zhihu: expired }).length, 0, 'cleared credentials must not resurrect a cached identity');
  assert.equal(defaultAccountInventory([{ ...savedZhihu, loggedIn: false, identityKey: 'replacement' }], { zhihu: proof }).length, 0, 'old identity belongs to another profile');
});

test('live default verification updates the roster without adding a batch target', async t => {
  const h = await fixture(t, Accounts, { defaultAccounts: [savedZhihu] });
  await act(async () => setWhoamiCache('zhihu', { ...savedZhihu.identity, verified: true, checkedAt: Date.now() }));
  assert.match(h.container.querySelector('[aria-label="查看默认账号 知乎"]').textContent, /已确认在线/);
  assert.deepEqual([...h.container.querySelectorAll('.account-metrics strong')].map(el => el.textContent), ['3', '2', '0']);
  await act(async () => setWhoamiCache('zhihu', { ...savedZhihu.identity, loggedIn: false, verified: true, authState: 'login_required', checkedAt: Date.now() }));
  assert.match(h.container.querySelector('[aria-label="查看默认账号 知乎"]').textContent, /需重新登录/);
  assert.deepEqual([...h.container.querySelectorAll('.account-metrics strong')].map(el => el.textContent), ['3', '2', '1']);
  assert.equal(h.posts.length, 0);
});

test('partial loading or failure cannot claim a complete empty inventory', async t => {
  const h = await fixture(t, Accounts, { defaultsLoaded: false });
  h.accounts = [];
  await h.click(h.container.querySelector('[aria-label="刷新账号状态"]'));
  assert.equal(h.container.querySelector('.account-metrics strong').textContent, '—');
  assert.match(h.text(), /正在读取你的账号/);
  assert.doesNotMatch(h.text(), /你的下一位创作分身/);
  await h.render({ defaultLoadError: 'synthetic fetch failed' });
  assert.match(h.text(), /默认账号读取失败/);
  assert.doesNotMatch(h.text(), /正在读取你的账号|你的下一位创作分身/);
});

test('confirmed targets retain separate edited payloads across different platforms', async t => {
  const h = await fixture(t);
  await h.choose(a); await h.choose(b);
  const editors = [...h.container.querySelectorAll('fieldset')];
  await h.input(editors[0].querySelector('input.field'), '品牌专用标题');
  await h.input(editors[1].querySelector('input.field'), '视频专用标题');
  await h.render({ seed: { ...seed, title: '已变化的通用稿' } });
  await h.click('确认发布到 2 个账号');
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.posts[0].requests.map(row => [row.accountId, row.payload.title]), [[a.accountId, '品牌专用标题'], [b.accountId, '视频专用标题']]);
  assert.equal(h.posts[0].confirmed, true);
});

test('lost admission response freezes the payload and reuses the request key', async t => {
  const h = await fixture(t);
  await h.choose(a);
  h.submit = async () => { throw new Error('simulated network loss'); };
  await h.click('确认发布到 1 个账号');
  assert.ok(h.text().includes('上次提交的结果还未确认'));
  assert.equal(h.container.querySelector('fieldset').disabled, true);
  const frozen = structuredClone(h.posts[0]);
  h.submit = async () => ({ batchId: 'd'.repeat(32), createdAt: a.updatedAt, state: 'finished', jobs: [] });
  await h.click('查询本次受理结果');
  assert.deepEqual(h.posts[1], frozen);
  assert.equal(localStorage.getItem('easel_social_distribution_pending_v1'), null);
});

test('publishing reveals only selected platform accounts and keeps one editor visible', async t => {
  const h = await fixture(t);
  assert.equal(h.container.querySelectorAll('[data-account-id]').length, 0);
  await h.choose(a);
  assert.equal(h.container.querySelectorAll('[data-account-id]').length, 1);
  assert.equal(h.container.querySelector('[data-account-id]').getAttribute('data-account-id'), a.accountId);
  await h.choose(b);
  assert.equal(h.container.querySelectorAll('[role="tabpanel"]:not([hidden])').length, 1);
  assert.ok(h.text().includes('已选择 2 个平台 · 2 个账号'));
  const active = h.container.querySelector('[role="tab"][aria-selected="true"]');
  await act(async () => active.dispatchEvent(new window.KeyboardEvent('keydown', {key:'ArrowLeft',bubbles:true})));
  assert.equal(h.container.querySelector('[role="tab"][aria-selected="true"]').id, `distribution-tab-${a.accountId}`);
  await h.click(h.container.querySelector('[data-platform="douyin"]'));
  assert.equal(h.container.querySelectorAll('[data-account-id]').length, 1);
  await h.click('确认发布到 1 个账号');
  assert.deepEqual(h.posts[0].requests.map(row => row.accountId), [a.accountId]);
});

test('deselecting a platform preserves edited content for explicit later reselection', async t => {
  const h = await fixture(t);
  await h.choose(a);
  await h.input(h.container.querySelector('fieldset input.field'), '为品牌号准备的内容');
  await h.click(h.container.querySelector('[data-platform="xiaohongshu"]'));
  assert.equal(h.container.querySelectorAll('[role="tabpanel"]').length, 0);
  await h.choose(a);
  assert.equal(h.container.querySelector('fieldset input.field').value, '为品牌号准备的内容');
});

test('retry submits only the failed account original payload and unknown results have no retry', async t => {
  const h = await fixture(t);
  h.batches = [{ batchId: 'c'.repeat(32), state: 'finished', createdAt: a.updatedAt, jobs: [job(a, 'unverified'), job(b, 'failed')] }];
  await h.click('刷新账号与批次');
  assert.equal([...h.container.querySelectorAll('button')].filter(el => el.textContent.startsWith('仅重试')).length, 1);
  await h.click('仅重试 视频号乙 的原确认稿');
  assert.deepEqual(h.posts[0].requests, [{ accountId: b.accountId, payload: h.batches[0].jobs[1].payload }]);
});

test('account scoped receipts display identity and offer manual verification without automatic default-profile checks', async t => {
  const receipt = { receiptId: 'f'.repeat(32), platform: 'douyin', accountId: b.accountId, accountLabel: b.label,
    externalAccountId: b.externalAccountId, title: '原确认稿', createdAt: a.updatedAt, updatedAt: a.updatedAt,
    state: 'finished', outcome: 'unverified', message: '待核实', verification: { state: 'paused', automatic: false, attempts: 0 } };
  const h = await fixture(t, PublishReceiptCard, { receipt, onCheck: async () => {} });
  assert.ok(h.text().includes('目标账号：视频号乙 · 12345'));
  assert.ok(h.find('核实发布结果'));
  assert.equal(h.find('开启自动核实'), undefined);
});
