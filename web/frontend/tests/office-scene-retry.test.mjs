import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { tsModuleUrl } from './load-ts.mjs';

// Actual scene component lifecycle with a controlled runtime substitute.
// This checks retry/focus coordination, not GPU recovery or visual rendering.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const runtimeModule = moduleUrl(`export function createOfficeSceneRuntime(options) {
  const record = {options, focused: [], areas: [], resets: 0, disposed: 0};
  globalThis.__officeRetryRuntimes.push(record);
  return {update() {}, focus(id) {record.focused.push(id);}, focusArea(id) {record.areas.push(id);}, reset() {record.resets++;}, dispose() {record.disposed++;}};
}`);
const sourceUrl = new URL('../src/components/agent-office/AgentOfficeScene.tsx', import.meta.url);
let code = ts.transpileModule(fs.readFileSync(sourceUrl, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const parsed = ts.createSourceFile('AgentOfficeScene.js', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
const replacements = [];
for (const statement of parsed.statements.filter(ts.isImportDeclaration)) {
  const specifier = statement.moduleSpecifier.text;
  if (specifier.endsWith('.css')) {
    replacements.push({ start: statement.getStart(parsed), end: statement.end, text: '' });
    continue;
  }
  const target = specifier === './OfficeSceneRuntime' ? runtimeModule
    : specifier.startsWith('.') ? await tsModuleUrl(new URL(specifier + '.ts', sourceUrl)) : import.meta.resolve(specifier);
  replacements.push({ start: statement.moduleSpecifier.getStart(parsed), end: statement.moduleSpecifier.end, text: JSON.stringify(target) });
}
for (const replacement of replacements.reverse()) code = code.slice(0, replacement.start) + replacement.text + code.slice(replacement.end);
const { default: AgentOfficeScene } = await import(moduleUrl(code));

test('retry reapplies unchanged close-up focus and safely ignores failures from a discarded runtime', async t => {
  const runtimes = globalThis.__officeRetryRuntimes = [];
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount()); container.remove();
    assert.equal(runtimes.at(-1).disposed, 1);
    delete globalThis.__officeRetryRuntimes;
  });
  const agent = { id: 'child-a', name: 'Agent A', role: '协作', task: '检查', state: 'working', source: 'live' };
  let props = { agents: [agent], selectedId: agent.id, focusId: agent.id, onSelect() {}, paused: false, resetKey: 0 };
  const render = async patch => { props = { ...props, ...patch }; await act(async () => root.render(createElement(AgentOfficeScene, props))); };
  const retry = async () => act(async () => container.querySelector('.agent-office-scene__fallback button').click());
  await render();
  assert.deepEqual(runtimes[0].focused, [agent.id]);
  await act(async () => runtimes[0].options.onUnavailable('模拟 WebGL 上下文丢失'));
  assert.equal(runtimes[0].disposed, 1);
  assert.equal(container.querySelector('.agent-office-scene__labels').hidden, true);
  await retry();
  assert.equal(runtimes.length, 2);
  assert.deepEqual(runtimes[1].focused, [agent.id], 'a newly created renderer must receive the existing close-up target');
  assert.equal(container.querySelector('.agent-office-scene__labels').hidden, false);
  await act(async () => runtimes[0].options.onUnavailable('旧运行时迟到的错误'));
  assert.equal(runtimes[1].disposed, 0);
  assert.equal(container.querySelector('.agent-office-scene__fallback'), null);

  await act(async () => runtimes[1].options.onUnavailable('再次模拟 WebGL 上下文丢失'));
  await render({ focusId: null });
  await retry();
  assert.equal(runtimes.length, 3);
  assert.deepEqual(runtimes[2].focused, []);
  assert.equal(runtimes[2].resets, 1, 'retry uses the latest focus preference after the user leaves close-up');
});

test('area navigation changes only camera intent, survives GPU retry and reset returns to overview', async t => {
  const runtimes = globalThis.__officeRetryRuntimes = [];
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); delete globalThis.__officeRetryRuntimes; });
  const agent = { id: 'live-member', name: '实际成员', state: 'working', source: 'live', task: '保留当前任务' };
  let props = { agents: [agent], selectedId: agent.id, onSelect() { assert.fail('Area navigation must not select an employee'); }, paused: false, resetKey: 0 };
  await act(async () => root.render(createElement(AgentOfficeScene, props)));
  const fitness = () => [...container.querySelectorAll('.office-area-navigation button')].find(b => b.textContent === '健身区');
  await act(async () => fitness().click());
  assert.deepEqual(runtimes[0].areas, ['fitness']);
  assert.equal(agent.task, '保留当前任务'); assert.equal(agent.state, 'working');
  assert.equal(fitness().getAttribute('aria-pressed'), 'true');
  await act(async () => runtimes[0].options.onUnavailable('模拟GPU丢失'));
  assert.equal(fitness().disabled, true);
  await act(async () => container.querySelector('.agent-office-scene__fallback button').click());
  assert.deepEqual(runtimes[1].areas, ['fitness']);
  props = { ...props, resetKey: 1 };
  await act(async () => root.render(createElement(AgentOfficeScene, props)));
  assert.equal(container.querySelector('.office-area-navigation button').getAttribute('aria-pressed'), 'true');
});

test.after(() => window.close());
