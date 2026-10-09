import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// UsagePanel against controlled HTTP: honest "未上报" placeholders, session vs
// project scopes, provider/model filters and pagination are the risky paths.
globalThis.window = new Window({ url: 'https://easel.test/usage' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: UsagePanel } = await loadTsModule('../src/components/UsagePanel.tsx', import.meta.url);

const metric = (total, input, output, cost = null) => ({
  totalTokens: total, inputTokens: input, outputTokens: output, cacheReadTokens: null,
  cacheWriteTokens: null, reasoningTokens: null, recordedCostUsd: cost,
});
const coverage = (n) => ({ totalTokens: n, inputTokens: n, outputTokens: n, cacheReadTokens: n, cacheWriteTokens: n, reasoningTokens: n, recordedCostUsd: n });
const call = (id, model, provider, patch = {}) => ({
  id, model, provider, timestamp: '2026-10-04T12:00:00Z',
  ...metric(100, 60, 40), ...patch,
});
const summary = (calls, total) => ({
  ...metric(total, null, null), calls, reportedCalls: calls, missingCalls: 0, coverage: coverage(calls),
});

function usagePayload(sessionId, extra = {}) {
  return {
    sessionId, session: summary(2, 240), project: summary(5, 1200),
    turns: [{
      id: 'turn-1', number: 1, timestamp: '2026-10-04T11:00:00Z', unattributed: false,
      summary: summary(2, 240), calls: [call('c1', 'deepseek-chat', 'deepseek'), call('c2', 'qwen-max', 'dashscope')],
    }],
    turnCount: 1, offset: 0, limit: 30, sessionCount: 2, sourceCount: 1, updatedAt: 1790800000,
    sessions: [{ sessionId, summary: summary(2, 240), lastAt: '2026-10-04T12:00:00Z' }],
    scope: '本地会话记录', note: '说明', costNote: '费用口径', issues: [],
    ...extra,
  };
}

async function fixture(t, props = {}, payload = usagePayload('s1')) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', (url, options = {}) => new Promise((resolve, reject) => {
    requests.push({ url, options, resolve, reject });
  }));
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(UsagePanel, { sessionId: 's1', ...props })));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return {
    container, requests,
    text: () => container.textContent || '',
    click: async element => act(async () => element.click()),
    find: text => [...container.querySelectorAll('button')].find(b => (b.textContent || '').includes(text)),
    async respondFirst() {
      const request = requests[0];
      await act(async () => request.resolve(new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })));
    },
  };
}

test('embedded panel renders honest placeholders and call counts', async t => {
  const view = await fixture(t, { embedded: true });
  await view.respondFirst();
  assert.match(view.text(), /总 Token/);
  assert.match(view.text(), /240/);
  assert.match(view.text(), /2 次模型调用 · 2 次有 Token 记录 · 0 次未上报/);
  assert.match(view.text(), /记录费用 · USD/);
  assert.match(view.text(), /未上报/, 'null metrics stay 未上报 instead of 0');
});

test('project scope switches to the session summary table', async t => {
  const view = await fixture(t, { embedded: true });
  await view.respondFirst();
  await view.click(view.find('整个项目'));
  assert.match(view.text(), /项目会话汇总/);
  assert.match(view.text(), /5 次模型调用|1,200/);
  assert.doesNotMatch(view.text(), /轮次用量分布/, 'session trend hides in project scope');
});

test('provider filter narrows the request browser and clears cleanly', async t => {
  const view = await fixture(t, { embedded: true });
  await view.respondFirst();
  assert.match(view.text(), /2 \/ 2 次/);
  const providerSelect = view.container.querySelector('.usage-request-filters select');
  await act(async () => {
    providerSelect.value = 'deepseek';
    providerSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  assert.match(view.text(), /1 \/ 2 次/);
  await view.click(view.find('清除筛选'));
  assert.match(view.text(), /2 \/ 2 次/);
});

test('failed usage fetch surfaces the error without inventing numbers', async t => {
  const view = await fixture(t, { embedded: true });
  await act(async () => view.requests[0].reject(new Error('读取失败')));
  assert.match(view.text(), /读取失败/);
  assert.doesNotMatch(view.text(), /\b0 次模型调用\b/);
});

test('request details separate recorded and estimated costs, stream and estimated speed', async t => {
  const payload = usagePayload('s1');
  payload.turns[0].calls[0] = call('c1', 'sample', 'fixture', {
    durationMs: 8000, firstTokenMs: 2000, outputTokensPerSecond: 50, speedSource: 'stream', estimatedCostUsd: .015,
    costBreakdown: { pricing: { source: 'fixture quote', multiplier: '1.5' }, freshInputTokens: 40, partsUsd: { input: '.001' } },
  });
  payload.turns[0].calls[1] = call('c2', 'unknown', 'fixture', { durationMs: 15000, firstTokenMs: null, outputTokensPerSecond: 20, speedSource: 'estimated' });
  const view = await fixture(t, { embedded: true }, payload); await view.respondFirst();
  assert.match(view.text(), /50.00 tok\/s/);
  assert.match(view.text(), /估算速度（含等待）/);
  assert.match(view.text(), /fixture quote/);
  assert.match(view.text(), /价格或用量不完整/);
  assert.equal(view.requests.length, 1, 'collapsed pricing controls make no reads');
});

test('partially priced summaries identify coverage rather than implying a complete cost', async t => {
  const payload = usagePayload('s1');
  payload.session.estimatedCostUsd = .015;
  payload.session.coverage.estimatedCostUsd = 1;
  const view = await fixture(t, { embedded: true }, payload); await view.respondFirst();
  assert.match(view.container.querySelector('.usage-performance-summary').textContent, /渠道估算 \$0\.01500000 · 部分合计 · 1\/2 次已计价（非账单）/);
});

test('channel endpoint and grouping distinguish the same model across two routes', async t => {
  const payload = usagePayload('s1');
  payload.turns[0].calls = [call('one','same','relay',{channelId:'ch_one',channelName:'relay',channelEndpoint:'a.example'}),call('two','same','relay',{channelId:'ch_two',channelName:'relay',channelEndpoint:'b.example'})];
  payload.channels = { session: [{id:'ch_one',name:'relay',endpoint:'a.example',source:'turn_config',models:['same'],summary:summary(1,100)},{id:'ch_two',name:'relay',endpoint:'b.example',source:'turn_config',models:['same'],summary:summary(1,100)}], project:[] };
  const view=await fixture(t,{embedded:true},payload);await view.respondFirst();
  assert.match(view.text(),/按消耗渠道汇总/);assert.match(view.text(),/a.example/);assert.match(view.text(),/b.example/);
  const filter=view.container.querySelector('.usage-request-filters select');
  await act(async()=>{filter.value='ch_two';filter.dispatchEvent(new window.Event('change',{bubbles:true}));});
  assert.match(view.text(),/1 \/ 2 次/);
  assert.match(view.container.querySelector('.usage-request-list').textContent,/b.example/);
  assert.doesNotMatch(view.container.querySelector('.usage-request-list').textContent,/a.example/);
});
