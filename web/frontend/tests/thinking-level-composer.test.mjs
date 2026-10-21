import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { act, createElement, StrictMode } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Real Composer and browser storage contract in a simulated DOM. Keyboard
// default behavior is checked here; actual Tab movement/layout need browser QA.
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
const { createRoot } = await import('react-dom/client');
const { default: Composer } = await loadTsModule('../src/components/ChatComposer.tsx', import.meta.url);
const { THINKING_LEVELS, resolveThinkingPreference } = await loadTsModule('../src/lib/thinkingLevel.ts', import.meta.url);
const KEY = 'easel_thinking_preference';
let sequence = 0;

test('slash goal opens in current conversation and preserves the command until saved without sending a model message',async t=>{
  const view=await fixture(t,'low');const opened=[];
  await view.render({onGoal:(...args)=>opened.push(args)});
  assert.equal(view.container.querySelector('.composer-goal-btn'),null,'a conversation without a goal shows no goal chip');
  await view.type('/');assert.match(document.querySelector('[role=listbox]').textContent,/设置要持续追求的目标/);
  assert.match(document.querySelector('[role=listbox]').textContent,/定时任务/);
  await view.key(view.container.querySelector('textarea'),'Enter');
  assert.equal(view.sent.length,0);assert.equal(opened.length,1);assert.equal(opened[0][0],'');
  assert.equal(view.container.querySelector('textarea').value,'');
  await view.type('/goal 完成原对话的卡片');await view.key(view.container.querySelector('textarea'),'Enter');
  assert.equal(opened[1][0],'完成原对话的卡片');assert.equal(view.sent.length,0);
});

test('goal lifecycle commands pause, resume and clear without sending model messages',async t=>{
  const view=await fixture(t,'low');const actions=[];
  await view.render({onGoal:()=>{},goalStatus:'active',onGoalAction:action=>actions.push(action)});
  assert.equal(view.container.querySelector('.composer-goal-btn')?.getAttribute('aria-label'),'设置或查看目标','a conversation with a goal keeps its chip');
  await view.type('/goal pause');await view.key(view.container.querySelector('textarea'),'Enter');
  assert.deepEqual(actions,['pause']);assert.equal(view.sent.length,0);
  assert.equal(view.container.querySelector('textarea').value,'');
  await view.type('/goal 继续');await view.key(view.container.querySelector('textarea'),'Enter');
  assert.deepEqual(actions,['pause','resume']);
  await view.type('/目标 清除');await view.key(view.container.querySelector('textarea'),'Enter');
  assert.deepEqual(actions,['pause','resume','clear']);
  assert.equal(view.sent.length,0);
});

test('slash menu lists lifecycle commands by goal status and selects them with the keyboard',async t=>{
  const view=await fixture(t,'low');const actions=[],viewed=[];
  await view.render({onGoal:()=>{},goalStatus:'paused',onGoalAction:action=>actions.push(action),onGoalView:()=>viewed.push(1)});
  await view.type('/');
  const menu=document.querySelector('[role=listbox]');
  assert.match(menu.textContent,/继续目标/);assert.match(menu.textContent,/清除目标/);
  assert.doesNotMatch(menu.textContent,/暂停目标/);
  assert.match(menu.querySelector('[role=option][aria-selected=true]').textContent,/目标/);
  await view.key(view.container.querySelector('textarea'),'ArrowDown');
  assert.match(document.querySelector('[role=option][aria-selected=true]').textContent,/继续目标/);
  await view.key(view.container.querySelector('textarea'),'Enter');
  assert.deepEqual(actions,['resume']);assert.deepEqual(viewed,[]);
  await view.type('/');await view.key(view.container.querySelector('textarea'),'Enter');
  assert.deepEqual(viewed,[1]);assert.deepEqual(actions,['resume']);
  await view.type('/');await view.key(view.container.querySelector('textarea'),'ArrowDown');
  await view.key(view.container.querySelector('textarea'),'ArrowDown');
  await view.key(view.container.querySelector('textarea'),'Enter');
  assert.deepEqual(actions,['resume','clear']);
  assert.equal(view.sent.length,0);
});

test('slash schedule command seeds the plan draft and opens the automation entry',async t=>{
  const view=await fixture(t,'low');const drafts=[];
  await view.render({onGoal:()=>{},onScheduleDraft:text=>drafts.push(text)});
  await view.type('/定时 每周一整理热点');await view.key(view.container.querySelector('textarea'),'Enter');
  assert.deepEqual(drafts,['每周一整理热点']);assert.equal(view.sent.length,0);
  await view.type('/');await view.key(view.container.querySelector('textarea'),'ArrowUp');
  await view.key(view.container.querySelector('textarea'),'Enter');
  assert.deepEqual(drafts,['每周一整理热点','']);
  assert.equal(view.sent.length,0);
});

