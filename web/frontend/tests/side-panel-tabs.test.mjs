import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// 辅助对话多实例面板（标签条 / “＋打开标签页”选择器 / 逐标签关闭 / 空态）的组件行为。
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
Object.defineProperty(globalThis,'localStorage',{value:window.localStorage,configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
Object.defineProperty(navigator, 'clipboard', { value: { async writeText() {} }, configurable: true });
window.matchMedia = () => ({ matches: false });
window.HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
const { createRoot } = await import('react-dom/client');
const { default: ChatPage } = await loadTsModule('../src/components/ChatPage.tsx', import.meta.url);
const {setChatDraftText,getChatDraft} = await loadTsModule('../src/lib/chatDrafts.ts',import.meta.url);

function fixture(t) {
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  t.after(() => { globalThis.ResizeObserver = originalObserver; });
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, json: async () => String(url).includes('/api/skills') ? [] : ({ records: [] }) }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return {
    container,
    render: (element) => act(async () => root.render(element)),
    click: (element) => act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))),
  };
}

const parent = { id: 'p', title: '主对话', created: 1, messages: [{ role: 'user', content: '帮我写文案' }] };
const sideA = { id: 's1', title: '辅助对话', created: 2, parentSessionId: 'p', messages: [] };
const sideB = { id: 's2', title: '辅助对话 2', created: 3, parentSessionId: 'p', messages: [] };

test('the tab bar lists every side chat and switches between them', async t => {
  const view = fixture(t);
  await view.render(createElement(ChatPage, { session: parent, sideSessions: [sideA, sideB] }));
  let tabs = [...view.container.querySelectorAll('.chat-side-tab')];
  assert.deepEqual(tabs.map(b => b.textContent), ['辅助对话', '辅助对话 2']);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'false');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true', 'the newest side chat is active by default');
  assert.equal(view.container.querySelector('.side-chat-composer textarea').getAttribute('aria-label'), '创作消息');
  await view.click(tabs[0]);
  tabs = [...view.container.querySelectorAll('.chat-side-tab')];
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true', 'clicking a tab switches the active side chat');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'false');
});

test('the + button opens the tab picker and creates a new side chat', async t => {
  const view = fixture(t);
  const calls = [];
  await view.render(createElement(ChatPage, {
    session: parent, sideSessions: [sideA],
    onSideChat: mode => { calls.push(mode); return 's3'; },
  }));
  await view.click(view.container.querySelector('.chat-side-tab-add'));
  const picker = document.body.querySelector('.chat-side-tab-picker');
  assert.ok(picker, 'the picker appears');
  assert.match(picker.textContent, /打开标签页/);
  assert.match(picker.textContent, /选择要在侧边面板中打开的标签/);
  const rows = [...picker.querySelectorAll('.chat-side-tab-picker-row')];
  assert.deepEqual(rows.map(row => row.querySelector('.chat-side-tab-picker-label').firstChild.textContent), ['辅助对话', '目标']);
  assert.equal(rows[1].disabled, true, 'without a goal the goal row is disabled');
  await view.click(rows[0]);
  assert.deepEqual(calls, ['create'], 'the picker always creates a new side chat');
  assert.equal(document.body.querySelector('.chat-side-tab-picker'), null, 'the picker closes after choosing');
});

test('side chat uses shared tools, preserves a rejected draft and sends only its own scope',async t=>{
  const view=fixture(t),sent=[];
  const child={...sideA,id:'send-side'};
  setChatDraftText(parent.id,'主对话草稿');setChatDraftText(child.id,'旁支问题');
  const props={session:parent,sideSessions:[child],onSideSend:(...args)=>{sent.push(args);return false;}};
  await view.render(createElement(ChatPage,props));
  const composer=view.container.querySelector('.side-chat-composer');
  assert.ok(composer.querySelector('[aria-label="添加素材或技能"]'));
  assert.ok(composer.querySelector('.thinking-level-trigger'));
  assert.ok(composer.querySelector('[aria-label="对话引擎"]').disabled);
  await view.click(composer.querySelector('[aria-label="发送消息"]'));
  assert.equal(sent.length,1);assert.equal(sent[0][0],child.id);assert.equal(sent[0][1],'旁支问题');
  assert.equal(getChatDraft(child.id).text,'旁支问题');assert.equal(getChatDraft(parent.id).text,'主对话草稿');
  await view.render(createElement(ChatPage,{...props,onSideSend:(...args)=>{sent.push(args);return true;}}));
  await view.click(composer.querySelector('[aria-label="发送消息"]'));
  assert.equal(getChatDraft(child.id).text,'');assert.equal(getChatDraft(parent.id).text,'主对话草稿');
});

