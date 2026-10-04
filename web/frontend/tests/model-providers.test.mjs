import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';

const { MODEL_PROVIDERS, decodeObservedModel, officeModelLabel } = await loadTsModule('../src/lib/modelProviders.ts');
const { decodeOfficeSnapshot } = await loadTsModule('../src/lib/agentOffice.ts');

test('registry covers the fourteen review brands and neutral fallback', () => {
  assert.equal(MODEL_PROVIDERS.length, 15);
  assert.equal(new Set(MODEL_PROVIDERS.map(item => item.id)).size, 15);
  assert.equal(MODEL_PROVIDERS.at(-1).id, 'unknown');
});

test('live identity decoder rejects configuration and demo evidence without guessing from channel', () => {
  for (const source of ['configured', 'demo', 'unknown', undefined]) {
    const identity = decodeObservedModel({ provider: 'openai', source, model: 'ep-custom', channel: 'openai-compatible' });
    assert.equal(identity.provider, 'unknown');
    assert.equal(identity.source, 'unknown');
    assert.equal(identity.model, null);
    assert.equal(identity.channel, null);
  }
  const identity = decodeObservedModel({ provider: 'unsupported', source: 'observed', model: 'custom', channel: 'openai', observedAt: '2026-10-02T01:00:00Z' });
  assert.equal(identity.provider, 'unknown');
  assert.match(officeModelLabel(identity), /来源未确认 · custom/);
});

test('observed identity requires a safe model label and a dated execution record', () => {
  const valid = { provider: 'openai', source: 'observed', model: 'gpt-5', observedAt: '2026-10-02T01:00:00Z' };
  for (const invalid of [{ model: null }, { model: 'gpt-5?key=secret' }, { observedAt: null },
    { observedAt: 'invalid' }, { observedAt: '2026-10-02T01:00:00' }]) {
    const identity = decodeObservedModel({ ...valid, ...invalid });
    assert.equal(identity.provider, 'unknown');
    assert.equal(identity.source, 'unknown');
    assert.equal(identity.model, null);
    assert.equal(identity.observedAt, null);
  }
  assert.equal(decodeObservedModel(valid).provider, 'openai');
});

test('snapshot retains actual record identity while child without receipt remains unknown', () => {
  const snapshot = decodeOfficeSnapshot({ sessionId: 's', agents: [
    { id: 'root:s', role: 'root', observedModel: { provider: 'deepseek', model: 'deepseek-chat', channel: 'relay', source: 'observed', observedAt: '2026-10-02T01:00:00Z' } },
    { id: 'child', role: 'subagent', parentId: 'root:s' },
  ] }, 's');
  assert.equal(snapshot.agents[0].observedModel.provider, 'deepseek');
  assert.equal(snapshot.agents[0].observedModel.channel, 'relay');
  assert.equal(snapshot.agents[1].observedModel.provider, 'unknown');
  assert.equal(snapshot.agents[1].observedModel.model, null);
});
