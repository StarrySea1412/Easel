import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, snapshot, deferred, act, setWhoamiCache, accountConnection } from '../../web/frontend/tests/accounts-fixture.mjs';

const cached = platform => JSON.parse(localStorage.getItem('easel_whoami'))[platform];
const card = (view, name) => [...view.container.querySelectorAll('article')].find(item => item.querySelector('h3')?.textContent === name);

test('a failed old avatar does not prevent a newly verified avatar from rendering', async t => {
  const view = await fixture(t);
  const proof = {loggedIn:true,verified:true,checkedAt:Date.now(),name:'Me',avatar:'https://self.test/old'};
  await act(async () => setWhoamiCache('zhihu', proof));
  const account = card(view, '知乎');
  const image = account.querySelector('img.account-avatar');
  assert.equal(image.src, proof.avatar);
  await act(async () => image.dispatchEvent(new window.Event('error')));
  assert.ok(account.querySelector('.account-avatar-fallback'));
  await act(async () => setWhoamiCache('zhihu', {...proof,avatar:'https://self.test/current'}));
  assert.equal(account.querySelector('img.account-avatar').src, 'https://self.test/current');
});

test('a current account check updates the card and identity from the same result', async t => {
  const view = await fixture(t);
  await act(async () => setWhoamiCache('zhihu', {loggedIn:true,verified:true,checkedAt:Date.now()-700000,name:'Old identity',avatar:''}));
  view.state.whoami = () => ({loggedIn:false,verified:true,authState:'login_required',checkedAt:Date.now(),name:'',avatar:''});
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  assert.equal(accountConnection(undefined,cached('zhihu')), 'login_required');
  assert.equal(cached('zhihu').loggedIn, false);
  assert.equal(card(view,'知乎').querySelector('.account-nick'), null);
  assert.match(view.container.textContent, /0 \/ 3 个平台已确认在线/);
});

test('failed account verification preserves the last nickname and avatar as unknown', async t => {
  const view = await fixture(t);
  const identity = {loggedIn:true,verified:true,checkedAt:Date.now()-700000,name:'Own account',avatar:'https://self.test/channel.png'};
  await act(async () => setWhoamiCache('zhihu',identity));
  view.state.whoami = () => {throw new Error('identity endpoint not ready');};
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  assert.equal(card(view,'知乎').querySelector('.account-nick').textContent, identity.name);
  assert.equal(card(view,'知乎').querySelector('img.account-avatar').src, identity.avatar);
  assert.equal(accountConnection(undefined,cached('zhihu')), 'unknown');
});

for (const [flow, name, endpoint] of [['account','知乎','/api/login/zhihu'], ['mp','微信公众号','/api/accounts/wechat-oa/mp-login']]) {
  test(`${flow} serializes polling and never overwrites terminal success`, async t => {
    const view = await fixture(t);
    const pending = deferred();
    view.state.read = () => pending.promise;
    await view.start(name);
    await view.tick();
    assert.equal(view.timers.size, 0, 'no parallel status request is scheduled while the first is pending');
    assert.equal(view.state.requests.filter(item => item.url.endsWith('/status')).length, 1);
    await act(async () => pending.resolve(snapshot('success')));
    assert.equal(view.timers.size, 0);
    assert.equal(view.state.whoamiCalls, 1);
    assert.match(view.modal().querySelector('.account-login-status').textContent, /登录成功/);
  });

  test(`${flow} surfaces persistent polling failures instead of spinning forever`, async t => {
    const view = await fixture(t);
    view.state.read = async () => {throw new Error('network');};
    await view.start(name);
    await view.tick(); await view.tick(); await view.tick();
    assert.equal(view.timers.size, 0);
    assert.match(view.modal().textContent, /暂时无法读取登录进度/);
    assert.equal(view.modal().querySelector('img'), null);
  });

  test(`${flow} opens the login modal before its start request resolves`, async t => {
    const view = await fixture(t);
    const pending = deferred(); view.state.start = () => pending.promise;
    await view.start(name);
    assert.match(view.modal().textContent, /启动中/);
    assert.equal(view.timers.size, 0);
    assert.equal(view.state.requests.at(-1).url, endpoint);
    await act(async () => pending.resolve(snapshot('starting')));
    await view.tick();
    assert.match(view.modal().querySelector('img').src, /synthetic-current.png/);
  });

  test(`${flow} keeps a closed modal closed when its start response arrives`, async t => {
    const view = await fixture(t);
    const pending = deferred(); view.state.start = () => pending.promise;
    await view.start(name); await view.click('关闭');
    await act(async () => pending.resolve({...snapshot('qr_ready','','_login/old.png'),attemptId:'a'.repeat(32)}));
    assert.equal(view.modal(), null);
    assert.equal(view.timers.size, 0);
    assert.equal(view.state.requests.filter(item => item.url.includes('/cancel?')).length, 1);
  });

  test(`${flow} shows startup failures inside the open modal`, async t => {
    const view = await fixture(t);
    view.state.start = async () => {throw new Error('启动失败');};
    await view.start(name);
    assert.match(view.modal().textContent, /启动失败/);
    assert.equal(view.timers.size, 0);
  });

  test(`${flow} discards polling responses from a previous login`, async t => {
    const view = await fixture(t);
    const pending = deferred(); view.state.read = () => pending.promise;
    await view.start(name); await view.tick();
    await view.click('关闭');
    await view.start('小红书');
    await act(async () => pending.resolve(snapshot('success','OLD_RESULT')));
    assert.match(view.modal().querySelector('h3').textContent, /小红书/);
    assert.doesNotMatch(view.modal().textContent, /OLD_RESULT/);
    assert.equal(view.state.whoamiCalls, 0);
    assert.equal(view.timers.size, 1);
  });
}
