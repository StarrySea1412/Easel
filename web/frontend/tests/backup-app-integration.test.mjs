import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';
import { act, createElement, StrictMode } from 'react';
import { tsModuleUrl } from './load-ts.mjs';

// Actual App + store + backup logic; page shells, network and timers are stubs.
// This checks state/controller integration, not browser layout or downloads.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const prefix = 'data:text/javascript;base64,';
const url = code => prefix + Buffer.from(code).toString('base64');
const rawApp = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const base = new URL('../src/', import.meta.url);
let fixtureId = 0;

async function fixture(t, initial, realSidebar = false) {
  const harness = { pages: {}, calls: [], streams: [], intervals: new Map(), nextTimer: 0 };
  globalThis.__backupApp = harness;
  const values = new Map(Object.entries(initial));
  const storage = { blocked: false, quota: false,
    getItem(key) { if (this.blocked) throw new Error('denied'); return values.get(key) ?? null; },
    setItem(key, value) { if (this.quota && key === 'easel_sessions') throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new Window().sessionStorage });
  t.mock.method(globalThis, 'BroadcastChannel', class { constructor() { throw new Error('disabled in fixture'); } });
  t.mock.method(globalThis, 'setInterval', (fn) => { const id = ++harness.nextTimer; harness.intervals.set(id, fn); return id; });
  t.mock.method(globalThis, 'clearInterval', id => harness.intervals.delete(id));
  const persistenceBase = await tsModuleUrl(new URL('lib/localPersistence.ts', base));
  const persistence = `${persistenceBase}#backup-app-${++fixtureId}`;
  const draftsBase = await tsModuleUrl(new URL('lib/chatDrafts.ts', base));
  const drafts = url(Buffer.from(draftsBase.slice(prefix.length), 'base64').toString().replaceAll(persistenceBase, persistence)) + `#${fixtureId}`;
  const storeBase = await tsModuleUrl(new URL('lib/store.ts', base));
  const store = url(Buffer.from(storeBase.slice(prefix.length), 'base64').toString().replaceAll(persistenceBase, persistence).replaceAll(draftsBase, drafts)) + `#${fixtureId}`;
  const api = url(`
    export const fetchStatus = async () => ({gateway: true, personas: [{name:'fixture'}]});
    export const fetchPersonas = async () => [];
    export const fetchLastTurn = async (...args) => {globalThis.__backupApp.calls.push(['fetchLastTurn',...args]);return {status:'missing'};};
    export const stopChat = async (...args) => {globalThis.__backupApp.calls.push(['stopChat',...args]);return globalThis.__backupApp.stopResponse ? globalThis.__backupApp.stopResponse(...args) : {stopped:true};};
    export const deleteSession = async (...args) => {globalThis.__backupApp.calls.push(['deleteSession',...args]);};
    export const questionStatus = async () => ({});
    export const streamChat = (...args) => {const controller=new AbortController();globalThis.__backupApp.streams.push({args,controller});return controller;};
  `);
  const lazy = url(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))};
    export function createLazyPage(label) {return function Page(props) {globalThis.__backupApp.pages[label]=props;return createElement('section',null,label);};}
  `);
  const actualSidebar = realSidebar ? await tsModuleUrl(new URL('components/Sidebar.tsx', base)) : null;
  const sidebar = realSidebar
    ? url(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))}; import ActualSidebar from ${JSON.stringify(actualSidebar)}; export default function Sidebar(props){globalThis.__backupApp.sidebar=props;return createElement(ActualSidebar,props);}`)
    : url(`export default function Sidebar(props) {globalThis.__backupApp.sidebar=props;return null;}`);
  const notice = url(`export default function StorageNotice(props) {globalThis.__backupApp.storageNotice=props;return null;}`);
  const empty = url('export default function Empty(){return null;}');
  const image = url(`export function useImageStudio(){return {};}`);
  let compiled = ts.transpileModule(rawApp, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const imports = ts.createSourceFile('App.js', compiled, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS).statements.filter(ts.isImportDeclaration);
  const replacements = [];
  for (const statement of imports) {
    const specifier = statement.moduleSpecifier.text;
    let target;
    if (!specifier.startsWith('.')) target = import.meta.resolve(specifier);
    else if (specifier === './lib/store') target = store;
    else if (specifier === './lib/chatDrafts') target = drafts;
    else if (specifier === './lib/api') target = api;
    else if (specifier === './lib/lazyPage') target = lazy;
    else if (specifier === './components/Sidebar') target = sidebar;
    else if (specifier === './components/StorageNotice') target = notice;
    else if (specifier === './hooks/useImageStudio') target = image;
    else if (specifier.startsWith('./components/')) target = empty;
    else target = await tsModuleUrl(new URL(specifier + '.ts', base));
    replacements.push({ start: statement.moduleSpecifier.getStart(), end: statement.moduleSpecifier.end, text: JSON.stringify(target) });
  }
  for (const item of replacements.reverse()) compiled = compiled.slice(0, item.start) + item.text + compiled.slice(item.end);
  const { default: App } = await import(url(compiled) + `#${fixtureId}`);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(createElement(StrictMode, null, createElement(App))));
  return { harness, storage, values, container, persistence: await import(persistence),
    settings: async () => { await act(async () => harness.sidebar.onPageChange('settings')); return harness.pages['设置'].conversationBackup; },
  };
}

