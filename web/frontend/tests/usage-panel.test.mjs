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
    render: async patch => act(async () => root.render(createElement(UsagePanel, { sessionId: 's1', ...props, ...patch }))),
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
  assert.equal(view.container.querySelector('.usage-coverage-track').getAttribute('aria-label'), '2 次模型调用 · 2 次有 Token 记录 · 0 次未上报');
  assert.match(view.text(), /记录费用 · USD/);
  assert.match(view.text(), /未上报/, 'null metrics stay 未上报 instead of 0');
});

test('switching sessions shows skeleton immediately and ignores the old pending response', async t => {
  const view = await fixture(t, { embedded: true });
  assert.ok(view.container.querySelector('.activity-skeleton[aria-busy="true"]'));
  await view.render({sessionId: 's2'});
  assert.ok(view.requests[0].options.signal.aborted);
  await view.respondFirst();
  assert.ok(view.container.querySelector('.activity-skeleton'));
  await act(async () => view.requests[1].resolve(new Response(JSON.stringify(usagePayload('s2')))));
  assert.equal(view.container.querySelector('.activity-skeleton'), null);
  assert.match(view.text(), /240/);
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
  assert.match(view.container.querySelector('.usage-performance-summary').textContent, /渠道估算 · 非账单\$0\.01500000部分合计 · 1\/2 次已计价/);
});

test('empty scopes replace metrics, trends and filters with a truthful empty state and a project shortcut', async t => {
  const payload = usagePayload('s1', { session: summary(0, null), turns: [], turnCount: 0 });
  const view = await fixture(t, { embedded: true }, payload); await view.respondFirst();
  assert.match(view.container.querySelector('.usage-empty-state').textContent, /本次会话暂无用量记录/);
  for (const selector of ['.usage-metrics', '.usage-request-filters', '.usage-turns', '.usage-performance-summary']) assert.equal(view.container.querySelector(selector), null);
  await view.click(view.find('查看整个项目'));
  assert.match(view.text(), /1,200/);
  assert.equal(view.container.querySelector('.usage-empty-state'), null);
});

test('request tabs change visible content, keep complete totals and support arrow-key navigation', async t => {
  const payload = usagePayload('s1'); payload.session.reportedCalls = 1; payload.session.missingCalls = 1;
  const view = await fixture(t, { embedded: true }, payload); await view.respondFirst();
  const requestBrowser = view.container.querySelector('.usage-request-browser');
  assert.equal(requestBrowser.hidden, true);
  assert.equal(view.container.querySelector('.usage-coverage-track > span').style.width, '50%');
  assert.match(view.container.querySelector('.usage-coverage-badge').textContent, /1 次未上报/);
  const overview = [...view.container.querySelectorAll('.usage-view-tabs button')][0];
  await act(async () => { overview.focus(); overview.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); });
  assert.equal(requestBrowser.hidden, false);
  assert.equal(document.activeElement.getAttribute('aria-selected'), 'true');
  assert.match(view.container.querySelector('.usage-coverage').textContent, /2 次调用/);
  await view.click(view.find('消耗总览'));
  assert.equal(requestBrowser.hidden, true);
});

