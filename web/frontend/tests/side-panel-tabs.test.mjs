import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// 辅助对话多实例面板（标签条 / “＋打开标签页”选择器 / 逐标签关闭 / 空态）的组件行为。
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
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

test('empty analysis conversations open their material panel immediately and show their typed title', async t => {
  const view = fixture(t);
  const analysisContext={id:'ctx-panel',platform:'douyin',accountId:'owner',accountName:'Owner',sessionId:'analysis-panel-owner',kind:'account-analysis',contentIds:['work'],sourceHash:'hash',markdown:'# 真实材料',createdAt:'2026-10-21T00:00:00Z',status:'prepared',result:null};
  await view.render(createElement(ChatPage,{session:{id:'analysis-panel-owner',title:'账号分析 · Owner',created:1,messages:[],conversationType:'account-analysis',analysisContext}}));
  const tab=[...view.container.querySelectorAll('[role=tab]')].find(b=>b.textContent==='分析材料');
  assert.equal(tab.getAttribute('aria-selected'),'true');
  assert.equal(view.container.querySelector('.chat-analysis-panel').closest('.chat-panel-content').hidden,false);
  assert.equal(view.container.querySelector('.chat-header-context h2').textContent,'账号分析 · Owner');
  assert.equal(view.container.querySelector('.chat-panel-launcher-tab'),null);
});

test('analysis composer presents the snapshot as a material card and preserves the old stored draft', async t => {
  const view = fixture(t);
  const markdown='# Works\n\n## 真实材料（JSON数据）\n\n```json\n[{"id":"one-work","title":"关于镜头语言的作品","body":"真实正文"}]\n```';
  const analysisContext={id:'card-context',platform:'douyin',accountId:'owner',accountName:'Creator',sessionId:'analysis-card',kind:'content-analysis',contentIds:['one-work'],sourceHash:'hash',markdown,createdAt:'2026-10-21T00:00:00Z',status:'prepared',result:null};
  setChatDraftText('analysis-card',markdown);
  await view.render(createElement(ChatPage,{session:{id:'analysis-card',title:'作品分析 · Creator',created:1,messages:[],conversationType:'content-analysis',analysisContext}}));
  const textarea=view.container.querySelector('.chat-input');
  assert.doesNotMatch(textarea.value,/JSON|one-work|真实材料/);
  assert.match(textarea.value,/改进建议/);
  assert.equal(getChatDraft('analysis-card').text,markdown,'presentation does not discard the original persisted draft');
  const card=view.container.querySelector('[aria-label="作品分析材料"]');
  const toggle=card.querySelector('[aria-controls]');
  const details=document.getElementById(toggle.getAttribute('aria-controls'));
  assert.equal(toggle.getAttribute('aria-expanded'),'false');
  assert.equal(details.hidden,true,'material details start collapsed');
  assert.ok(card.querySelector('[aria-label="查看分析材料"]'),'full material stays available while collapsed');
  await view.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'),'true');
  assert.equal(details.hidden,false);
  assert.equal(textarea.value.includes('改进建议'),true);
  await view.click(toggle);
  assert.equal(details.hidden,true);
  assert.equal(getChatDraft('analysis-card').text,markdown,'folding does not rewrite the draft or snapshot');
  assert.match(card.textContent,/Creator/);assert.match(card.textContent,/抖音/);assert.match(card.textContent,/1 篇作品/);
  assert.match(card.textContent,/关于镜头语言的作品/);assert.equal(card.querySelector('pre'),null);
  assert.equal(view.container.querySelector('.suggestions'),null,'analysis offers relevant actions instead of general chat suggestions');
  await view.click(view.container.querySelector('[aria-label="分析重点"] button'));
  assert.match(getChatDraft('analysis-card').text,/内容主题/);
  await view.click(view.container.querySelector('[aria-label="收起侧边面板"]'));
  await view.click(card.querySelector('[aria-label="查看分析材料"]'));
  const dialog=document.querySelector('[role="dialog"]');
  assert.ok(dialog);assert.match(dialog.textContent,/真实正文/);
  assert.equal(dialog.querySelector('details:last-child').open,false,'raw data stays folded');
  await view.click([...dialog.querySelectorAll('button')].find(button=>button.textContent==='在辅助面板查看'));
  assert.equal(document.querySelector('[role="dialog"]'),null);
  const tab=[...view.container.querySelectorAll('[role=tab]')].find(item=>item.textContent==='分析材料');
  assert.equal(tab.getAttribute('aria-selected'),'true');
  assert.equal(view.container.querySelector('.chat-analysis-panel').closest('.chat-panel-content').hidden,false);
  const opener=card.querySelector('[aria-label="查看分析材料"]');opener.focus();
  await view.click(opener);
  assert.ok(document.querySelector('[role="dialog"]'),'opening an already visible material panel still gives feedback');
  await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  assert.equal(document.querySelector('[role="dialog"]'),null);assert.equal(document.activeElement,opener);
});

test('the tab bar lists every side chat and switches between them', async t => {
  const view = fixture(t);
  await view.render(createElement(ChatPage, { session: parent, sideSessions: [sideA, sideB] }));
  let tabs = [...view.container.querySelectorAll('.chat-side-tab')];
  assert.deepEqual(tabs.map(b => b.textContent), ['辅助对话', '辅助对话 2']);
  assert.ok(tabs.every(tab=>tab.querySelector('.chat-panel-tab-icon svg')), 'panel type icons do not wait for remote data');
  assert.equal(tabs[0].getAttribute('aria-selected'), 'false');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true', 'the newest side chat is active by default');
  assert.equal(view.container.querySelector('.side-chat-composer textarea').getAttribute('aria-label'), '创作消息');
  await view.click(tabs[0]);
  tabs = [...view.container.querySelectorAll('.chat-side-tab')];
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true', 'clicking a tab switches the active side chat');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'false');
});

