import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserModules } from './browser-module.mjs';
const settle = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  const entries = new Map();
  const pending = [];
  const context = browserModules({
    localStorage: {
      getItem: key => entries.get(key) ?? null,
      setItem: (key, value) => entries.set(key, String(value)),
    },
  });
  const api = context.load(new URL('../../web/frontend/src/lib/api.ts', import.meta.url));
  api.accountWhoami = platform => new Promise(resolve => pending.push({ platform, resolve }));
  const exports = context.load(new URL('../../web/frontend/src/lib/whoami.ts', import.meta.url));
  return { exports, pending, entries };
}

test('legacy identities remain display-only until a real account check confirms them', async () => {
  const view = setup();
  view.entries.set('easel_whoami', JSON.stringify({
    xiaohongshu: { loggedIn: true, name: 'Wrong feed author', avatar: '', ts: Date.now() },
  }));
  view.entries.set('easel_whoami_v2', view.entries.get('easel_whoami'));
  view.entries.set('easel_whoami_v3', view.entries.get('easel_whoami'));
  const legacy = view.exports.getWhoamiCache().xiaohongshu;
  assert.equal(legacy.name, 'Wrong feed author');
  assert.equal(view.exports.isWhoamiFresh(legacy), false);
  assert.equal(view.exports.accountConnection({loggedIn:true}, legacy), 'unknown');
  view.exports.verifyStale(['xiaohongshu']);
  assert.equal(view.pending.length, 1);
  view.pending[0].resolve({ loggedIn: true, verified: true, checkedAt: Date.now(), name: 'Me', avatar: '' });
  await settle();
  view.exports.setWhoamiCache('xiaohongshu', { loggedIn: true, name: 'Me', avatar: '' });
  assert.equal(JSON.parse(view.entries.get('easel_whoami')).xiaohongshu.name, 'Me');
});
test('a verification started before login cannot overwrite the new login cache', async () => {
  const view = setup();
  const updates = [];
  view.exports.verifyStale(['xiaohongshu'], { onUpdate: (...args) => updates.push(args) });
  view.exports.setWhoamiCache('xiaohongshu', { loggedIn: true, name: '已登录', avatar: '' });
  view.pending[0].resolve({ loggedIn: false, name: '', avatar: '' });
  await settle();
  assert.equal(view.exports.getWhoamiCache().xiaohongshu.loggedIn, true);
  assert.equal(updates.length, 0);
});

test('invalidating login cache discards a previously running background verification', async () => {
  const view = setup();
  const updates = [];
  view.exports.verifyStale(['xiaohongshu'], { onUpdate: (...args) => updates.push(args) });
  view.exports.setWhoamiCache('xiaohongshu', null);
  view.pending[0].resolve({ loggedIn: false, name: '', avatar: '' });
  await settle();
  assert.equal(view.exports.getWhoamiCache().xiaohongshu, undefined);
  assert.equal(updates.length, 0);
});

test('fresh verification still updates and caches the actual account result', async () => {
  const view = setup();
  const updates = [];
  view.exports.verifyStale(['xiaohongshu'], { onUpdate: (...args) => updates.push(args) });
  view.pending[0].resolve({ loggedIn: true, verified: true, checkedAt: Date.now(), name: '账号', avatar: '' });
  await settle();
  assert.equal(view.exports.getWhoamiCache().xiaohongshu.loggedIn, true);
  assert.equal(updates.length, 1);
});

test('verified accounts share the ten minute TTL even when display details are incomplete', async () => {
  const view = setup();
  view.entries.set('easel_whoami', JSON.stringify({
    xiaohongshu: { loggedIn: true, verified: true, name: '', avatar: '', checkedAt: Date.now() - 61_000, ts: Date.now() },
    zhihu: { loggedIn: true, verified: true, name: 'Me', avatar: 'https://self.test/avatar', checkedAt: Date.now() - 61_000, ts: Date.now() },
  }));
  await view.exports.verifyStale(['xiaohongshu', 'zhihu']);
  assert.equal(view.pending.length, 0);
  const cache = JSON.parse(view.entries.get('easel_whoami'));
  cache.xiaohongshu.checkedAt = Date.now() - 601_000;
  view.entries.set('easel_whoami', JSON.stringify(cache));
  view.exports.verifyStale(['xiaohongshu', 'zhihu']);
  assert.equal(view.pending.length, 1);
  assert.equal(view.pending[0].platform, 'xiaohongshu');
  view.pending[0].resolve({ loggedIn: true, verified: true, checkedAt: Date.now(), name: '', avatar: '' });
  await settle();
});