test('embedded goal keeps the ordinary composer tools and toggles back to the saved draft', async t => {
  const view = await fixture(t, 'low', { selectedModel: { id: 'fixture/model', provider: 'fixture', model: 'model', configured: true } });
  let closed = 0;
  await view.render();
  await view.type('普通草稿必须完整保留');
  const originalInput=view.container.querySelector('textarea'),originalComposer=view.container.querySelector('.chat-composer');
  await view.render({
    goalEditor: { seed: '完成原对话中的卡片', modelRef: 'fixture/model' },
    onGoal: () => {},
    onGoalClose: () => { closed++; },
  });
  assert.ok(view.container.querySelector('.chat-composer'));
  assert.ok(view.container.querySelector('[aria-label="对话引擎"]'));
  assert.ok(view.container.querySelector('[aria-label="添加素材或技能"]'));
  assert.ok(view.container.querySelector('[aria-label="选择模型"], [aria-label="模型设置"]'));
  assert.ok(view.container.querySelector('[aria-label="要持续追求的目标"]'));
  assert.equal(view.container.querySelector('textarea'),originalInput);
  assert.equal(view.container.querySelector('.chat-composer'),originalComposer);
  assert.ok(view.container.querySelector('[aria-label="开始目标"]'));
  assert.ok(view.container.querySelector('.thinking-level-trigger'));
  assert.equal(view.container.querySelector('.chat-goal-settings'), null, 'goal mode carries no settings form');
  assert.match(view.container.textContent, /输入的内容就是目标/);
  assert.equal(view.container.querySelector('form'),null);
  assert.equal(view.container.querySelector('[aria-label="创作消息"]'), null);
  const toggle = view.container.querySelector('.composer-goal-btn');
  assert.equal(toggle.getAttribute('aria-label'), '退出目标设置');
  await view.click(toggle);
  assert.equal(closed, 1);
  await view.render({goalEditor:null});
  assert.equal(view.container.querySelector('textarea'),originalInput);
  assert.equal(originalInput.value,'普通草稿必须完整保留');
  assert.equal(view.sent.length,0);
});

test('goal keyboard keeps IME and Shift+Enter, exits with Escape and submits only the goal on Enter',async t=>{
  const view=await fixture(t,'low',{selectedModel:{id:'fixture/model',provider:'fixture',model:'model',configured:true}});
  await view.render();await view.type('原消息');let closed=0;
  await view.render({goalEditor:{seed:'检查中文排版'},onGoal:()=>{},onGoalClose:()=>closed++});
  const input=view.container.querySelector('textarea');
  for(const options of [{isComposing:true},{shiftKey:true}])assert.equal((await view.key(input,'Enter',options)).defaultPrevented,false);
  assert.equal(view.sent.length,0);
  const writes=[];t.mock.method(globalThis,'fetch',async(url,options={})=>{
    if(options.method==='POST'){writes.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({id:'goal-keyboard'})};}
    return {ok:true,json:async()=>({})};
  });
  assert.equal((await view.key(input,'Enter')).defaultPrevented,true);
  assert.equal(writes.length,2);assert.equal(writes[0].body.goal.objective,'检查中文排版');
  assert.equal(writes[0].body.goal.modelRef,'fixture/model');assert.equal(writes[1].body.action,'start');
  assert.equal(view.sent.length,0);assert.equal(closed,1);
  await view.render({goalEditor:null});assert.equal(input.value,'原消息');
  await view.render({goalEditor:{seed:'取消的新目标'}});
  await view.key(input,'Escape');assert.equal(closed,2);assert.equal(writes.length,2);
});

test('goal mode retains stop and prevents starting while an ordinary run is streaming',async t=>{
  const view=await fixture(t,'low',{selectedModel:{id:'fixture/model',provider:'fixture',model:'model',configured:true}});
  let stopped=0;await view.render({isStreaming:true,onStop:()=>stopped++,goalEditor:{seed:'后续目标'},onGoal:()=>{}});
  assert.equal(view.container.querySelector('[aria-label="开始目标"]').disabled,true);
  await view.click(view.container.querySelector('[aria-label="停止生成"]'));
  assert.equal(stopped,1);assert.equal(view.sent.length,0);
});

