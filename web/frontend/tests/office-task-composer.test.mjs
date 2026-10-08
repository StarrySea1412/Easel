import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
import { optionValues, selectOption } from './select-helpers.mjs';

// Real composer, shared selectors and capability decoder in a simulated DOM.
// Fetch and submission callbacks are substitutes, not browser/gateway evidence.
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/workbench/index.html' }).window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
const { createRoot } = await import('react-dom/client');
const { default: OfficeTaskComposer } = await loadTsModule('../src/components/agent-office/OfficeTaskComposer.tsx', import.meta.url);

const options = [
  { id: 'relay-a/shared', provider: 'relay-a', model: 'shared', label: '同名模型 A', configured: true },
  { id: 'relay-a/other', provider: 'relay-a', model: 'other', label: '其他模型 A', configured: true },
  { id: 'relay-b/vendor/shared:v2', provider: 'relay-b', model: 'vendor/shared:v2', label: '同名模型 B', configured: true },
  { id: 'missing/model', provider: 'missing', model: 'model', label: '未配置', configured: false },
];
const capability = patch => ({ available: true, scope: 'next_turn', currentModelRef: options[0].id, options, reason: '', ...patch });
const session = (id = 'session-a', patch = {}) => ({ id, title: `会话 ${id}`, messages: [], createdAt: 1, updatedAt: 1, ...patch });
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t, props = {}) {
  const h = { requests: [], submissions: [], stops: [], openedChats: [], openedModels: 0,
    capability: capability(), get: null, submit: () => true };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    h.requests.push({ url, ...init });
    assert.notEqual(init.method, 'POST', 'the composer reads capabilities and delegates execution to App');
    return h.get ? h.get(url, init) : response(h.capability);
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  let current = { session: session(), onSubmit: request => {
    h.submissions.push(structuredClone(request)); return h.submit(request);
  }, onStop: id => h.stops.push(id), onOpenChat: id => h.openedChats.push(id),
  onOpenModels: () => h.openedModels++, ...props };
  const render = async (patch = {}) => {
    current = { ...current, ...patch };
    await act(async () => root.render(createElement(OfficeTaskComposer, current)));
  };
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } };
  t.after(async () => { await unmount(); container.remove(); });
  const button = text => [...container.querySelectorAll('button')].find(item => item.textContent === text);
  const field = label => document.getElementById([...container.querySelectorAll('label')].find(item => item.textContent === label)?.htmlFor);
  return { h, container, render, unmount, button, field,
    textarea: () => container.querySelector('textarea'),
    click: async element => { assert.ok(element, 'expected control exists'); await act(async () => element.click()); },
    async type(value) {
      const input = container.querySelector('textarea');
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    },
    choose: async (label, value) => selectOption(field(label), value),
    async submit() {
      await act(async () => container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    },
    async specific(provider = 'relay-a', model = 'relay-a/shared') {
      await act(async () => button('指定渠道与模型').click());
      await selectOption(field('模型渠道'), provider);
      await selectOption(field('使用模型'), model);
    },
  };
}

test('an explicit channel and nested model reference reach the current session unchanged', async t => {
  const view = await fixture(t); await view.render(); await view.type('  核对材料\n再写结论  ');
  await view.click(view.button('指定渠道与模型'));
  assert.equal(view.button('发送到当前会话').disabled, true, 'a current/default model is not silently preselected');
  assert.deepEqual(await optionValues(view.field('模型渠道')), ['', 'relay-a', 'relay-b']);
  await view.choose('模型渠道', 'relay-b');
  assert.deepEqual(await optionValues(view.field('使用模型')), ['', 'relay-b/vendor/shared:v2']);
  await view.choose('使用模型', 'relay-b/vendor/shared:v2');
  await view.submit();
  assert.deepEqual(view.h.submissions, [{ sessionId: 'session-a', message: '核对材料\n再写结论', modelRef: 'relay-b/vendor/shared:v2' }]);
  assert.equal(view.textarea().value, '');
  assert.ok([...view.container.querySelectorAll('select')].every(select => select.style.display === 'none'
    && select.getAttribute('aria-hidden') === 'true'), 'native compatibility fields stay hidden; visible selectors use the shared popup');
  assert.match(view.container.textContent, /配置登记不代表凭据或实际调用已验证/);
});

