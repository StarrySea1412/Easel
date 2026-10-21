import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window = new Window({ url: 'https://easel.test' }); globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Settings } = await loadTsModule('../src/components/ChatMessageSettings.tsx', import.meta.url);
async function fixture(t, props = {}) {
  const calls = []; const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const actions = { targets: [{ value: 'side-1', label: '侧边对话 · 素材' }, { value: 'new-side', label: '新建侧边对话' }], hasGoal: false, goalBlocked: false, quote: (...args) => calls.push(['quote', ...args]), goal: (...args) => calls.push(['goal', ...args]), ...props };
  await act(async () => root.render(createElement(Settings, { text: '选中的完整消息', actions })));
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const button = text => [...document.querySelectorAll('button')].find(b => b.textContent === text);
  await act(async () => host.querySelector('button').click());
  return { calls, button, click: async text => act(async () => button(text).click()), dialog: () => document.querySelector('[role=dialog]') };
}
test('message settings quotes exact text to a selected side chat without sending it', async t => {
  const v = await fixture(t);
  await act(async () => document.querySelector('[role=combobox]').click());
  await act(async () => document.querySelector('[role=option][data-value=side-1]').click());
  await v.click('引用到输入框'); assert.deepEqual(v.calls, [['quote', '选中的完整消息', 'side-1']]); assert.equal(v.dialog(), null);
});
test('message settings can create a side chat, with current chat as safe default', async t => {
  const v = await fixture(t);
  assert.equal(document.querySelector('[role=combobox]').textContent, '当前对话');
  await act(async () => document.querySelector('[role=combobox]').click());
  await act(async () => document.querySelector('[role=option][data-value=new-side]').click());
  await v.click('引用到输入框'); assert.deepEqual(v.calls[0], ['quote', '选中的完整消息', 'new-side']);
});
for (const [hasGoal, label, mode] of [[false, '新增目标', 'new'], [true, '追加到当前目标', 'append'], [true, '替换当前目标', 'replace']]) {
  test(`goal action ${mode} opens editing and preserves the requested mode`, async t => {
    const v = await fixture(t, { hasGoal }); await v.click(label); assert.deepEqual(v.calls, [['goal', '选中的完整消息', mode]]);
  });
}
test('live goals cannot be overwritten and Escape cancels without side effects', async t => {
  const v = await fixture(t, { hasGoal: true, goalBlocked: true });
  assert.equal(v.button('替换当前目标').disabled, true); assert.match(v.dialog().textContent, /请先暂停/);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(v.dialog(), null); assert.deepEqual(v.calls, []);
});

for (const [kind,label] of [['image','送到生图工坊'],['publish','送到发布中心']]) {
  test('message selection opens '+kind+' with exact material and no send',async t=>{
    const transfers=[];
    const v=await fixture(t,{creation:(...args)=>transfers.push(args)});
    await v.click(label);
    assert.deepEqual(transfers,[['选中的完整消息',kind]]);
    assert.deepEqual(v.calls,[]);assert.equal(v.dialog(),null);
  });
}