const sourceSession = { id: 'original', title: '保留当前工作', created: 10, messages: [
  { role: 'user', content: '原提问' }, { role: 'assistant', content: '原回答' },
] };
const backup = { format: 'easel-conversation-backup', version: 1, exportedAt: '2026-09-30T00:00:00.000Z', sessions: [
  { title: '待导入记录', created: 2, incomplete: true, messages: [{ role: 'user', content: '导入提问' }] },
] };

function deferredStop() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('send callbacks explicitly accept one draft and reject busy, read-only or deleted sessions', async t => {
  const imported = { id: 'readonly', title: '备份', created: 1, importedFromBackup: true, messages: [] };
  const { harness } = await fixture(t, { easel_sessions: JSON.stringify([sourceSession, imported]), easel_active_session: 'original' });
  const previousConfirm = window.confirm;
  window.confirm = () => true;
  t.after(() => { window.confirm = previousConfirm; });
  await act(async () => harness.sidebar.onSessionSelect('original'));
  const originalSend = harness.pages['对话'].onSend;
  let accepted, busy, readonly, deleted;
  await act(async () => { accepted = originalSend('已接受草稿'); busy = originalSend('不应再接收'); });
  assert.equal(accepted, true); assert.equal(busy, false);
  assert.equal(harness.streams.length, 1);
  await act(async () => harness.sidebar.onSessionSelect('readonly'));
  await act(async () => { readonly = harness.pages['对话'].onSend('只读草稿不可发送', [], ['card-quote'], { 'card-quote': '不得被只读备份触发' }); });
  assert.equal(readonly, false);
  await act(async () => harness.sidebar.onSessionDelete('original'));
  await act(async () => { deleted = originalSend('已删除会话的晚到发送'); });
  assert.equal(deleted, false);
  assert.equal(harness.streams.length, 1);
});