test('Escape dismisses slash menu, regular draft and goal busy state never lose text',async t=>{
  const view=await fixture(t,'low');await view.render({goalBusy:true,onGoal:()=>{}});
  await view.type('/g');await view.key(view.container.querySelector('textarea'),'Escape');
  assert.equal(document.querySelector('[role=listbox]'),null);assert.equal(view.container.querySelector('textarea').value,'/g');
  await view.type('保留我在目标运行中写下的内容');await view.key(view.container.querySelector('textarea'),'Enter');
  assert.equal(view.sent.length,0);assert.equal(view.container.querySelector('textarea').value,'保留我在目标运行中写下的内容');
  assert.match(view.container.textContent,/先暂停目标/);
});

test('only Ultra enables the highlighted theme and particles, and leaving Ultra removes them', async t => {
  const view = await fixture(t, 'high'); await view.render(); await view.click(view.trigger());
  assert.equal(view.container.querySelector('.is-ultra'), null);
  assert.equal(document.querySelector('.thinking-level-particles'), null);
  await view.choose('ultra');
  assert.ok(document.querySelector('.thinking-level-picker.is-ultra'));
  assert.equal(document.querySelectorAll('.thinking-level-particles i').length, 9);
  await view.choose('max');
  assert.equal(view.container.querySelector('.is-ultra'), null);
  assert.equal(document.querySelector('.thinking-level-particles'), null);
});

async function fixture(t, preference, { strict = false, selectedModel, otherModel } = {}) {
  const values = new Map(preference === undefined ? [] : [[KEY, preference]]);
  const capabilityModel = selectedModel === null ? null : selectedModel || {id:'fixture/all',provider:'fixture',model:'all',configured:true,thinkingLevels:[...THINKING_LEVELS]};
  if (selectedModel) values.set('easel_chat_model_ref', selectedModel.id);
  const storage = { values, writes: [], blocked: false, failWrite: false,
    getItem(key) { if (this.blocked) throw new Error('denied'); return values.get(key) ?? null; },
    setItem(key, value) { if (this.failWrite) throw new Error('full'); this.writes.push([key, value]); values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, json: async () => url === '/api/upload/limits' ? { max_mb: 50 }
    : String(url).includes('/agent-office/models') ? { available: true, scope: 'next_turn', options: capabilityModel ? [capabilityModel, ...(otherModel ? [otherModel] : [])] : [], defaultModelRef: capabilityModel?.id } : [] }));
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container), sent = [];
  let sessionId = `thinking-composer-${++sequence}`, busy = {};
  const render = async (patch = {}) => {
    busy = { ...busy, ...patch };
    const node = createElement(Composer, { sessionId, isStreaming: false, ...busy, onStop: busy.onStop || (() => {}), onSend: (...args) => { sent.push(args); return true; } });
    await act(async () => root.render(strict ? createElement(StrictMode, null, node) : node));
  };
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const click = async element => { assert.ok(element); await act(async () => element.click()); };
  const key = async (element, value, options = {}) => {
    assert.ok(element); const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
    await act(async () => element.dispatchEvent(event)); return event;
  };
  return { container, storage, sent, render, click, key,
    trigger: () => document.querySelector('.thinking-level-trigger'),
    menu: () => document.querySelector('.thinking-level-menu[role=dialog]'),
    slider: () => document.querySelector('input[type=range][aria-label="思考强度"]'),
    async choose(level, element = this.slider()) { await act(async () => {
      if (level === 'auto') { document.querySelector('.thinking-level-auto').click(); return; }
      if (level === 'adaptive') { document.querySelector('.thinking-level-adaptive').click(); return; }
      if (!element) return;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, String([...document.querySelectorAll('[data-thinking-level]')].findIndex(tick => tick.dataset.thinkingLevel === level)));
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    }); },
    async reload() { await act(async () => root.render(null)); await render(); },
    async navigate() { sessionId += '-next'; await render(); },
    async type(value) { const input = container.querySelector('textarea'); await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    }); },
  };
}

