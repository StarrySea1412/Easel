import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';
const { describeOfficeAction } = await loadTsModule('../src/lib/officeActions.ts', import.meta.url);
const worker = { id: 'child', state: 'working', source: 'live' };
const call = { id: 'one', agentId: 'child', source: 'live', kind: 'call', operationId: 'op-one', toolName: 'read' };
test('specific live gestures require the employee own unmatched operation', () => {
  assert.equal(describeOfficeAction(worker, []).kind, 'unreported');
  assert.equal(describeOfficeAction(worker, [{ ...call, agentId: 'parent' }]).kind, 'unreported');
  assert.equal(describeOfficeAction(worker, [call]).kind, 'reading');
  assert.equal(describeOfficeAction(worker, [call, { ...call, id: 'two', kind: 'result' }]).kind, 'unreported');
  assert.equal(describeOfficeAction(worker, [call, { ...call, id: 'two', kind: 'result', operationId: 'other' }]).kind, 'reading');
});
test('returned failures end tool gestures without promoting the whole run to failure', () => {
  const result = { ...call, id: 'two', kind: 'result', status: 'failed' };
  assert.equal(describeOfficeAction(worker, [call, result]).kind, 'unreported');
  for (const [state, kind] of [['done','completed'],['error','error'],['stopped','stopped']]) {
    assert.equal(describeOfficeAction({ ...worker, state }, [call]).kind, kind);
  }
});
test('demo actions are explicitly synthetic and live prose never selects a gesture', () => {
  assert.equal(describeOfficeAction({ ...worker, id: 'designer', source: 'demo' }, []).kind, 'designing');
  assert.equal(describeOfficeAction({ ...worker, task: 'design image', role: 'designer' }, []).kind, 'unreported');
});