test('skill requirements reach the stream as independent message snapshots and retry uses the original requirements', async t => {
  const other = { id: 'other', title: '另一会话', created: 1, messages: [] };
  const { harness, values } = await fixture(t, { easel_sessions: JSON.stringify([sourceSession, other]), easel_active_session: 'original' });
  await act(async () => harness.sidebar.onSessionSelect('original'));
  const requirements = { 'card-quote': '  原消息补充要求  ', unselected: '不应发送' };
  await act(async () => harness.pages['对话'].onSend('本轮消息', [], ['card-quote'], requirements));
  const run = harness.streams[0];
  assert.deepEqual(run.args[15], ['card-quote']);
  assert.deepEqual(run.args[16], { 'card-quote': '原消息补充要求' });
  requirements['card-quote'] = '发送后修改调用者对象';
  values.set('easel:skill-requirements:original', JSON.stringify({ 'card-quote': '后续轮次使用的新要求' }));
  const sent = harness.sidebar.sessions.find(s => s.id === 'original').messages[2];
  assert.deepEqual(sent.skillRequirements, { 'card-quote': '原消息补充要求' });
  assert.deepEqual(JSON.parse(values.get('easel_sessions')).find(s => s.id === 'original').messages[2].skillRequirements, sent.skillRequirements);
  await act(async () => run.args[4]('server-session'));
  await act(async () => harness.pages['对话'].onResend(2, '本轮消息'));
  assert.equal(harness.streams.length, 2);
  assert.deepEqual(harness.streams[1].args[16], { 'card-quote': '原消息补充要求' });
  await act(async () => harness.streams[1].args[4]('server-session'));
  await act(async () => harness.pages['对话'].onSend('修改后的新消息', [], ['card-quote'], { 'card-quote': '后续轮次使用的新要求' }));
  assert.deepEqual(harness.streams[2].args[16], { 'card-quote': '后续轮次使用的新要求' });
  assert.deepEqual(harness.sidebar.sessions.find(s => s.id === 'original').messages[2].skillRequirements, { 'card-quote': '原消息补充要求' });
  await act(async () => harness.sidebar.onSessionSelect('other'));
  await act(async () => harness.pages['对话'].onSend('另一会话未设置要求', [], ['card-quote']));
  assert.deepEqual(harness.streams[3].args[16], {});
  assert.deepEqual(harness.sidebar.sessions.find(s => s.id === 'other').messages[0].skillRequirements, {});
});

test('failed stop preserves the live connection and durable recovery identifiers, accepts more output and can retry', async t => {
  const { harness, values } = await fixture(t, { easel_sessions: JSON.stringify([sourceSession]), easel_active_session: 'original' });
  await act(async () => harness.sidebar.onSessionSelect('original'));
  await act(async () => harness.pages['对话'].onSend('持续运行'));
  const run = harness.streams[0];
  const pending = harness.sidebar.sessions.find(s => s.id === 'original').pendingTurnId;
  const response = deferredStop();
  harness.stopResponse = () => response.promise;
  let stopping;
  await act(async () => {
    run.args[3]('停止请求前'); run.args[6]('保留思考'); run.args[7]('保留活动');
    stopping = harness.pages['对话'].onStop();
    void harness.pages['对话'].onStop();
  });
  assert.equal(harness.calls.filter(call => call[0] === 'stopChat').length, 1);
  assert.equal(harness.pages['对话'].stopping, true);
  assert.equal(run.controller.signal.aborted, false);
  assert.equal(JSON.parse(values.get('easel_sessions')).find(s => s.id === 'original').pendingTurnId, pending);
  assert.equal(sessionStorage.getItem('easel_pending_turn:original'), pending);
  await act(async () => { response.reject(new Error('网络连接中断')); await stopping; });
  assert.equal(harness.pages['对话'].stopping, false);
  assert.match(harness.pages['对话'].stopError, /停止请求失败.*网络连接中断/);
  assert.equal(run.controller.signal.aborted, false);
  assert.equal(harness.sidebar.sessions.find(s => s.id === 'original').pendingTurnId, pending);
  assert.equal(sessionStorage.getItem('easel_pending_turn:original'), pending);
  assert.equal(harness.sidebar.sessions.find(s => s.id === 'original').messages.at(-1).role, 'user');
  await act(async () => {
    run.args[3]('，失败后继续接收');
    for (let i = 0; i < 40; i++) for (const pump of [...harness.intervals.values()]) pump();
  });
  assert.equal(harness.pages['对话'].stream.content, '停止请求前，失败后继续接收');
  harness.stopResponse = async () => ({ stopped: true });
  await act(async () => harness.pages['对话'].onStop());
  assert.equal(run.controller.signal.aborted, true);
  assert.equal(harness.pages['对话'].stream, undefined);
  assert.equal(harness.pages['对话'].stopError, undefined);
  assert.equal(harness.pages['对话'].stopping, false);
  const session = harness.sidebar.sessions.find(s => s.id === 'original');
  assert.equal(session.pendingTurnId, undefined);
  assert.equal(sessionStorage.getItem('easel_pending_turn:original'), null);
  assert.equal(JSON.parse(values.get('easel_sessions')).find(s => s.id === 'original').pendingTurnId, undefined);
  assert.equal(session.messages.at(-1).content, '停止请求前，失败后继续接收\n\n_（已停止）_');
  assert.equal(session.messages.at(-1).thinking, '保留思考');
  assert.equal(session.messages.at(-1).activity, '保留活动');
  await act(async () => harness.pages['对话'].onSend('确认停止后的新任务'));
  assert.equal(harness.streams.length, 2);
});