test('changing provider clears its model and cannot send the previous or a default route', async t => {
  const view = await fixture(t); await view.render(); await view.type('保留任务'); await view.specific();
  await view.choose('模型渠道', 'relay-b');
  assert.equal(view.field('使用模型').value, '');
  assert.equal(view.button('发送到当前会话').disabled, true);
  await view.submit();
  assert.equal(view.h.submissions.length, 0); assert.equal(view.textarea().value, '保留任务');
  await view.choose('使用模型', 'relay-b/vendor/shared:v2'); await view.submit();
  assert.equal(view.h.submissions[0].modelRef, 'relay-b/vendor/shared:v2');
});

test('refreshing a removed model locks submission and preserves the task until an explicit replacement', async t => {
  const view = await fixture(t); await view.render(); await view.type('模型变化时保留草稿'); await view.specific();
  const pending = deferred(); view.h.get = () => pending.promise;
  await view.click(view.button('刷新模型选项'));
  assert.equal(view.button('发送到当前会话').disabled, true);
  await view.submit(); assert.equal(view.h.submissions.length, 0);
  await act(async () => pending.resolve(response(capability({ options: options.filter(option => option.id !== 'relay-a/shared') }))));
  assert.equal(view.button('发送到当前会话').disabled, true);
  assert.match(view.container.textContent, /原选择不会自动替换/);
  await view.submit(); assert.equal(view.h.submissions.length, 0);
  assert.equal(view.textarea().value, '模型变化时保留草稿');
  await view.choose('使用模型', 'relay-a/other'); await view.submit();
  assert.equal(view.h.submissions[0].modelRef, 'relay-a/other');
});

test('capability failure never falls back to a default unless the user selects that mode', async t => {
  const view = await fixture(t); await view.render(); await view.type('失败也不能换模型'); await view.specific();
  view.h.get = async () => response({ detail: { message: '网关能力核验失败' } }, 503);
  await view.click(view.button('刷新模型选项'));
  assert.match(view.container.textContent, /网关能力核验失败/);
  assert.equal(view.button('发送到当前会话').disabled, true); await view.submit();
  assert.equal(view.h.submissions.length, 0); assert.equal(view.textarea().value, '失败也不能换模型');
  await view.click(view.button('使用会话配置')); await view.submit();
  assert.deepEqual(view.h.submissions, [{ sessionId: 'session-a', message: '失败也不能换模型' }]);
});

for (const scope of ['subsequent_calls', 'future_spawn', 'unknown_scope']) {
  test(`a ${scope} capability cannot authorize a next-turn task selection`, async t => {
    const view = await fixture(t); view.h.capability = capability({ scope });
    await view.render(); await view.type('不能混用能力范围'); await view.click(view.button('指定渠道与模型'));
    assert.equal(view.field('模型渠道').disabled, true);
    assert.equal(view.button('发送到当前会话').disabled, true); await view.submit();
    assert.equal(view.h.submissions.length, 0);
  });
}

test('late capability data from a previous session cannot change the new session draft or route', async t => {
  const view = await fixture(t); await view.render(); await view.type('旧会话草稿'); await view.specific();
  const pending = deferred(); view.h.get = () => pending.promise;
  await view.click(view.button('刷新模型选项'));
  const oldRequest = view.h.requests.at(-1);
  view.h.get = null; view.h.capability = capability({ options: options.filter(option => option.provider === 'relay-b') });
  await view.render({ session: session('session-b') });
  assert.equal(oldRequest.signal.aborted, true); assert.equal(view.textarea().value, '');
  await view.type('只给新会话'); await view.specific('relay-b', 'relay-b/vendor/shared:v2');
  await act(async () => pending.resolve(response(capability({ options: options.filter(option => option.provider === 'relay-a') }))));
  assert.deepEqual(await optionValues(view.field('模型渠道')), ['', 'relay-b']);
  assert.equal(view.textarea().value, '只给新会话');
  await view.submit();
  assert.deepEqual(view.h.submissions, [{ sessionId: 'session-b', message: '只给新会话', modelRef: 'relay-b/vendor/shared:v2' }]);
});

test('switching task target aborts the old lookup and waits for the new target capability', async t => {
  const view = await fixture(t); await view.render(); await view.type('新任务草稿'); await view.specific();
  const old = deferred(), fresh = deferred();
  view.h.get = url => url.includes('?') ? old.promise : fresh.promise;
  await view.click(view.button('刷新模型选项')); const oldRequest = view.h.requests.at(-1);
  await view.click(view.button('新建任务'));
  assert.equal(oldRequest.signal.aborted, true);
  assert.equal(view.h.requests.at(-1).url, '/workbench/api/agent-office/models');
  assert.equal(view.button('开始任务').disabled, true);
  await act(async () => old.resolve(response(capability())));
  assert.equal(view.button('开始任务').disabled, true); await view.submit();
  assert.equal(view.h.submissions.length, 0);
  await act(async () => fresh.resolve(response(capability())));
  await view.submit();
  assert.deepEqual(view.h.submissions, [{ sessionId: null, message: '新任务草稿', modelRef: 'relay-a/shared' }]);
});