test('side streaming content and stop action are bound to the active child',async t=>{
  const view=fixture(t),stopped=[];
  const child={...sideA,id:'stream-side',pendingTurnId:'side-turn'};
  await view.render(createElement(ChatPage,{session:parent,sideSessions:[child],
    sideStreams:{[child.id]:{content:'子对话实际输出',thinking:'子思考',activity:'读取材料',questions:[]}},
    onSideStop:id=>stopped.push(id)}));
  const side=view.container.querySelector('.side-chat');
  assert.match(side.textContent,/子对话实际输出/);
  await view.click(side.querySelector('[aria-label="停止生成"]'));
  assert.deepEqual(stopped,[child.id]);
});

test('closed side tabs can be reopened from the picker without creating a replacement',async t=>{
  const view=fixture(t),reopened=[],created=[];
  await view.render(createElement(ChatPage,{session:parent,sideSessions:[sideA],closedSideSessions:[{...sideB,sideClosed:true}],
    onSideReopen:id=>{reopened.push(id);return true;},onSideChat:()=>created.push('new')}));
  await view.click(view.container.querySelector('.chat-side-tab-add'));
  const picker=document.querySelector('.chat-side-tab-picker');
  await view.click([...picker.querySelectorAll('[role=menuitem]')].find(item=>item.textContent.includes(sideB.title)));
  assert.deepEqual(reopened,[sideB.id]);assert.deepEqual(created,[]);
  assert.equal(document.querySelector('.chat-side-tab-picker'),null);
});

test('side questions and failed stops remain actionable in their own session',async t=>{
  const view=fixture(t),answered=[],stopped=[],requests=[];
  t.mock.method(globalThis,'fetch',async(url,init={})=>{
    if(init.method==='POST')requests.push(JSON.parse(init.body));
    return {ok:true,json:async()=>String(url).includes('/question/answer')?{ok:true}:String(url).includes('/api/skills')?[]:{records:[]}};
  });
  const child={...sideA,id:'question-side',pendingTurnId:'question-turn'};
  await view.render(createElement(ChatPage,{session:parent,sideSessions:[child],sideStopErrors:{[child.id]:'停止请求失败，请重试'},
    sideStreams:{[child.id]:{content:'',thinking:'',activity:'等待回答',questions:[{id:'ask-child',questions:[{questionId:'choice',question:'选择素材来源',options:[{label:'用户材料'}]}]}]}},
    onSideStop:id=>stopped.push(id),onSideQuestionAnswered:(...args)=>answered.push(args)}));
  const side=view.container.querySelector('.side-chat');
  assert.match(side.textContent,/停止请求失败/);
  await view.click([...side.querySelectorAll('button')].find(button=>button.textContent==='重试停止'));
  await view.click([...side.querySelectorAll('button')].find(button=>button.textContent==='用户材料'));
  await view.click(side.querySelector('.question-card__submit'));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(stopped,[child.id]);assert.deepEqual(answered,[[child.id,'ask-child']]);
  assert.equal(requests[0].questionId,'ask-child');
  assert.equal(view.container.querySelector('.chat-main .question-card'),null);
});

test('Codex side approval sends the child turn identity without touching the parent',async t=>{
  const view=fixture(t),requests=[];
  const child={...sideA,id:'codex-child',engine:'codex',pendingTurnId:'codex-turn'};
  t.mock.method(globalThis,'fetch',async(url,init={})=>{
    if(init.method==='POST')requests.push(JSON.parse(init.body));
    return {ok:true,json:async()=>String(url).includes('/api/codex/turn/')?{sessionId:child.id,turn_id:child.pendingTurnId,pending:[{requestId:'permission-child',method:'item/commandExecution/requestApproval',params:{reason:'测试审批'}}]}:String(url).includes('/api/skills')?[]:{records:[]}};
  });
  await view.render(createElement(ChatPage,{session:parent,sideSessions:[child],sideStreams:{[child.id]:{content:'',thinking:'',activity:'',questions:[]}}}));
  const side=view.container.querySelector('.side-chat');
  assert.match(side.textContent,/Codex 等待审批/);
  await view.click([...side.querySelectorAll('button')].find(button=>button.textContent==='拒绝'));
  assert.deepEqual(requests.map(value=>[value.sessionId,value.turnId,value.requestId,value.decision]),[[child.id,child.pendingTurnId,'permission-child','decline']]);
});