test('an unconfirmed stop keeps receiving the final result instead of fabricating a stopped response', async t => {
  const { harness } = await fixture(t, { easel_sessions: JSON.stringify([sourceSession]), easel_active_session: 'original' });
  await act(async () => harness.sidebar.onSessionSelect('original'));
  await act(async () => harness.pages['对话'].onSend('等待结束'));
  const run = harness.streams[0];
  const pending = harness.sidebar.sessions.find(s => s.id === 'original').pendingTurnId;
  harness.stopResponse = async () => ({ stopped: false });
  await act(async () => harness.pages['对话'].onStop());
  assert.equal(run.controller.signal.aborted, false);
  assert.match(harness.pages['对话'].stopError, /尚未确认/);
  assert.equal(harness.sidebar.sessions.find(s => s.id === 'original').pendingTurnId, pending);
  await act(async () => {
    run.args[3]('真实完成结果');
    for (let i = 0; i < 30; i++) for (const pump of [...harness.intervals.values()]) pump();
    run.args[4]('server-session');
  });
  assert.equal(harness.pages['对话'].stopError, undefined);
  assert.equal(harness.pages['对话'].stream, undefined);
  assert.equal(harness.sidebar.sessions.find(s => s.id === 'original').messages.at(-1).content, '真实完成结果');
});

test('natural completion wins a stop race and prevents a delayed stop response from touching the next run', async t => {
  const { harness } = await fixture(t, { easel_sessions: JSON.stringify([sourceSession]), easel_active_session: 'original' });
  await act(async () => harness.sidebar.onSessionSelect('original'));
  await act(async () => harness.pages['对话'].onSend('自然结束竞态'));
  const run = harness.streams[0];
  const response = deferredStop();
  harness.stopResponse = () => response.promise;
  let stopping;
  await act(async () => { stopping = harness.pages['对话'].onStop(); });
  await act(async () => {
    run.args[3]('自然完成');
    for (let i = 0; i < 30; i++) for (const pump of [...harness.intervals.values()]) pump();
    run.args[4]('server-session');
  });
  assert.equal(harness.pages['对话'].stream, undefined);
  assert.equal(harness.pages['对话'].stopping, true);
  let acceptedWhileStopping;
  await act(async () => { acceptedWhileStopping = harness.pages['对话'].onSend('停止请求尚未收尾'); });
  assert.equal(acceptedWhileStopping, false);
  assert.equal(harness.streams.length, 1, 'do not start a new run while a session-wide stop is still in flight');
  await act(async () => { response.resolve({ stopped: true }); await stopping; });
  const session = harness.sidebar.sessions.find(s => s.id === 'original');
  assert.equal(session.messages.length, sourceSession.messages.length + 2);
  assert.equal(session.messages.at(-1).content, '自然完成');
  assert.equal(harness.pages['对话'].stopping, false);
  assert.equal(harness.pages['对话'].stopError, undefined);
  await act(async () => harness.pages['对话'].onSend('下一轮'));
  assert.equal(harness.streams.length, 2);
  assert.equal(harness.streams[1].controller.signal.aborted, false);
});

