import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'http://127.0.0.1:7880/' });
const seen = await loadTsModule('../src/lib/seenStatus.ts', import.meta.url);
const chat = (id, messages = []) => ({ id, title: id, created: 1, messages });
const answer = (extra = {}) => ({ role: 'assistant', content: '结果', turnId: 'turn-1', ...extra });

test('terminal signatures change with new outcomes and ignore empty chats', () => {
  const first = chat('a', [{ role: 'user', content: 'x' }, answer({ error: { message: '失败一' } })]);
  const second = chat('a', [{ role: 'user', content: 'x' }, answer({ error: { message: '失败一' } }),
    { role: 'user', content: '重试' }, answer({ turnId: 'turn-2', error: { message: '失败二' } })]);
  assert.notEqual(seen.statusSignature(first), seen.statusSignature(second));
  assert.equal(seen.statusSignature(chat('b', [])), '');
});

test('marking seen persists per session and only notifies on change', () => {
  window.localStorage.clear();
  let notified = 0;
  const unsubscribe = seen.subscribeSeenStatuses(() => notified++);
  const session = chat('persist-a', [{ role: 'user', content: 'x' }, answer()]);
  seen.markSessionSeen(session);
  assert.equal(notified, 1);
  assert.equal(seen.isSessionTerminalSeen(session), true);
  seen.markSessionSeen(session);
  assert.equal(notified, 1, 'same signature twice does not write or notify again');
  const stored = JSON.parse(window.localStorage.getItem('easel:seen-session-status'));
  assert.equal(stored['persist-a'], seen.statusSignature(session));
  seen.markSessionSeenById('persist-b', [session, chat('persist-b', [{ role: 'user', content: 'y' }, answer()])]);
  assert.equal(seen.isSessionTerminalSeen(chat('persist-b', [{ role: 'user', content: 'y' }, answer()])), true);
  unsubscribe();
});

test('storage events invalidate the cache and bump the version', () => {
  const before = seen.getSeenStatusVersion();
  window.dispatchEvent(new window.StorageEvent('storage', { key: 'easel:seen-session-status', newValue: null }));
  assert.equal(seen.getSeenStatusVersion(), before + 1);
});