test('unsupported saved strength automatically matches the runtime without losing or blocking the draft', async t => {
  const view = await fixture(t, 'ultra', {selectedModel:{id:'relay/grok-4.7',provider:'relay',model:'grok-4.7',configured:true,thinkingLevels:['off']}});
  await view.render(); await view.type('自动匹配后的草稿');
  assert.equal(view.trigger().getAttribute('aria-label'), '思考强度：关闭');
  assert.equal(view.storage.values.get(KEY), 'off');
  assert.equal(view.container.querySelector('.composer-thinking-warning'), null);
  await view.click(view.trigger());
  assert.equal(document.querySelector('.thinking-level-adaptive'), null);
  assert.equal(document.querySelector('[aria-label="选择Ultra思考强度"]'), null);
  assert.equal(view.slider(), null, 'one supported level has no invented slider stops');
  assert.equal(document.querySelector('.thinking-level-reset').disabled, false);
  await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.equal(view.sent.length, 1); assert.equal(view.sent[0][4], 'off');
  assert.equal(view.sent[0][0], '自动匹配后的草稿');
});

test('StrictMode mount and remount read a saved preference without saving or replacing it', async t => {
  const view = await fixture(t, 'high', { strict: true }); await view.render();
  assert.equal(view.trigger().getAttribute('aria-label'), '思考强度：高');
  await view.reload(); await view.navigate();
  assert.equal(view.trigger().getAttribute('aria-label'), '思考强度：高');
  assert.deepEqual(view.storage.writes.filter(([key]) => key === KEY), []);
});

test('invalid saved strength falls back to auto without rewriting until an explicit selection', async t => {
  const view = await fixture(t, 'old-invalid-level', { strict: true, selectedModel:null }); await view.render();
  assert.equal(view.trigger().getAttribute('aria-label'), '思考强度：自动');
  assert.equal(view.storage.values.get(KEY), 'old-invalid-level');
  await view.click(view.trigger());
  assert.equal(view.slider(),null);
  assert.deepEqual(view.storage.writes.filter(([key]) => key === KEY), []);
});

test('strength selection survives navigation/reload and sends the exact level as the fifth argument', async t => {
  const view = await fixture(t); await view.render(); await view.click(view.trigger());
  assert.equal(view.container.querySelector('select'), null, 'no native select is exposed');
  assert.equal(view.container.querySelector('[role=listbox]'), null, 'strength is a slider rather than a disguised listbox');
  await view.choose('xhigh'); assert.ok(view.menu(), 'sliding keeps the compact popup open');
  await view.navigate(); await view.reload();
  assert.equal(view.trigger().getAttribute('aria-label'), '思考强度：极高');
  await view.type('需要深度核查'); await view.click(view.container.querySelector('[aria-label=发送消息]'));
  assert.deepEqual(view.sent[0], ['需要深度核查', [], [], {}, 'xhigh']);
});

test('keyboard slider saves arrows/Home/End immediately, clamps at the endpoints and returns focus on Enter or Escape', async t => {
  const view = await fixture(t, 'high'); await view.render(); view.trigger().focus();
  assert.equal((await view.key(view.trigger(), 'ArrowDown')).defaultPrevented, true);
  assert.equal(document.activeElement, view.slider());
  assert.equal(view.slider().getAttribute('aria-valuetext'), '高');
  await view.key(view.slider(), 'ArrowRight'); assert.equal(view.storage.values.get(KEY), 'xhigh');
  await view.key(view.slider(), 'Home'); assert.equal(view.storage.values.get(KEY), 'off');
  await view.key(view.slider(), 'ArrowLeft'); assert.equal(view.slider().value, '0');
  await view.key(view.slider(), 'End'); assert.equal(view.storage.values.get(KEY), 'ultra');
  await view.key(view.slider(), 'ArrowRight'); assert.equal(view.slider().value, '7');
  await view.key(view.slider(), 'Enter'); assert.equal(view.menu(), null);
  assert.equal(document.activeElement, view.trigger()); assert.equal(view.storage.values.get(KEY), 'ultra');
  await view.key(view.trigger(), ' '); await view.key(view.slider(), 'ArrowLeft');
  await view.key(view.slider(), 'Escape'); assert.equal(view.menu(), null);
  assert.equal(document.activeElement, view.trigger()); assert.equal(view.storage.values.get(KEY), 'max', 'Escape retains the last explicit slider choice');
});

test('Tab and Shift+Tab are not intercepted; menu closes only after default focus leaves it', async t => {
  const view = await fixture(t); await view.render();
  for (const shiftKey of [false, true]) {
    await view.click(view.trigger()); assert.equal(document.activeElement, view.slider());
    const event = await view.key(view.slider(), 'Tab', { shiftKey });
    assert.equal(event.defaultPrevented, false); assert.ok(view.menu(), 'popup remains during default Tab navigation');
    await act(async () => view.container.querySelector('textarea').focus());
    assert.equal(view.menu(), null); assert.equal(document.activeElement, view.container.querySelector('textarea'));
  }
});