test('office navigation opens the selected session and its activity without cancelling an ongoing chat', async t => {
  const view = await fixture(t, { easel_sessions: JSON.stringify([sourceSession]), easel_active_session: 'original' });
  const { harness } = view;
  await act(async () => harness.sidebar.onSessionSelect('original'));
  await act(async () => harness.pages['对话'].onSend('持续执行中的任务'));
  const run = harness.streams[0];
  await act(async () => harness.sidebar.onPageChange('agent-office'));
  const office = harness.pages['Agent 办公室'];
  assert.equal(office.activeSessionId, 'original');
  assert.ok(office.streams.original);
  await act(async () => office.onOpenActivity('original'));
  assert.equal(harness.sidebar.currentPage, 'activity');
  assert.equal(harness.pages['运行记录'].target.sessionId, 'original');
  assert.equal(harness.pages['运行记录'].target.turnId, '');
  await act(async () => office.onOpenChat('original'));
  assert.equal(harness.sidebar.currentPage, 'chat');
  assert.equal(harness.sidebar.activeSessionId, 'original');
  assert.equal(run.controller.signal.aborted, false);
  assert.equal(harness.streams.length, 1);
  assert.deepEqual(harness.calls, []);
});

test('import uses latest queued state, preserves live controllers and exports all received tokens despite quota failure', async t => {
  const original = JSON.stringify([sourceSession]);
  const view = await fixture(t, { easel_sessions: original, easel_active_session: 'original' });
  const { harness, storage, values } = view;
  const previewActions = await view.settings();
  await act(async () => harness.sidebar.onSessionSelect('original'));
  const chat = harness.pages['对话'];
  storage.quota = true;
  let result;
  // Both updates queue in one React event: the import callback was captured
  // before the new user message existed and must not replace it.
  await act(async () => {
    chat.onSend('导入预览后的新消息');
    result = previewActions.onImport(backup);
  });
  assert.equal(harness.sidebar.activeSessionId, 'original');
  assert.equal(harness.streams.length, 1);
  const run = harness.streams[0];
  assert.equal(run.controller.signal.aborted, false);
  const retained = harness.sidebar.sessions.find(s => s.id === 'original');
  assert.equal(retained.messages.at(-1).content, '导入预览后的新消息');
  assert.ok(retained.pendingTurnId);
  assert.equal(harness.sidebar.sessions.filter(s => s.importedFromBackup).length, 1);
  await act(async () => { run.args[3]('尚未显示完的token'); run.args[6]('完整思考'); run.args[7]('实际活动'); });
  const actions = await view.settings();
  const exported = actions.onExport();
  const live = exported.sessions.find(s => s.title === '保留当前工作');
  assert.equal(live.messages.at(-1).content, '尚未显示完的token');
  assert.equal(live.messages.at(-1).thinking, '完整思考');
  assert.equal(live.incomplete, true);
  assert.equal(values.get('easel_sessions'), original);
  assert.equal(view.persistence.getLocalPersistenceStatus().unsaved, true);
  assert.equal(run.controller.signal.aborted, false);

  await act(async () => actions.onOpenSession(result.firstSessionId));
  const importedChat = harness.pages['对话'];
  await act(async () => {
    importedChat.onSend('必须忽略', [], ['card-quote'], { 'card-quote': '也必须忽略' });
    importedChat.onResend(0, '必须忽略');
    importedChat.onStop();
  });
  assert.deepEqual(harness.calls, []);
  assert.equal(harness.streams.length, 1);
  assert.equal(harness.sidebar.sessions.find(s => s.importedFromBackup).messages.length, 1);
  storage.quota = false;
  await act(async () => { assert.equal(view.persistence.retryPendingLocalWrites(), true); });
  assert.equal(JSON.parse(values.get('easel_sessions')).filter(s => s.importedFromBackup).length, 1);
});

test('protected corrupt history survives import and raw export while the new copy remains recoverable in memory', async t => {
  const corrupt = '{unreadable original';
  const view = await fixture(t, { easel_sessions: corrupt });
  const actions = await view.settings();
  await act(async () => actions.onImport(backup));
  assert.equal(view.values.get('easel_sessions'), corrupt);
  assert.equal(view.persistence.retryPendingLocalWrites(), false);
  const latest = await view.settings();
  assert.equal(latest.onExport().sessions[0].messages[0].content, '导入提问');
  assert.equal(latest.onExportRaw().entries[0].value, corrupt);
  assert.equal(view.persistence.getLocalPersistenceStatus().unsaved, true);
  assert.deepEqual(view.harness.calls, []);
  assert.equal(view.harness.streams.length, 0);
});

