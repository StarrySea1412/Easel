import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, act } from './accounts-fixture.mjs';

test('saved default account opens its original management dialog from the unified inventory', async t => {
  const now = Date.now();
  const h = await fixture(t, { rawCache: JSON.stringify({ zhihu: {
    loggedIn: true, verified: true, checkedAt: now, ts: now, name: '测试默认知乎', avatar: '',
  } }) });
  const row = h.container.querySelector('[aria-label="查看默认账号 知乎"]');
  assert.ok(row);
  assert.match(row.textContent, /测试默认知乎/);
  await act(async () => row.click());
  const manage = [...h.container.querySelectorAll('button')].find(button => button.textContent === '管理默认账号');
  assert.ok(manage);
  await act(async () => manage.click());
  const dialog = h.container.querySelector('.account-management-dialog');
  assert.equal(dialog.open, true);
  assert.match(dialog.textContent, /管理 知乎/);
  assert.match(dialog.textContent, /测试默认知乎/);
  const privacy = [...h.container.querySelectorAll('button')].find(button => button.textContent === '隐藏账号身份');
  await act(async () => privacy.click());
  assert.doesNotMatch(h.container.textContent, /测试默认知乎/);
  assert.equal(h.state.requests.some(request => request.method !== 'GET'), false);
});
