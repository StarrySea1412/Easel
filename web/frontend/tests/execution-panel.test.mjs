import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Panel } = await loadTsModule('../src/components/ChatExecutionPanel.tsx', import.meta.url);
const payload = (session = 'a', operations = [], warnings = []) => ({ sessionId: session, turnId: 't1', operations, warnings });
async function setup(t) {
  const requests = []; let opened = 0;
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })));
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const render = async (sessionId = 'a', extra = {}) => act(async () => root.render(createElement(Panel, { sessionId, turnId: 't1', streaming: false, onOpen: () => opened++, ...extra })));
  await render();
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return { requests, container, render, opened: () => opened,
    respond: async (index, data) => act(async () => requests[index].resolve(new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }))),
    click: async text => act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === text).click()) };
}
test('empty execution results retain backend warnings and retry without an aggregate record link', async t => {
  const view = await setup(t);
  await view.respond(0, payload('a', [], ['执行记录正在更新，请稍后查看。']));
  assert.match(view.container.textContent, /执行记录正在更新/);
  assert.doesNotMatch(view.container.textContent, /运行记录 ↗|执行详情/);
  assert.equal(view.opened(), 0);
  await view.click('重新读取'); assert.equal(view.requests.length, 2);
  await view.respond(1, payload()); assert.equal(view.container.textContent, '');
});

test('terminal and changes panels filter the same dated turn without mixing receipt kinds',async t=>{
  const view=await setup(t);await view.render('a',{kinds:['command'],emptyMessage:'没有命令'});
  const row={id:'cmd',name:'exec',kind:'command',status:'completed',command:'tool-command',path:'',output:'command output',diff:''};
  const diff={...row,id:'edit',name:'edit',kind:'file_change',command:'',path:'notes.md',diff:'+change'};
  await view.respond(0,payload('a',[row,diff]));
  assert.match(view.container.textContent,/tool-command/);assert.doesNotMatch(view.container.textContent,/notes.md/);
  await view.render('a',{kinds:['file_change'],emptyMessage:'没有变更'});
  assert.match(view.container.textContent,/notes.md/);assert.doesNotMatch(view.container.textContent,/tool-command/);
});
test('switching sessions hides old errors immediately and aborts pending old requests', async t => {
  const view = await setup(t);
  await act(async () => view.requests[0].reject(new Error('offline')));
  assert.match(view.container.textContent, /执行记录暂不可读/);
  await view.render('b'); assert.equal(view.container.textContent, '');
  assert.equal(view.requests[0].options.signal.aborted, true);
  await view.respond(1, payload('b')); assert.equal(view.container.textContent, '');
});
test('a failed refresh preserves real file diff receipts and offers recovery', async t => {
  const view = await setup(t);
  const row = { id: 'write1', name: 'write', status: 'returned', command: '', path: 'proof.txt', output: '', diff: '+1 alpha\n+2 beta', added: 2, removed: 0, elapsedSeconds: .4 };
  await view.respond(0, payload('a', [row], ['记录尚未完整。']));
  await act(async () => { const detail=view.container.querySelector('details.chat-execution-row');detail.open=true;detail.dispatchEvent(new window.Event('toggle')); });
  assert.match(view.container.textContent, /proof.txt/);
  assert.doesNotMatch(view.container.textContent, /个文件有修改回执|执行详情/);
  assert.match(view.container.textContent, /\+2 −0/);
  await view.click('重新读取');
  await act(async () => view.requests[1].reject(new Error('offline')));
  assert.match(view.container.textContent, /\+1 alpha/);
  assert.match(view.container.textContent, /已有回执保留/);
});
test('an old session response cannot become current execution evidence', async t => {
  const view = await setup(t); await view.render('b');
  await view.respond(0, payload('a', [], ['OLD PRIVATE WARNING']));
  assert.equal(view.container.textContent, '');
  await view.respond(1, payload('b', [], ['CURRENT WARNING']));
  assert.match(view.container.textContent, /CURRENT WARNING/);
  assert.doesNotMatch(view.container.textContent, /OLD PRIVATE WARNING/);
});

const operation = (id, status = 'running', output = '') => ({id,name:'exec',kind:'command',status,command:'python task.py',path:'',output,diff:''});
const emit = async data => act(async () => window.dispatchEvent(new window.CustomEvent('easel:execution', {detail:data})));
const expand = async view => act(async () => {const detail=view.container.querySelector('details.chat-execution-row');detail.open=true;detail.dispatchEvent(new window.Event('toggle'));});

test('ask_user transitions between running, waiting and answered using confirmed execution evidence', async t => {
  const view = await setup(t);
  const ask = {...operation('ask'), name:'ask_user', kind:'tool', command:''};
  await view.respond(0, payload('a',[ask]));
  assert.match(view.container.textContent,/执行中/);
  await emit(payload('a',[{...ask,waitingForUser:true}]));
  assert.match(view.container.textContent,/等待回答/);
  assert.doesNotMatch(view.container.textContent,/执行中/);
  await expand(view);
  assert.match(view.container.textContent,/等待你提交回答/);
  await emit(payload('a',[{...ask,status:'returned',waitingForUser:false,output:'answered'}]));
  assert.match(view.container.textContent,/answered/);
  assert.doesNotMatch(view.container.textContent,/等待回答|等待你提交回答/);
  await emit(payload('a',[{...ask,waitingForUser:true}]));
  assert.doesNotMatch(view.container.textContent,/等待回答/);
});

