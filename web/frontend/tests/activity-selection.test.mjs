import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';

const { selectActivitySessions } = await loadTsModule('../src/lib/activitySelection.ts', import.meta.url);
const sessions = [
  { id: 'saved', title: 'Project notes' },
  { id: 'running', title: 'Campaign draft' },
  { id: 'archived', title: 'Archived campaign', archived: true },
];
const streams = { running: {} };
const defaults = { search: '', filter: 'all', selectedId: 'saved', activeSessionId: 'saved' };
const select = (options = {}, items = sessions, live = streams) => (
  selectActivitySessions(items, live, { ...defaults, ...options })
);

test('no search matches means no detail session, even when the selected and active sessions exist', () => {
  const result = select({ search: 'nothing matches' });
  assert.deepEqual(result.visible, []);
  assert.equal(result.session, undefined);
  assert.equal(result.targetTurnId, undefined);
});

test('running and archived filters only display details from their matching rows', () => {
  for (const filter of ['running', 'archived']) {
    const result = select({ filter });
    assert.deepEqual(result.visible.map((item) => item.id), [filter]);
    assert.equal(result.session.id, filter);
  }
});

test('search is trimmed, case insensitive and combined with status filtering', () => {
  assert.equal(select({ search: ' CAMPAIGN ', filter: 'running' }).session.id, 'running');
  assert.equal(select({ search: 'notes', filter: 'running' }).session, undefined);
});

test('clearing filters restores the preferred selection unless the user explicitly chooses another row', () => {
  const options = { ...defaults, filter: 'running' };
  assert.equal(select(options).session.id, 'running');
  assert.equal(options.selectedId, 'saved');
  assert.equal(select({ ...options, filter: 'all' }).session.id, 'saved');
  assert.equal(select({ ...options, selectedId: 'running', filter: 'all' }).session.id, 'running');
});

test('a deleted selection falls back to the active matching session or the first visible row', () => {
  const remaining = sessions.filter((item) => item.id !== 'saved');
  assert.equal(select({ activeSessionId: 'archived' }, remaining).session.id, 'archived');
  assert.equal(select({ filter: 'running', activeSessionId: 'archived' }, remaining).session.id, 'running');
  assert.equal(select({}, []).session, undefined);
});

test('when the last running session finishes its filtered detail disappears', () => {
  assert.equal(select({ filter: 'running', selectedId: 'running' }).session.id, 'running');
  assert.equal(select({ filter: 'running', selectedId: 'running' }, sessions, {}).session, undefined);
});

test('a targeted turn only reaches its own session, including after filters are cleared', () => {
  const target = { sessionId: 'saved', turnId: 'saved-turn' };
  assert.equal(select({ target }).targetTurnId, 'saved-turn');
  const filtered = select({ target, filter: 'running' });
  assert.equal(filtered.session.id, 'running');
  assert.equal(filtered.targetTurnId, undefined);
  assert.equal(select({ target, search: 'notes' }).targetTurnId, 'saved-turn');
  assert.equal(select({ target, selectedId: 'archived' }).targetTurnId, undefined);
});

test('a missing deep-link target never silently displays another session evidence', () => {
  const target = { sessionId: 'deleted', turnId: 'deleted-turn' };
  const result = select({ target, selectedId: 'deleted' });
  assert.equal(result.missingTarget, true);
  assert.equal(result.session, undefined);
  assert.equal(result.targetTurnId, undefined);
  assert.equal(result.visible.length, sessions.length);
  const explicitSelection = select({ target, selectedId: 'running' });
  assert.equal(explicitSelection.missingTarget, false);
  assert.equal(explicitSelection.session.id, 'running');
  assert.equal(explicitSelection.targetTurnId, undefined);
});