test('streaming keeps next-message controls available; stopping closes the popup and rejects stale interactions', async t => {
  const view = await fixture(t, 'low'); await view.render();
  await view.render({ isStreaming: true }); await view.click(view.trigger());
  assert.ok(view.menu()); assert.equal(view.trigger().disabled, false);
  await view.click(view.trigger());
  for (const patch of [{ stopping: true }]) {
    await view.render({ isStreaming: false, stopping: false }); await view.click(view.trigger());
    const stale = view.slider(), staleReset = document.querySelector('.thinking-level-reset'); await view.render(patch);
    assert.equal(view.menu(), null); assert.equal(view.trigger().disabled, true);
    assert.equal(view.trigger().getAttribute('aria-expanded'), 'false'); await view.choose('max', stale); await view.click(staleReset);
    assert.equal(view.storage.values.get(KEY), 'low');
    await view.render({ isStreaming: false, stopping: false }); assert.equal(view.menu(), null);
  }
});

test('outside pointer closes menu without changing the current strength', async t => {
  const view = await fixture(t, 'adaptive'); await view.render(); await view.click(view.trigger());
  await act(async () => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
  assert.equal(view.menu(), null); assert.equal(view.storage.values.get(KEY), 'adaptive');
});

test('manual strength stops and model adaptive remain available, and reset restores auto', async t => {
  const view = await fixture(t, undefined, {selectedModel:{id:'fixture/all',provider:'fixture',model:'all',configured:true,thinkingLevels:[...THINKING_LEVELS]}}); await view.render(); await view.click(view.trigger());
  assert.equal(view.slider().min, '0'); assert.equal(view.slider().max, String(THINKING_LEVELS.length - 2)); assert.equal(view.slider().step, '1');
  for (const level of THINKING_LEVELS) {
    await view.choose(level);
    assert.equal(view.storage.values.get(KEY), level);
    if (level === 'adaptive') assert.equal(document.querySelector('.thinking-level-adaptive').getAttribute('aria-pressed'), 'true');
    else assert.equal(view.slider().value, String([...document.querySelectorAll('[data-thinking-level]')].findIndex(tick => tick.dataset.thinkingLevel === level)));
    assert.match(view.trigger().getAttribute('aria-label'), /^思考强度：/);
  }
  await view.click(document.querySelector('.thinking-level-reset'));
  assert.equal(view.storage.values.get(KEY), 'auto');
  assert.equal(view.slider().getAttribute('aria-valuetext'), 'Ultra');
  assert.equal(document.querySelector('.thinking-level-reset').disabled, true);
  assert.equal(document.activeElement, view.slider());
});

test('popup omits the duplicate model row and displays one auto option with the actual current strength', async t => {
  const view = await fixture(t, undefined, {selectedModel:{id:'relay/kimi-k3',provider:'relay',model:'kimi-k3',configured:true,thinkingLevels:['off']}});
  await view.render(); await view.click(view.trigger());
  assert.equal(view.trigger().textContent, '关闭');
  assert.equal(view.menu().querySelector('.thinking-level-heading strong').textContent, '关闭');
  assert.equal(view.menu().querySelector('.thinking-level-model'), null);
  assert.equal(view.menu().querySelectorAll('.thinking-level-auto').length, 1);
  assert.doesNotMatch(view.menu().textContent, /kimi-k3|自动 ·/);
  assert.equal(view.sent.length, 0);
});

test('unknown capability uses a single auto option and does not claim a measured strength', async t => {
  const view = await fixture(t, undefined, {selectedModel:null}); await view.render(); await view.click(view.trigger());
  assert.equal(view.trigger().textContent, '自动');
  assert.equal(view.menu().querySelector('.thinking-level-heading'), null);
  assert.equal(view.menu().querySelectorAll('.thinking-level-auto').length, 1);
  assert.equal(view.storage.values.has(KEY), false);
});

test('auto resolves the highest supported concrete effort and never guesses unknown capabilities', () => {
  assert.equal(resolveThinkingPreference('auto', ['off','minimal','low','medium','high']), 'high');
  assert.equal(resolveThinkingPreference('auto', ['off','xhigh','adaptive','max','ultra']), 'ultra');
  assert.equal(resolveThinkingPreference('auto', ['off','adaptive']), 'adaptive');
  assert.equal(resolveThinkingPreference('auto', ['off']), 'off');
  assert.equal(resolveThinkingPreference('auto', ['unrecognized']), undefined);
  assert.equal(resolveThinkingPreference('auto'), undefined);
});

test('default auto sends high for the current model, survives refresh, and manual low overrides it', async t => {
  const view = await fixture(t, undefined, {selectedModel:{id:'fixture/reasoning',provider:'fixture',model:'reasoning',configured:true,thinkingLevels:['off','low','medium','high']},
    otherModel:{id:'fixture/stronger',provider:'fixture',model:'stronger',configured:true,thinkingLevels:['off','low','xhigh']}});
  await view.render();
  assert.equal(view.trigger().getAttribute('aria-label'), '思考强度：高');
  assert.equal(view.trigger().textContent, '高');
  assert.equal(view.storage.values.has(KEY), false, 'resolving auto does not replace the preference with high');
  await view.reload(); await view.type('最高档请求'); await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.equal(view.sent[0][4], 'high');
  await view.click(view.trigger()); await view.choose('low'); await view.reload();
  assert.equal(view.trigger().getAttribute('aria-label'), '思考强度：低');
  await view.type('手动低档'); await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.equal(view.sent[1][4], 'low');
  await view.click(view.trigger()); await view.choose('auto'); await view.reload();
  assert.equal(view.trigger().getAttribute('aria-label'), '思考强度：高');
  assert.equal(view.storage.values.get(KEY), 'auto');
  await view.click(view.container.querySelector('[aria-label="选择模型"]'));
  await view.click([...document.querySelectorAll('[role="option"]')].find(element => element.textContent.includes('stronger')));
  await view.type('切换后最高档'); await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.equal(view.sent[2][4], 'xhigh');
  assert.equal(view.sent[2][5], 'fixture/stronger');
  assert.equal(view.storage.values.get(KEY), 'auto');
});

test('narrow-screen style permits wrapped tools and anchors the bounded popup to the tool row', () => {
  const style = fs.readFileSync(new URL('../src/styles/chat-composer.css', import.meta.url), 'utf8') + fs.readFileSync(new URL('../src/styles/thinking-level-picker.css', import.meta.url), 'utf8');
  assert.match(style, /\.composer-tools\s*\{[^}]*flex-wrap:wrap[^}]*min-width:0[^}]*position:relative/s);
  assert.match(style, /\.thinking-level-menu\s*\{[^}]*max-width:min\(260px, calc\(100vw - 28px\)\)[^}]*box-sizing:border-box/s);
  assert.match(style, /\.thinking-level-picker\s*\{\s*position:relative/s);
});


