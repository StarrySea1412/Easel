import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Panel } = await loadTsModule('../src/components/PlatformAnalysisPanel.tsx', import.meta.url);
const platforms = [
  { platform: 'douyin', name: '抖音', loggedIn: true, identity: 'douyin:a' },
  { platform: 'kuaishou', name: '快手', loggedIn: true, identity: 'kuaishou:b' },
  { platform: 'zhihu', name: '知乎', loggedIn: false, identity: 'zhihu:c' },
];
const response = (platform, title = `${platform} 作品`) => ({
  ok: true, json: async () => ({ platform, loggedIn: true, nickname: `${platform} 账号`, analysis: {
    source: { label: `${platform} 来源`, url: `https://${platform}.test/` }, fetchedAt: 1, period: '累计',
    overview: [{ key: 'followers', label: '粉丝', value: platform === 'douyin' ? 10 : 20 }], metrics: [],
    coverage: { numericMetrics: 1, notes: 1 }, missingFields: [], suggestions: [], limitations: [],
    notes: [{ title, url: '', metrics: [], missingFields: [], stat: '', publish: '' }],
  } }),
});
async function fixture(t, fetcher) {
  t.mock.method(globalThis, 'fetch', fetcher);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const state = { platform: 'douyin', accounts: platforms, revision: 0 };
  const render = () => root.render(createElement(Panel, { ...state, showPlatformPicker: false, onPlatformChange: platform => { state.platform = platform; render(); } }));
  await act(async () => render());
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return { container, state, render };
}
test('initial connected platform loads and a platform switch automatically replaces its data', async t => {
  const requests = [];
  const v = await fixture(t, async url => { const platform = url.split('/').at(-1); requests.push(platform); return response(platform); });
  assert.match(v.container.textContent, /douyin 作品/);
  await act(async () => { v.state.platform = 'kuaishou'; v.render(); });
  assert.deepEqual(requests, ['douyin', 'kuaishou']);
  assert.match(v.container.textContent, /kuaishou 作品/);
  assert.doesNotMatch(v.container.textContent, /douyin 作品/);
});
test('a delayed previous platform response cannot replace the newly selected platform', async t => {
  let finish;
  const requests = [];
  const v = await fixture(t, async url => { const platform = url.split('/').at(-1); requests.push(platform); return platform === 'douyin' ? new Promise(resolve => { finish = resolve; }) : response(platform); });
  await act(async () => { v.state.platform = 'kuaishou'; v.render(); });
  await act(async () => finish(response('douyin', '旧平台晚到作品')));
  assert.deepEqual(requests, ['douyin', 'kuaishou']);
  assert.match(v.container.textContent, /kuaishou 作品/);
  assert.doesNotMatch(v.container.textContent, /旧平台晚到作品/);
});
test('a disconnected platform clears the old result without starting collection', async t => {
  const requests = [];
  const v = await fixture(t, async url => { const platform = url.split('/').at(-1); requests.push(platform); return response(platform); });
  await act(async () => { v.state.platform = 'zhihu'; v.render(); });
  assert.deepEqual(requests, ['douyin']);
  assert.match(v.container.textContent, /登录知乎/);
  assert.doesNotMatch(v.container.textContent, /douyin 作品/);
});
test('an account identity revision clears data and reloads that platform', async t => {
  let count = 0;
  const v = await fixture(t, async () => response('douyin', `账号作品 ${++count}`));
  await act(async () => { v.state.accounts = platforms.map(p => p.platform === 'douyin' ? { ...p, identity: 'douyin:new' } : p); v.render(); });
  assert.equal(count, 2);
  assert.match(v.container.textContent, /账号作品 2/);
  assert.doesNotMatch(v.container.textContent, /账号作品 1/);
});
