import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadTsModule } from './load-ts.mjs';

// 持久化往返：辅助对话归属、分享 token 与接管标记必须在刷新后存活（decodeSessions 白名单回归）。
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
const { saveSessions, loadSessions } = await loadTsModule('../src/lib/store.ts', import.meta.url);

test('child sessions, share tokens and appended markers survive a storage round trip', () => {
  const parent = { id: 'p1', title: '主对话', created: 1, messages: [{ role: 'user', content: '问' }, { role: 'assistant', content: '答' }] };
  const child = { id: 'c1', title: '辅助对话', created: 2, messages: [], parentSessionId: 'p1' };
  const shared = { ...parent, id: 'p2', title: '分享过的对话', created: 3,
    share: { token: 'Tok_' + 'A'.repeat(24), title: '分享过的对话', createdAt: 100 },
    loadedShareAppends: ['ap-1'],
    messages: [...parent.messages, { role: 'assistant', content: '接管产出', shareAppend: { token: 'Tok_' + 'A'.repeat(24), appendId: 'ap-1', at: 101, source: { model: 'glm-5.3', harness: 'ZCode' } } }] };
  assert.equal(saveSessions([shared, child, parent]), true);
  const loaded = loadSessions();
  const byId = Object.fromEntries(loaded.map(session => [session.id, session]));
  assert.equal(byId.c1.parentSessionId, 'p1', 'child sessions keep their parent after reload');
  assert.equal(byId.p2.share?.token, shared.share.token, 'the share token survives reload');
  assert.deepEqual(byId.p2.loadedShareAppends, ['ap-1']);
  const appended = byId.p2.messages.at(-1);
  assert.equal(appended.shareAppend?.appendId, 'ap-1', 'the appended marker survives reload');
  assert.equal(appended.shareAppend?.source.model, 'glm-5.3');
  assert.equal(byId.p1.share, undefined);
});