test('original slider popup escapes composer stacking context and omits the persistent keyboard hint', async t => {
  const view = await fixture(t, 'low'); await view.render(); await view.click(view.trigger());
  assert.equal(view.trigger().textContent, '低');
  assert.equal(view.container.querySelector('.composer-hint'), null);
  assert.equal(view.container.querySelector('textarea').hasAttribute('aria-describedby'), false);
  assert.equal(view.menu().parentElement, document.body);
  assert.ok(view.slider());
  assert.equal(view.menu().querySelector('.thinking-level-choices'), null);
  assert.ok(parseFloat(view.menu().style.left) >= 12);
  assert.ok(parseFloat(view.menu().style.top) >= 12);
  await act(async () => view.trigger().focus());
  await view.click(view.trigger()); assert.equal(view.menu(), null);
});

test('typing during generation keeps both the stop control and queue-send control available', async t => {
  const view = await fixture(t, 'off'); let stops = 0;
  await view.render({ isStreaming: true, onStop: () => { stops++; } });
  await view.type('下一步的草稿');
  const stop = view.container.querySelector('[aria-label="停止生成"]');
  assert.ok(stop && !stop.disabled);
  assert.ok(view.container.querySelector('[aria-label="排队发送"]'));
  await view.click(stop); assert.equal(stops, 1);
  assert.equal(view.container.querySelector('textarea').value, '下一步的草稿');
});

test('slash side opens the auxiliary chat without sending a model message',async t=>{
  const view=await fixture(t,'low');let opened=0;
  await view.render({onGoal:()=>{},onSideChat:()=>{opened++;}});
  await view.type('/side');
  assert.match(document.querySelector('[role=listbox]').textContent,/辅助对话/);
  await view.key(view.container.querySelector('textarea'),'ArrowDown');
  await view.key(view.container.querySelector('textarea'),'ArrowDown');
  await view.key(view.container.querySelector('textarea'),'Enter');
  assert.equal(opened,1);assert.equal(view.sent.length,0);
  assert.equal(view.container.querySelector('textarea').value,'');
});