test('repeated backup navigation emits a new settings request even while already on the settings page', async t => {
  const view = await fixture(t, { easel_sessions: JSON.stringify([sourceSession]) });
  await act(async () => view.harness.storageNotice.onOpenBackup());
  const first = view.harness.pages['设置'];
  assert.equal(first.initialSection, 'more');
  await act(async () => view.harness.storageNotice.onOpenBackup());
  const second = view.harness.pages['设置'];
  assert.equal(second.initialSection, 'more');
  assert.equal(second.navigationKey, first.navigationKey + 1);
  assert.deepEqual(view.harness.calls, []);
});

test('reopening a saved imported user-only snapshot never resumes its old job and can open a fresh chat', async t => {
  const imported = { ...sourceSession, id: 'saved-copy', importedFromBackup: true, backupIncomplete: true,
    messages: [{ role: 'user', content: '只有提问的快照' }], pendingTurnId: 'old-job', sessionKey: 'old-key' };
  const view = await fixture(t, { easel_sessions: JSON.stringify([imported]), easel_active_session: imported.id });
  assert.equal(view.harness.sidebar.activeSessionId, imported.id);
  assert.deepEqual(view.harness.calls, []);
  assert.equal(view.harness.streams.length, 0);
  await act(async () => view.harness.sidebar.onSessionSelect(imported.id));
  await act(async () => view.harness.pages['对话'].onNewChat());
  const newId = view.harness.sidebar.activeSessionId;
  assert.notEqual(newId, imported.id);
  assert.equal(view.harness.sidebar.sessions.find(s => s.id === newId).importedFromBackup, undefined);
  assert.deepEqual(view.harness.calls, []);
});


test('real Sidebar buttons select persisted sessions and create a separate empty conversation', async t => {
  const second = { id: 'second-existing', title: '另一个真实会话', created: 11, messages: [{role: 'user', content: '独立历史'}] };
  const { harness, container, values } = await fixture(t, {
    easel_sessions: JSON.stringify([sourceSession, second]), easel_active_session: sourceSession.id,
  }, true);
  assert.ok(container.querySelector('.sidebar-conversations'), 'the new conversation column is expanded by default');
  const existing = [...container.querySelectorAll('.session-select')].find(button => button.textContent === second.title);
  assert.ok(existing);
  await act(async () => existing.click());
  assert.equal(harness.sidebar.activeSessionId, second.id);
  assert.equal(values.get('easel_active_session'), second.id);
  assert.equal(harness.pages['对话'].session.id, second.id);
  assert.equal(harness.pages['对话'].session.messages[0].content, '独立历史');
  await act(async () => container.querySelector('[aria-label="展开工具栏"]').click());
  assert.equal(harness.sidebar.activeSessionId, second.id, 'expanding tools does not replace the selected conversation');
  await act(async () => container.querySelector('[aria-label="收起对话列表"]').click());
  assert.equal(harness.sidebar.activeSessionId, second.id);
  assert.ok(container.querySelector('.sidebar-toolbar'));
  await act(async () => container.querySelector('[aria-label="展开对话列表"]').click());
  await act(async () => container.querySelector('.sidebar-new-chat').click());
  const created = harness.sidebar.activeSessionId;
  assert.notEqual(created, second.id);
  assert.notEqual(created, sourceSession.id);
  const persisted = JSON.parse(values.get('easel_sessions'));
  assert.equal(persisted.length, 3);
  assert.deepEqual(persisted.find(item => item.id === created).messages, []);
  assert.deepEqual(persisted.find(item => item.id === second.id).messages, second.messages);
  assert.equal(harness.pages['对话'].session.id, created);
  assert.equal(harness.streams.length, 0, 'opening and selecting conversations never sends a model prompt');
});
