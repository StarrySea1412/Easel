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

async function fixture(t, initial) {
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
  const storeBase = await tsModuleUrl(new URL('lib/store.ts', base));
  const store = url(Buffer.from(storeBase.slice(prefix.length), 'base64').toString().replaceAll(persistenceBase, persistence)) + `#${fixtureId}`;
  const api = url(`
    export const fetchStatus = async () => ({gateway: true, personas: [{name:'fixture'}]});
    export const fetchPersonas = async () => [];
    export const fetchLastTurn = async (...args) => {globalThis.__backupApp.calls.push(['fetchLastTurn',...args]);return {status:'missing'};};
    export const stopChat = async (...args) => {globalThis.__backupApp.calls.push(['stopChat',...args]);return {stopped:true};};
    export const deleteSession = async (...args) => {globalThis.__backupApp.calls.push(['deleteSession',...args]);};
    export const questionStatus = async () => ({});
    export const streamChat = (...args) => {const controller=new AbortController();globalThis.__backupApp.streams.push({args,controller});return controller;};
  `);
  const lazy = url(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))};
    export function createLazyPage(label) {return function Page(props) {globalThis.__backupApp.pages[label]=props;return createElement('section',null,label);};}
  `);
  const sidebar = url(`export default function Sidebar(props) {globalThis.__backupApp.sidebar=props;return null;}`);
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
  return { harness, storage, values, persistence: await import(persistence),
    settings: async () => { await act(async () => harness.sidebar.onPageChange('settings')); return harness.pages['设置'].conversationBackup; },
  };
}

const sourceSession = { id: 'original', title: '保留当前工作', created: 10, messages: [
  { role: 'user', content: '原提问' }, { role: 'assistant', content: '原回答' },
] };
const backup = { format: 'easel-conversation-backup', version: 1, exportedAt: '2026-09-30T00:00:00.000Z', sessions: [
  { title: '待导入记录', created: 2, incomplete: true, messages: [{ role: 'user', content: '导入提问' }] },
] };

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
    importedChat.onSend('必须忽略');
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
