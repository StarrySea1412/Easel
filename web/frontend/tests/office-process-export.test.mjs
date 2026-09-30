import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';

const { createOfficeRecordExport } = await loadTsModule('../src/components/agent-office/officeProcessExport.ts', import.meta.url);
const agent = { id: 'root:test-session', name: '主 Agent', state: 'done', task: '核对资料', source: 'live', role: '协调', sessionKey: 'PRIVATE_SESSION' };
const event = { id: 'internal-id', operationId: 'a'.repeat(24), agentId: agent.id, kind: 'call', status: 'called', title: '读取文档', toolName: 'read', at: '2026-10-01T09:00:00+08:00', source: 'live', rawArguments: { key: 'PRIVATE_ARGUMENT' }, rawOutput: 'PRIVATE_OUTPUT' };
const input = { agent, turnId: 'turn-a', stale: false, query: 'read', filter: 'all', totalRecords: 4,
  steps: [{ event, result: { ...event, kind: 'result', status: 'returned', title: '已收到回执', at: '2026-10-01T09:00:01+08:00' } }] };

test('office export contains only selected paired visible fields, with explicit scope and no hidden objects', () => {
  const value = createOfficeRecordExport(input);
  assert.equal(value.format, 'easel-office-records');
  assert.equal(value.version, 1);
  assert.equal(value.scope, 'visible_filtered_snapshot');
  assert.equal(value.totalRecords, 4);
  assert.equal(value.exportedRecords, 1);
  assert.equal(value.records[0].event.at, '2026-10-01T01:00:00.000Z');
  assert.equal(value.records[0].result.title, '已收到回执');
  assert.deepEqual(value.filter, { query: 'read', status: 'all' });
  const text = JSON.stringify(value);
  for (const hidden of ['PRIVATE_SESSION', 'PRIVATE_ARGUMENT', 'PRIVATE_OUTPUT', 'internal-id', 'operationId', 'rawArguments']) assert.ok(!text.includes(hidden), hidden);
  assert.match(text, /收到回执不表示成功/);
  assert.equal(value.agent.displayName, agent.name);
  assert.notEqual(value.agent, agent);
  assert.notEqual(value.records[0].event, event);
  assert.equal(input.steps.length, 1);
});

test('demo export cannot borrow live turn or timestamps and preserves simulated provenance', () => {
  const value = createOfficeRecordExport({ ...input, agent: { ...agent, source: 'demo', appearance: { id: 'coordinator', name: '小猫同事' } }, stale: true,
    steps: [{ event: { ...event, source: 'demo', elapsedSeconds: 12.5 } }] });
  assert.equal(value.source, 'demo');
  assert.equal(value.turnId, null);
  assert.equal(value.records[0].event.at, null);
  assert.equal(value.records[0].event.elapsedSeconds, 12.5);
  assert.equal(value.records[0].result, null);
  assert.equal(value.agent.displayName, '小猫同事');
  assert.match(value.limitations.join(' '), /模拟演示记录/);
  assert.match(value.limitations.join(' '), /观测已中断/);
});

test('unmatched and failed records retain their evidence without changing outcome or inventing clocks', () => {
  const value = createOfficeRecordExport({ ...input, filter: 'failed', query: '文件错误',
    steps: [{ event: { ...event, at: 'invalid' }, result: { ...event, at: undefined, kind: 'result', status: 'failed', title: '文件错误' } }] });
  assert.equal(value.records[0].event.at, null);
  assert.equal(value.records[0].result.at, null);
  assert.equal(value.records[0].result.status, 'failed');
  assert.equal(value.filter.status, 'failed');
  const unmatched = createOfficeRecordExport({ ...input, steps: [{ event }], filter: 'unmatched' });
  assert.equal(unmatched.records[0].result, null);
  assert.equal(unmatched.records[0].event.status, 'called');
});

test('missing turn, empty selection and foreign call or receipt identity cannot export', () => {
  for (const patch of [
    { turnId: null }, { steps: [] },
    { steps: [{ event: { ...event, agentId: 'other-agent' } }] },
    { steps: [{ event: { ...event, source: 'demo' } }] },
    { steps: [{ event, result: { ...event, agentId: 'other-agent', kind: 'result' } }] },
  ]) assert.throws(() => createOfficeRecordExport({ ...input, ...patch }));
});