test('live evidence wins over an earlier HTTP response and keeps expanded details', async t => {
  const view = await setup(t);
  await emit(payload('a',[operation('live','running','first')]));
  await expand(view);
  await view.respond(0,payload('a',[operation('live','running','stale')]));
  assert.match(view.container.textContent,/first/);
  assert.doesNotMatch(view.container.textContent,/stale/);
  await emit(payload('a',[operation('live','completed','final')]));
  assert.equal(view.container.querySelector('details.chat-execution-row').open,true);
  assert.match(view.container.textContent,/final/);
  await emit(payload('a',[operation('live','running','late')]));
  assert.match(view.container.textContent,/执行已结束/);
  assert.doesNotMatch(view.container.textContent,/late/);
});

test('diff and output coexist and command/output/diff copy independently', async t => {
  const view = await setup(t), copied=[];
  const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async text=>copied.push(text)}}});
  t.after(()=>original?Object.defineProperty(globalThis,'navigator',original):delete globalThis.navigator);
  await view.respond(0,payload('a',[{...operation('edit','completed','actual receipt'),diff:'-old\n+new',added:1,removed:1}]));
  await expand(view);
  assert.match(view.container.textContent,/actual receipt/);
  assert.match(view.container.textContent,/\+new/);
  for(const text of ['复制命令','复制输出','复制差异']) await view.click(text);
  assert.deepEqual(copied,['python task.py','actual receipt','-old\n+new']);
});

test('paging retains 65 operations and loaded history after refreshing the latest page', async t => {
  const view = await setup(t);
  const rows=Array.from({length:65},(_,i)=>operation(String(i),'completed','row '+i));
  await view.respond(0,{...payload('a',rows.slice(25)),total:65,nextBefore:25});
  await view.click('加载较早记录');
  assert.match(view.requests[1].url,/before=25/);
  await view.respond(1,{...payload('a',rows.slice(0,25)),total:65,nextBefore:null});
  assert.equal(view.container.querySelectorAll('details.chat-execution-row').length,65);
  await emit({...payload('a',rows.slice(25)),total:65,nextBefore:25});
  assert.equal(view.container.querySelectorAll('details.chat-execution-row').length,65);
  assert.doesNotMatch(view.container.textContent,/加载较早记录/);
});

test('foreign live events and malformed plan data cannot become evidence', async t => {
  const view = await setup(t);
  await emit(payload('foreign',[operation('private')]));
  assert.equal(view.container.textContent,'');
  await view.respond(0,{...payload('a',[operation('unknown','unconfirmed')]),plan:[{step:{private:'unsafe'},status:'completed'}]});
  assert.match(view.container.textContent,/结果未确认/);
  assert.doesNotMatch(view.container.textContent,/unsafe/);
});

test('returned receipts cannot be revived by delayed running or unconfirmed snapshots', async t => {
  const view = await setup(t);
  await view.respond(0,payload('a',[operation('receipt','returned','saved receipt')]));
  await expand(view);
  await emit(payload('a',[operation('receipt','running','late running')]));
  await emit(payload('a',[operation('receipt','unconfirmed','late unknown')]));
  assert.match(view.container.textContent,/saved receipt/);
  assert.match(view.container.textContent,/工具已返回/);
  assert.doesNotMatch(view.container.textContent,/late running|late unknown/);
});

test('progress interleaves by recorded order; partial events preserve earlier entries and reject malformed ones', async t => {
  const view=await setup(t);
  const rows=[{...operation('one','completed'),order:2},{...operation('two','failed'),order:4}];
  const timeline=[{id:'p1',type:'progress',order:1,text:'先检查输入'},
    {id:'one',type:'operation',order:2,operationId:'one'},
    {id:'p2',type:'progress',order:3,text:'再检查输出'},
    {id:'two',type:'operation',order:4,operationId:'two'}];
  await view.respond(0,{...payload('a',rows),timeline});
  const list=()=>[...view.container.querySelector('.execution-timeline').children];
  assert.deepEqual(list().map(el=>el.tagName),['P','DETAILS','P','DETAILS']);
  assert.match(list()[0].textContent,/先检查输入/);assert.match(list()[3].textContent,/失败/);
  await emit({...payload('a',[{...rows[1],status:'running'}]),timeline:[{...timeline[2],text:'再检查输出 · 更新'},{id:'bad',type:'progress',order:NaN,text:'INVALID ENTRY'}]});
  assert.equal(list().length,4);assert.match(list()[2].textContent,/更新/);
  assert.match(list()[3].textContent,/失败/);assert.doesNotMatch(view.container.textContent,/INVALID ENTRY/);
});