test('new task, current continuation and whole-turn stop retain their distinct session targets', async t => {
  const stream = { content: '', thinking: '', activity: '正在执行', requestedModelRef: 'relay-a/shared' };
  const view = await fixture(t, { stream, stopping: true }); await view.render();
  assert.equal(view.textarea().disabled, true);
  assert.equal(view.button('发送到当前会话').disabled, true);
  assert.equal(view.button('等待停止确认…').disabled, true);
  await view.click(view.button('新建任务'));
  assert.equal(view.textarea().disabled, false); await view.type('独立任务');
  await view.submit(); assert.deepEqual(view.h.submissions, [{ sessionId: null, message: '独立任务' }]);
  await view.render({ stopping: false }); await view.click(view.button('停止本轮任务'));
  assert.deepEqual(view.h.stops, ['session-a']);
  await view.click(view.button('打开对话')); await view.click(view.button('管理模型渠道 ↗'));
  assert.deepEqual(view.h.openedChats, ['session-a']); assert.equal(view.h.openedModels, 1);
  assert.match(view.container.textContent, /本轮指定：relay-a\/shared/);
  assert.match(view.container.textContent, /实际执行模型以运行记录为准/);
});

test('an imported backup cannot be continued, while an unresolved current turn cannot be overwritten', async t => {
  const view = await fixture(t, { session: session('backup', { importedFromBackup: true }) }); await view.render();
  assert.equal(view.button('继续当前会话').disabled, true); await view.type('新的可执行任务'); await view.submit();
  assert.deepEqual(view.h.submissions, [{ sessionId: null, message: '新的可执行任务' }]);
  await view.render({ session: session('recovering', { pendingTurnId: 'pending', messages: [{ role: 'user', content: '已提交' }] }) });
  assert.equal(view.button('发送到当前会话').disabled, true); assert.equal(view.textarea().disabled, true);
  assert.match(view.container.textContent, /尚待恢复的任务/);
  await view.submit(); assert.equal(view.h.submissions.length, 1);
});

test('a rejected or throwing submit preserves both draft and explicit route for retry', async t => {
  const view = await fixture(t); await view.render(); await view.type('不能丢失的草稿'); await view.specific();
  view.h.submit = () => false; await view.submit();
  assert.equal(view.textarea().value, '不能丢失的草稿'); assert.equal(view.field('使用模型').value, 'relay-a/shared');
  assert.match(view.container.textContent, /输入已保留/);
  view.h.submit = () => { throw new Error('synthetic dispatch failure'); }; await view.submit();
  assert.equal(view.textarea().value, '不能丢失的草稿'); assert.match(view.container.textContent, /任务提交未完成/);
  view.h.submit = () => true; await view.submit();
  assert.equal(view.textarea().value, '');
  assert.deepEqual(view.h.submissions.map(request => request.modelRef), ['relay-a/shared', 'relay-a/shared', 'relay-a/shared']);
});

test('a failed stop retains the draft and prevents continuation while the stream still runs', async t => {
  const view = await fixture(t); await view.render(); await view.type('停下后继续这段工作'); await view.specific();
  const stream = { content: '', thinking: '', activity: '仍在运行' };
  await view.render({ stream, stopping: true });
  assert.equal(view.textarea().value, '停下后继续这段工作');
  await view.render({ stopping: false, stopError: '网关未确认停止' }); await view.submit();
  assert.equal(view.h.submissions.length, 0); assert.match(view.container.textContent, /网关未确认停止/);
  await view.render({ stream: undefined, stopError: undefined }); await view.submit();
  assert.deepEqual(view.h.submissions, [{ sessionId: 'session-a', message: '停下后继续这段工作', modelRef: 'relay-a/shared' }]);
});

test('two submit events in one batch accept only one task', async t => {
  const view = await fixture(t); await view.render(); await view.type('只提交一次');
  await act(async () => {
    const form = view.container.querySelector('form');
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(view.h.submissions.length, 1);
});

test.after(() => window.close());
