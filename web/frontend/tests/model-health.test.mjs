import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';
globalThis.window = { location: { pathname: '/' } };

const { fetchModelHealth, probeModel, saveModelHealthSchedules, decodeModelHealth, modelHealthLabel } = await loadTsModule('../src/lib/modelHealth.ts', import.meta.url);
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const snapshot = { results: [{ modelRef: 'relay/model-a', mode: 'text', state: 'success', testedAt: 1720000000, stale: false, detail: '连接成功' }], schedules: [], limit: { requests: 2, windowSeconds: 60, automaticModelsPerProvider: 2 }, staleAfterSeconds: 900, serverTime: 1720000001 };

test('health GET is read-only and decodes only complete model references', async t => {
  const calls = []; t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init }); return response({ ...snapshot, results: [...snapshot.results, { modelRef: 'bare', mode: 'text', state: 'success' }, { modelRef: 'relay/model-a', mode: 'other', state: 'success' }] }); });
  const value = await fetchModelHealth(new AbortController().signal);
  assert.equal(calls[0].init.method, undefined); assert.equal(calls[0].url, '/api/settings/models/health'); assert.deepEqual(value.results.map(item => item.modelRef), ['relay/model-a']); assert.equal(value.schedules.length, 0);
});

test('manual probe and schedule calls send exact bodies; neither is implied by health read', async t => {
  const calls = []; t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init }); return response(snapshot); });
  await probeModel('relay/model-a', 'text', '请只回复：连接成功', new AbortController().signal);
  await saveModelHealthSchedules([{ modelRef: 'relay/model-a', enabled: false, intervalSeconds: 900, prompt: '自定义提示' }], new AbortController().signal);
  assert.deepEqual(calls.map(call => [call.url, call.init.method, JSON.parse(call.init.body)]), [
    ['/api/settings/models/probe', 'POST', { modelRef: 'relay/model-a', mode: 'text', prompt: '请只回复：连接成功' }],
    ['/api/settings/models/health/schedules', 'POST', { schedules: [{ modelRef: 'relay/model-a', enabled: false, intervalSeconds: 900, prompt: '自定义提示' }] }],
  ]);
});

test('invalid snapshot rejects and status labels expose stale/failure without claiming inference', () => {
  assert.throws(() => decodeModelHealth({ results: 'bad' }), /格式无效/);
  assert.equal(modelHealthLabel({ modelRef: 'relay/model-a', mode: 'text', state: 'failed', stale: true }), '失败（已过期）');
  assert.equal(modelHealthLabel(), '未测活');
});

test('an aborted health request never resolves as a successful state', async t => {
  const controller = new AbortController(); let reject; const pending = new Promise((_, done) => { reject = done; });
  t.mock.method(globalThis, 'fetch', async (_url, init) => { init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))); return pending; });
  const request = fetchModelHealth(controller.signal); controller.abort(); await assert.rejects(request, { name: 'AbortError' });
});