test('a provider-recorded zero fee does not claim the requests were free', async t => {
  const payload = usagePayload('s1'); payload.session.recordedCostUsd = 0;
  const view = await fixture(t, { embedded: true }, payload); await view.respondFirst();
  assert.match(view.container.querySelector('.usage-metrics').textContent, /记录返回 0 · 不代表免费/);
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


test('activity navigation switches scope without nested tabs or another read, preserving request filters', async t => {
  const view = await fixture(t, { embedded: true, activityView: 'overview' });
  await view.respondFirst();
  assert.equal(view.container.querySelector('.usage-metrics.is-simple').children.length, 3);
  assert.equal(view.container.querySelector('.usage-breakdown').open, false);
  assert.equal(view.container.querySelector('.usage-tabs').hidden, true);
  assert.equal(view.container.querySelector('.usage-view-tabs'), null);
  await view.render({ activityView: 'requests' });
  const provider = view.container.querySelector('.usage-request-filters select');
  await act(async () => { provider.value = 'deepseek'; provider.dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.match(view.text(), /1 \/ 2 次/);
  await view.render({ activityView: 'project' });
  assert.match(view.container.querySelector('.usage-metrics.is-full').textContent, /1,200/);
  assert.match(view.text(), /项目会话汇总/);
  await view.render({ activityView: 'requests' });
  assert.equal(view.container.querySelector('.usage-request-filters select').value, 'deepseek');
  assert.equal(view.requests.length, 1, 'navigation reuses the recorded response without extra model/network activity');
});


test('activity opens full project usage without a selected local session and keeps session drill-down explicit', async t => {
  const { default: ActivityPage } = await loadTsModule('../src/components/ActivityPage.tsx', import.meta.url);
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(String(url));
    const id = new URL(String(url), window.location.href).searchParams.get('sessionId') || '';
    return new Response(JSON.stringify(usagePayload(id)), { headers: { 'Content-Type': 'application/json' } });
  });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(createElement(ActivityPage, {sessions:[],activeSessionId:null,streams:{}})));
  assert.equal(new URL(urls[0], window.location.href).searchParams.get('sessionId'), '');
  assert.match(container.querySelector('.activity-project-usage').textContent, /1,200/);
  assert.equal(container.querySelector('.usage-metrics.is-full').children.length, 8);
  assert.equal(container.querySelector('.usage-breakdown'), null, 'full project metrics do not require expansion');
  assert.equal(container.querySelector('.activity-session-picker'), null, 'no local conversation is required for project totals');
});

test('project charts change date and metric without changing cumulative scope or inventing missing costs', async t => {
  const days = Array.from({length:30},(_,i)=>({date:`2026-09-${String(i+1).padStart(2,'0')}`,summary:summary(1,100+i)}));
  const payload = usagePayload('', {dashboard:{days,timezone:'Asia/Shanghai',rangeDays:30,undatedCalls:1,futureCalls:0,recentLimit:20,recent:[{id:'recent',sessionId:'s1',timestamp:'2026-09-30T01:00:00Z',model:'gpt-fixture',provider:'openai',totalTokens:null}],models:[{channelId:'anthropic-1',provider:'anthropic',channelName:'写作渠道',model:'claude-fixture',summary:summary(2,240)}],modelCount:1}});
  const opened=[];
  const view = await fixture(t, {sessionId:'',embedded:true,activityView:'project',onInspectSession:id=>opened.push(id)}, payload);
  await view.respondFirst();
  assert.equal(view.container.querySelectorAll('.usage-day-strip button').length,7);
  assert.equal(view.container.querySelector('[data-provider-brand="claude"]').getAttribute('alt'),'','observed Anthropic provider uses its brand icon');
  assert.match(view.container.querySelector('.usage-chart-card').textContent,/882/);
  await view.click(view.find('近30天'));
  assert.equal(view.container.querySelectorAll('.usage-day-strip button').length,30);
  await view.click(view.find('记录费用'));
  assert.match(view.container.querySelector('.usage-chart-card h3').textContent,/未上报/);
  assert.match(view.container.querySelector('.usage-chart-inspection').textContent,/未上报/);
  assert.equal(view.container.querySelectorAll('.usage-area-chart path').length,0,'unknown fees must not create a zero cost curve');
  const dates=view.container.querySelectorAll('.usage-day-strip button');
  await act(async()=>{dates[29].focus();dates[29].dispatchEvent(new window.KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));});
  assert.equal(document.activeElement,dates[0]);
  assert.match(view.container.querySelector('.usage-chart-inspection').textContent,/2026-09-01/);
  await view.click(view.container.querySelector('.usage-recent-list button'));
  assert.deepEqual(opened,['s1']);
  assert.match(view.container.querySelector('.usage-metrics.is-full').textContent,/1,200/,'trend range never filters the project cumulative cards');
  assert.equal(view.requests.length,1,'chart exploration does not make model or extra HTTP calls');
});

test('small recorded USD fees use their actual scale instead of a one-dollar baseline', async t => {
  const rows=[{date:'2026-10-19',summary:{...summary(1,100),recordedCostUsd:.003}},{date:'2026-10-20',summary:{...summary(1,200),recordedCostUsd:.006}}];
  const payload=usagePayload('',{dashboard:{days:rows,timezone:'Asia/Shanghai',rangeDays:30,undatedCalls:0,futureCalls:0,recentLimit:20,recent:[],models:[],modelCount:0}});
  const view=await fixture(t,{sessionId:'',embedded:true,activityView:'project'},payload);
  await view.respondFirst();await view.click(view.find('记录费用'));
  const axis=view.container.querySelector('.usage-area-chart').textContent;
  assert.match(axis,/\$0\.006/);assert.match(axis,/\$0\.003/);assert.doesNotMatch(axis,/\$1\b/);
});