test('each side chat tab closes from its own button and the panel keeps an empty state', async t => {
  const view = fixture(t);
  const closed = [];
  const props = { session: parent, sideSessions: [sideA, sideB], onSideClose: id => closed.push(id) };
  await view.render(createElement(ChatPage, props));
  await view.click(view.container.querySelector('.chat-side-tab-wrap.is-on .chat-side-tab-close'));
  assert.deepEqual(closed, ['s2'], 'the active tab closes with its own id');
  await view.render(createElement(ChatPage, { ...props, sideSessions: [] }));
  await view.click(view.container.querySelector('.chat-side-trigger'));
  assert.match(view.container.querySelector('.chat-side-panel-empty').textContent, /没有打开的辅助对话/);
  const created = [];
  await view.render(createElement(ChatPage, {
    ...props, sideSessions: [],
    onSideChat: mode => { created.push(mode ?? 'open'); return 's4'; },
  }));
  await view.click(view.container.querySelector('.chat-side-trigger'));
  const button = [...view.container.querySelectorAll('.chat-side-panel-empty button')].find(b => b.textContent === '新建辅助对话');
  assert.ok(button);
  await view.click(button);
  assert.deepEqual(created, ['open', 'create']);
});

test('a side chat tab renames by double-click; Enter saves, Escape and blank titles keep the old name', async t => {
  const view = fixture(t);
  const renamed = [];
  await view.render(createElement(ChatPage, { session: parent, sideSessions: [sideA], onSideRename: (id, title) => renamed.push([id, title]) }));
  const dblClick = element => act(async () => element.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })));
  const type = (input, value) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const key = (element, value) => act(async () => element.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true })));
  await dblClick(view.container.querySelector('.chat-side-tab'));
  let input = view.container.querySelector('.chat-side-tab-rename');
  assert.ok(input && input.value === sideA.title, 'double-click opens the box with the current title');
  await type(input, '选题讨论');
  await key(input, 'Enter');
  assert.deepEqual(renamed, [['s1', '选题讨论']]);
  assert.equal(view.container.querySelector('.chat-side-tab-rename'), null, 'the box closes after saving');
  assert.equal(view.container.querySelector('.chat-side-tab').textContent, '辅助对话', 'the label stays controlled by props until the caller updates');
  await dblClick(view.container.querySelector('.chat-side-tab'));
  input = view.container.querySelector('.chat-side-tab-rename');
  await type(input, '不会保存的名字');
  await key(input, 'Escape');
  assert.deepEqual(renamed, [['s1', '选题讨论']], 'Escape cancels without renaming');
  await dblClick(view.container.querySelector('.chat-side-tab'));
  input = view.container.querySelector('.chat-side-tab-rename');
  await type(input, '   ');
  await key(input, 'Enter');
  assert.deepEqual(renamed, [['s1', '选题讨论']], 'a blank title keeps the old name');
});

test('side chat tabs reorder by drag and by Alt+arrow keys', async t => {
  const view = fixture(t);
  const orders = [];
  await view.render(createElement(ChatPage, { session: parent, sideSessions: [sideA, sideB], onSideReorder: ids => orders.push(ids.join(',')) }));
  const fire = (element, type, props = {}) => act(async () => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, props);
    element.dispatchEvent(event);
  });
  let tabs = [...view.container.querySelectorAll('.chat-side-tab')];
  await fire(tabs[1], 'dragstart', { dataTransfer: { effectAllowed: '', setData() {} } });
  const firstWrap = view.container.querySelector('.chat-side-tab-wrap');
  await fire(firstWrap, 'dragover', { clientX: 0 });
  assert.ok(firstWrap.classList.contains('is-drop-before'), 'the left half shows the insert-before indicator');
  await fire(firstWrap, 'drop', { clientX: 0 });
  assert.deepEqual(orders, ['s2,s1'], 'dropping on the left half inserts before the target');
  orders.length = 0;
  tabs = [...view.container.querySelectorAll('.chat-side-tab')];
  const key = (element, props) => act(async () => element.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...props })));
  await key(tabs[0], { key: 'ArrowRight', altKey: true });
  assert.deepEqual(orders, ['s2,s1'], 'Alt+→ moves the first tab to the right');
  orders.length = 0;
  await key(tabs[0], { key: 'ArrowLeft', altKey: true });
  assert.deepEqual(orders, [], 'an edge tab cannot move further left');
});
