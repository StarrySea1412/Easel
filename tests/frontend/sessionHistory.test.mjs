import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserModules } from './browser-module.mjs';

function storage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: key => entries.delete(key),
  };
}

function load(initial) {
  const localStorage = storage(initial);
  const sessionStorage = storage({ easel_tab_session: 'original', 'easel_pending_turn:original': 'pending' });
  const context = browserModules({ localStorage, sessionStorage });
  const exports = context.load(new URL('../../web/frontend/src/lib/store.ts', import.meta.url));
  return { exports, localStorage, sessionStorage };
}

test('loading without the obsolete reset marker preserves existing conversation history and recovery', () => {
  const original = [{ id: 'original', messages: [{ role: 'user', content: '历史对话' }], created: 1 }];
  const state = load({ easel_sessions: JSON.stringify(original), easel_active_session: 'original' });
  assert.equal(state.exports.loadSessions()[0].id, original[0].id);
  assert.equal(JSON.stringify(state.exports.loadSessions()[0].messages), JSON.stringify(original[0].messages));
  assert.equal(state.exports.loadActiveId(), 'original');
  assert.equal(state.sessionStorage.getItem('easel_tab_session'), 'original');
  assert.equal(state.sessionStorage.getItem('easel_pending_turn:original'), 'pending');
});

test('legacy conversation history migrates rather than being deleted on first load', () => {
  const original = [{ id: 'original', messages: [{ role: 'user', content: '迁移的历史' }], created: 1 }];
  const previous = ['post', 'craft'].join('');
  const state = load({
    [`${previous}_sessions`]: JSON.stringify(original),
    [`${previous}_active_session`]: 'original',
  });
  assert.equal(state.exports.loadSessions()[0].id, original[0].id);
  assert.equal(JSON.stringify(state.exports.loadSessions()[0].messages), JSON.stringify(original[0].messages));
  assert.equal(state.exports.loadActiveId(), 'original');
  assert.equal(state.localStorage.getItem('easel_sessions'), JSON.stringify(original));
  assert.equal(state.localStorage.getItem(`${previous}_sessions`), null);
});
