import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'http://localhost/' });
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: SkillDrawer } = await loadTsModule('../src/components/SkillDrawer.tsx', import.meta.url);

test('skill handoff carries input without executing, even with missing API configuration', async t => {
  const requests = [], handoffs = [];
  let accepted = false, closed = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push([url, options?.method || 'GET']);
    return { ok: true, json: async () => ({ name: 'ai-image-gen', needsApi: true, apiConfigured: false, body: '' }) };
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(createElement(SkillDrawer, { skillName: 'ai-image-gen', onOpenChat: (...args) => { handoffs.push(args); return accepted; }, onClose: () => closed++, onConfigured: () => {} })));
  const textarea = container.querySelector('textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, '  一张小猫封面  ');
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const open = [...container.querySelectorAll('button')].find(button => button.textContent.trim() === '进入对话');
  assert.ok(open && !open.disabled);
  await act(async () => open.click());
  assert.equal(closed, 0);
  assert.ok(container.textContent.includes('未能保存对话草稿'));
  accepted = true;
  await act(async () => open.click());
  assert.equal(closed, 1);
  assert.deepEqual(handoffs.at(-1), ['ai-image-gen', '一张小猫封面']);
  assert.ok(requests.every(([, method]) => method === 'GET'));
  assert.equal(container.textContent.includes('执行中'), false);
});
