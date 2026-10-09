import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';

// Real API functions with synthetic HTTP/SSE responses. No gateway or model is
// contacted, and these assertions are not real-browser execution evidence.
globalThis.window = { location: { pathname: '/workbench/index.html' } };
const { streamChat, fetchLastTurn } = await loadTsModule('../src/lib/api.ts', import.meta.url);
const { fetchOfficeTaskModels } = await loadTsModule('../src/lib/officeControls.ts', import.meta.url);
const MODEL = 'relay-b/vendor/shared:v2';
const event = (name, value, id = 0) => `${id ? `id: ${id}\n` : ''}event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const capability = patch => ({ available: true, scope: 'next_turn', currentModelRef: null, reason: null,
  options: [{ id: MODEL, provider: 'relay-b', model: 'vendor/shared:v2', label: '测试模型', configured: true }], ...patch });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function run(t, options = {}) {
  const terminal = deferred();
  const state = { tokens: [], thinking: [], selections: [], interruptions: 0, done: 0, errors: [] };
  const modelRef = Object.hasOwn(options, 'modelRef') ? options.modelRef : MODEL;
  const controller = streamChat(
    '用户原始任务', undefined, 'session-a', chunk => state.tokens.push(chunk),
    sessionKey => { state.done++; terminal.resolve({ kind: 'done', sessionKey }); },
    error => { state.errors.push(error); terminal.resolve({ kind: 'error', error }); },
    chunk => state.thinking.push(chunk), undefined, () => state.interruptions++,
    options.turnId || 'turn-a', options.resumeOnly || false,
    () => terminal.resolve({ kind: 'unavailable' }),
    options.attachments || [], undefined, undefined,
    options.skills || [], options.requirements || {}, modelRef, ref => state.selections.push(ref), options.thinkingLevel,
  );
  t.after(() => controller.abort());
  return { ...state, state, terminal: terminal.promise, controller };
}

test('streamChat sends one exact provider/model field alongside the original task snapshot', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, ...init });
    return new Response(event('model_selection', { requestedModelRef: MODEL }, 1) + event('done', { sessionKey: 'session-a' }, 2));
  });
  const attachments = [{ id: 'fixture-upload', name: 'reference.txt', path: 'fixture/reference.txt' }];
  const result = run(t, { attachments, skills: ['analysis'], requirements: { analysis: '保留来源' } });
  assert.equal((await result.terminal).kind, 'done');
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, '/workbench/api/chat/stream');
  assert.deepEqual(JSON.parse(calls[0].body), { message: '用户原始任务', sessionId: 'session-a', turnId: 'turn-a',
    attachments, selectedSkills: ['analysis'], skillRequirements: { analysis: '保留来源' }, modelRef: MODEL });
  assert.deepEqual(result.state.selections, [MODEL]);
});

test('streamChat includes an explicit thinking level without inventing a reasoning field', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls.push(init);
    return new Response(event('done', {}));
  });
  const result = run(t, { modelRef: undefined, thinkingLevel: 'xhigh' });
  await result.terminal;
  const body = JSON.parse(calls[0].body);
  assert.equal(body.thinkingLevel, 'xhigh');
  assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
});

test('an unspecified route leaves modelRef absent instead of inventing a default choice', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls.push(init); return new Response(event('done', {}));
  });
  const result = run(t, { modelRef: undefined }); await result.terminal;
  assert.equal(Object.hasOwn(JSON.parse(calls[0].body), 'modelRef'), false);
  assert.deepEqual(result.state.selections, []);
});

test('model_selection decodes complete references and null across fragmented SSE while rejecting malformed metadata', async t => {
  const valid = ['relay-a/shared', MODEL, null];
  const invalid = [undefined, '', 'bare-model', '/missing-provider', 'missing-model/', 'relay/a b', true,
    { provider: 'relay-a', model: 'shared' }, `relay/${'x'.repeat(501)}`];
  const text = valid.map((ref, index) => event('model_selection', { requestedModelRef: ref }, index + 1)).join('')
    + invalid.map(ref => event('model_selection', { requestedModelRef: ref })).join('')
    + 'event: model_selection\ndata: {invalid JSON}\n\n'
    + event('model_selection', null) + event('thinking', '公开摘要') + event('token', '回复正文') + event('done', {});
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
    const encoded = new TextEncoder().encode(text);
    for (let offset = 0; offset < encoded.length; offset += 17) controller.enqueue(encoded.slice(offset, offset + 17));
    controller.close();
  } })));
  const result = run(t); await result.terminal;
  assert.deepEqual(result.state.selections, valid);
  assert.deepEqual(result.state.thinking, ['公开摘要']); assert.deepEqual(result.state.tokens, ['回复正文']);
  assert.equal(result.state.errors.length, 0);
});

test('interrupted delivery resumes only the existing job with its last event id and never repeats the POST', { timeout: 5000 }, async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, ...init });
    if (calls.length === 1) return new Response(event('model_selection', { requestedModelRef: MODEL }, 1) + event('token', '前半段', 2));
    return new Response(event('token', '后半段', 3) + event('done', { sessionKey: 'session-a' }, 4));
  });
  const result = run(t); assert.equal((await result.terminal).kind, 'done');
  assert.deepEqual(calls.map(call => call.method || 'GET'), ['POST', 'GET']);
  assert.equal(calls[1].url, '/workbench/api/chat/jobs/turn-a/stream?after=2');
  assert.equal(calls[1].body, undefined); assert.equal(JSON.parse(calls[0].body).modelRef, MODEL);
  assert.deepEqual(result.state.selections, [MODEL]); assert.equal(result.state.tokens.join(''), '前半段后半段');
});

test('an ambiguous initial network failure also reconnects by GET without executing the requested model again', { timeout: 5000 }, async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, ...init });
    if (calls.length === 1) throw new TypeError('synthetic connection closed after request');
    return new Response(event('model_selection', { requestedModelRef: MODEL }, 1) + event('done', {}, 2));
  });
  const result = run(t); await result.terminal;
  assert.deepEqual(calls.map(call => call.method || 'GET'), ['POST', 'GET']);
  assert.equal(calls[1].url, '/workbench/api/chat/jobs/turn-a/stream?after=0');
  assert.equal(calls[1].body, undefined); assert.equal(JSON.parse(calls[0].body).modelRef, MODEL);
});

test('resume-only and missing recovery paths never POST even when a model snapshot is supplied', async t => {
  const calls = []; let missing = false;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, ...init });
    return missing ? new Response('{}', { status: 404 }) : new Response(event('model_selection', { requestedModelRef: MODEL }) + event('done', {}));
  });
  const restored = run(t, { resumeOnly: true, turnId: 'restored:turn' });
  assert.equal((await restored.terminal).kind, 'done'); assert.deepEqual(restored.state.selections, [MODEL]);
  missing = true;
  const unavailable = run(t, { resumeOnly: true, turnId: 'expired-turn' });
  assert.equal((await unavailable.terminal).kind, 'unavailable');
  assert.deepEqual(calls.map(call => call.method || 'GET'), ['GET', 'GET']);
  assert.equal(calls[0].url, '/workbench/api/chat/jobs/restored%3Aturn/stream?after=0');
  assert.ok(calls.every(call => call.body === undefined));
});

for (const [status, code] of [[400, 'chat_model_not_configured'], [503, 'chat_model_override_unavailable']]) {
  test(`${code} is terminal and never retries with the model field omitted`, async t => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push({ url, ...init });
      return new Response(JSON.stringify({ detail: { code, category: 'configuration', retryable: false, message: '所选模型未通过核验' } }), { status });
    });
    const result = run(t); const terminal = await result.terminal;
    assert.equal(terminal.kind, 'error'); assert.equal(terminal.error.detail.code, code);
    assert.equal(terminal.error.detail.retryable, false); assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].body).modelRef, MODEL);
    assert.equal(result.state.done, 0); assert.equal(result.state.interruptions, 0);
  });
}

test('a streamed model failure retains the requested-model event and emits only one terminal callback', async t => {
  let calls = 0, canceled = false;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(event('model_selection', { requestedModelRef: MODEL }, 1)
        + event('error', { code: 'chat_model_override_unavailable', retryable: false, message: '明确拒绝指定模型' }, 2)
        + event('done', {}, 3)));
    }, cancel() { canceled = true; } }));
  });
  const result = run(t); const terminal = await result.terminal;
  assert.equal(terminal.kind, 'error'); assert.deepEqual(result.state.selections, [MODEL]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.state.errors.length, 1); assert.equal(result.state.done, 0);
  assert.equal(calls, 1); assert.equal(canceled, true);
});

test('recovered turn metadata is fetched by GET without resubmitting its model choice', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, ...init });
    return response({ status: 'done', text: '已完成', turn_id: 'old:turn', requestedModelRef: MODEL });
  });
  const saved = await fetchLastTurn('session-a', 'old:turn');
  assert.equal(saved.requestedModelRef, MODEL);
  assert.deepEqual(calls, [{ url: '/workbench/api/chat/last/session-a?turn_id=old%3Aturn', cache: 'no-store' }]);
});

test('task capability transport addresses only the requested session and strips noncontract secrets', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, ...init });
    return response(capability({ apiKey: 'PRIVATE_SECRET', baseUrl: 'https://private.invalid' }));
  });
  const existing = await fetchOfficeTaskModels('session:one', new AbortController().signal);
  await fetchOfficeTaskModels(null, new AbortController().signal);
  assert.equal(existing.available, true); assert.equal(existing.scope, 'next_turn');
  assert.deepEqual(calls.map(call => call.url), ['/workbench/api/agent-office/models?sessionId=session%3Aone', '/workbench/api/agent-office/models']);
  assert.ok(calls.every(call => !call.body && (call.method || 'GET') === 'GET' && call.cache === 'no-store'));
  assert.doesNotMatch(JSON.stringify(existing), /PRIVATE_SECRET|private\.invalid/);
});

test('task catalog rows cannot claim a different channel or model than their exact reference', async t => {
  const valid = capability().options[0];
  t.mock.method(globalThis, 'fetch', async () => response(capability({ options: [valid, { ...valid },
    { ...valid, id: 'other/model' }, { ...valid, id: 'bare-model' },
    { ...valid, id: 'relay-b/unconfigured', model: 'unconfigured', configured: false, apiKey: 'PRIVATE_SECRET' }] })));
  const decoded = await fetchOfficeTaskModels(null, new AbortController().signal);
  assert.deepEqual(decoded.options.map(option => option.id), [MODEL, 'relay-b/unconfigured']);
  assert.equal(decoded.options[1].configured, false); assert.doesNotMatch(JSON.stringify(decoded), /PRIVATE_SECRET/);
});

test('a canceled capability lookup rejects its late success and a pre-aborted lookup does not dispatch', async t => {
  const pending = deferred(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return pending.promise; });
  const controller = new AbortController();
  const request = fetchOfficeTaskModels('session-a', controller.signal);
  const rejected = assert.rejects(request, { name: 'AbortError' });
  controller.abort(); pending.resolve(response(capability())); await rejected;
  await assert.rejects(fetchOfficeTaskModels('session-a', controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('a capability response arriving after timeout cannot restore available model choices', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred(); let transportSignal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => { transportSignal = init.signal; return pending.promise; });
  const request = fetchOfficeTaskModels(null, new AbortController().signal);
  const rejected = assert.rejects(request, /模型能力核验超时/);
  t.mock.timers.tick(15000); assert.equal(transportSignal.aborted, true);
  pending.resolve(response(capability())); await rejected;
});

test('task capability errors and incompatible scopes never masquerade as next-turn permission', async t => {
  let payload = capability({ scope: 'subsequent_calls' }), status = 200;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload), { status }));
  assert.equal((await fetchOfficeTaskModels(null, new AbortController().signal)).available, false);
  payload = capability({ scope: 'future_spawn' });
  assert.equal((await fetchOfficeTaskModels(null, new AbortController().signal)).available, false);
  payload = { detail: { message: '网关版本尚未核验' } }; status = 503;
  await assert.rejects(fetchOfficeTaskModels(null, new AbortController().signal), /网关版本尚未核验/);
});