test('multiple analysis works use a readable selector and bounded previous/next actions',async t=>{
  const view=fixture(t);
  const works=[{id:'first-work',title:'第一篇完整标题',body:'第一篇正文',metrics:{likes:3}},{id:'last-work',title:'第二篇完整标题',body:'第二篇正文',metrics:{likes:8}}];
  const analysisContext={id:'nav-context',platform:'douyin',accountId:'owner',accountName:'Creator',sessionId:'work-navigation',kind:'content-analysis',contentIds:works.map(work=>work.id),sourceHash:'hash',markdown:'## 真实材料\n```json\n'+JSON.stringify(works)+'\n```',createdAt:'2026-10-21T00:00:00Z',status:'prepared',result:null};
  await view.render(createElement(ChatPage,{session:{id:'work-navigation',title:'作品分析',created:1,messages:[],conversationType:'content-analysis',analysisContext}}));
  assert.equal(view.container.querySelector('.analysis-evidence-picker'),null);
  const previous=view.container.querySelector('[aria-label="上一篇作品"]');
  assert.equal(previous.disabled,true);
  await view.click(view.container.querySelector('[aria-label="下一篇作品"]'));
  assert.match(view.container.querySelector('.analysis-evidence-work').textContent,/第二篇完整标题/);
  assert.equal(view.container.querySelector('[aria-label="下一篇作品"]').disabled,true);
  const selector=view.container.querySelector('[aria-label="选择分析作品"]');
  await act(async()=>selector.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})));
  assert.match(document.querySelector('[role="listbox"]').textContent,/第一篇完整标题.*第二篇完整标题/);
  await act(async()=>selector.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true})));
  await act(async()=>selector.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));
  assert.equal(document.querySelector('[role="listbox"]'),null);
  assert.match(view.container.querySelector('.analysis-evidence-work').textContent,/第一篇完整标题/);
});

test('the + button opens the full panel home without creating a chat, then lets the user choose', async t => {
  const view = fixture(t), calls=[];
  await view.render(createElement(ChatPage,{session:parent,sideSessions:[sideA],onSideChat:mode=>{calls.push(mode);return 's3';}}));
  await view.click(view.container.querySelector('.chat-side-tab-add'));
  const home=view.container.querySelector('.chat-panel-home');
  assert.ok(home);assert.match(home.textContent,/新增面板/);assert.match(home.textContent,/推荐/);
  assert.deepEqual(calls,[],'opening the launcher must not create a child');
  const rows=[...home.querySelectorAll('.chat-panel-tool-grid button')];
  assert.deepEqual(rows.map(row=>row.querySelector('strong').textContent),['文件','浏览器','来源','终端','变更','分析材料','生图工坊','发布中心','辅助对话']);
  await view.click(rows.find(row=>row.querySelector('strong').textContent==='辅助对话'));
  assert.deepEqual(calls,['create']);assert.equal(view.container.querySelector('.chat-panel-home'),null);
});

test('tool tabs keep browser evidence across navigation, persist types per parent and close independently',async t=>{
  const view=fixture(t);
  await view.render(createElement(ChatPage,{session:{...parent,id:'panel-parent'},sideSessions:[]}));
  const openHome=()=>view.click(view.container.querySelector('.chat-side-trigger'));
  const choose=title=>view.click([...view.container.querySelectorAll('.chat-panel-tool-grid button')].find(button=>button.querySelector('strong').textContent===title));
  await openHome();await choose('浏览器');
  assert.ok([...view.container.querySelectorAll('[role=tab]')].find(tab=>tab.textContent==='浏览器').querySelector('.chat-panel-tab-icon svg'));
  const browser=view.container.querySelector('.chat-browser-panel');
  assert.ok(browser);assert.match(browser.textContent,/读取页面标题/);
  await openHome();await choose('文件');
  assert.equal(view.container.querySelector('.chat-browser-panel'),browser,'browser stays mounted while switching tabs');
  assert.equal(browser.closest('.chat-panel-content').hidden,true);
  assert.ok(view.container.querySelector('.chat-panel-files'));
  assert.deepEqual(JSON.parse(localStorage.getItem('easel:chat-panel-tools:panel-parent')),['browser','files']);
  await view.click(view.container.querySelector('[aria-label="关闭：文件"]'));
  assert.ok(view.container.querySelector('.chat-panel-home'));
  await view.click([...view.container.querySelectorAll('[role=tab]')].find(tab=>tab.textContent==='浏览器'));
  assert.equal(browser.closest('.chat-panel-content').hidden,false);
  await view.render(createElement(ChatPage,{session:{...parent,id:'another-parent'},sideSessions:[]}));
  assert.equal(view.container.querySelector('.chat-browser-panel'),null,'another parent cannot see this page');
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
  const picker=view.container.querySelector('.chat-panel-home');
  await view.click([...picker.querySelectorAll('.chat-panel-reopen-list button')].find(item=>item.textContent.includes(sideB.title)));
  assert.deepEqual(reopened,[sideB.id]);assert.deepEqual(created,[]);
  assert.equal(view.container.querySelector('.chat-panel-home'),null);
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
  assert.ok(view.container.querySelector('.chat-panel-home'));
  const created = [];
  await view.render(createElement(ChatPage, {
    ...props, sideSessions: [],
    onSideChat: mode => { created.push(mode ?? 'open'); return 's4'; },
  }));
  await view.click(view.container.querySelector('.chat-side-trigger'));
  const button = [...view.container.querySelectorAll('.chat-panel-tool-grid button')].find(b => b.querySelector('strong').textContent === '辅助对话');
  assert.ok(button);
  await view.click(button);
  assert.deepEqual(created, ['create']);
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
