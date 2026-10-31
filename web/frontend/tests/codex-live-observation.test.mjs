import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.CustomEvent = window.CustomEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Panel } = await loadTsModule('../src/components/CodexRunPanel.tsx', import.meta.url);

async function fixture(t) {
  const timers = new Map(), calls = [], notified = [];
  let counter = 0;
  const h = { current: { sessionId: 's', turn_id: 't', status: 'done', outcome: 'unconfirmed',
    text: 'partial', items: [], pending: [], thinkingStatus: 'unavailable' } };
  t.mock.method(globalThis, 'setInterval', callback => { const id = ++counter; timers.set(id, callback); return id; });
  t.mock.method(globalThis, 'clearInterval', id => timers.delete(id));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options]);
    if (String(url).endsWith('/api/codex/reconcile')) {
      h.current = { ...h.current, status: 'running', outcome: 'running', recovery: { status: 'observing' } };
    } else if (String(url).endsWith('/api/codex/stop')) {
      h.current = { ...h.current, status: 'done', outcome: 'interrupted', recovery: { status: 'adopted' } };
      return { ok: true, json: async () => ({ stopped: true }) };
    }
    const data = String(url).includes('/api/codex/') ? h.current
      : { sessionId: 's', turnId: 't', operations: [], plan: [], timeline: [], warnings: [] };
    return { ok: true, json: async () => data };
  });
  const listener = event => notified.push(event.detail);
  window.addEventListener('easel:codex-recovered', listener);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Panel, { sessionId: 's', turnId: 't', streaming: false })));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); window.removeEventListener('easel:codex-recovered', listener); });
  return { h, calls, timers, container, notified,
    button: text => [...container.querySelectorAll('button')].find(button => button.textContent === text),
    async poll() { await act(async () => { for (const callback of [...timers.values()]) await callback(); }); },
  };
}

test('rejoined native turn keeps polling when the old web stream has ended, then adopts the original result', async t => {
  const view = await fixture(t);
  await act(async () => view.button('核对结果').click());
  assert.ok(view.timers.size > 0, 'a resumed run must keep observing without the old SSE stream');
  assert.ok(view.container.textContent.includes('已接回原轮次'));
  view.h.current = { ...view.h.current, status: 'done', outcome: 'completed', recovery: { status: 'adopted' } };
  await view.poll();
  assert.deepEqual(view.notified, [{ sessionId: 's', turnId: 't' }]);
  assert.ok(!view.button('停止原轮次'));
});

test('the rejoined run offers precise stop without enabling automatic approvals', async t => {
  const view = await fixture(t);
  await act(async () => view.button('核对结果').click());
  const stop = view.button('停止原轮次');
  assert.ok(stop);
  await act(async () => stop.click());
  const request = view.calls.find(([url]) => String(url).endsWith('/api/codex/stop'));
  assert.deepEqual(JSON.parse(request[1].body), { sessionId: 's', turnId: 't' });
  assert.equal(request[1].method, 'POST');
  assert.ok(view.container.textContent.includes('已停止'));
  assert.ok(!view.calls.some(([url]) => String(url).endsWith('/api/codex/answer')));
});
