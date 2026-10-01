import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { tsModuleUrl } from './load-ts.mjs';

// Actual page, editor and persistence; the 3D renderer and live feed are controlled.
// This verifies retained scene inputs, not rendered pixels or a real GPU camera.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const storage = { values: new Map(), writes: [], fail: false,
  getItem(key) { return this.values.get(key) ?? null; },
  setItem(key, value) { this.writes.push([key, value]); if (this.fail) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); this.values.set(key, value); },
};
globalThis.localStorage = storage;
const { createRoot } = await import('react-dom/client');
const appearance = await import(await tsModuleUrl(new URL('../src/lib/employeeAppearance.ts', import.meta.url)));
const persistence = await import(await tsModuleUrl(new URL('../src/lib/localPersistence.ts', import.meta.url)));
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const react = JSON.stringify(import.meta.resolve('react'));
const scene = moduleUrl(`import {createElement,useEffect} from ${react}; export default function Scene(props){ const h=globalThis.__appearancePage; h.scene=props; useEffect(()=>{h.mounts++;return()=>{h.unmounts++;};},[]); return createElement('div',{'data-testid':'scene'},...props.agents.map(agent=>createElement('button',{key:agent.id,'data-agent':agent.id,onClick:()=>props.onSelect(agent.id)},agent.name))); }`);
const live = moduleUrl(`export function useAgentOffice(id,enabled){const h=globalThis.__appearancePage;h.liveCalls.push({id,enabled});return {agents:enabled?h.liveAgents:[],events:[],loading:false,error:null,observedAt:null,turnId:'test-turn',refresh(){}};}`);
const study = moduleUrl(`import {createElement} from ${react};export default function Study({onClose}){return createElement('button',{onClick:onClose},'返回办公室样板');}`);
let code = ts.transpileModule(fs.readFileSync(new URL('../src/components/AgentOfficePage.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
code = code.replace(/import\(['"]\.\/agent-office\/character-study\/CharacterStudy['"]\)/, `import(${JSON.stringify(study)})`);
const parsed = ts.createSourceFile('Page.js', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
const replacements = [];
for (const statement of parsed.statements.filter(ts.isImportDeclaration)) {
  const specifier = statement.moduleSpecifier.text;
  if (specifier.endsWith('.css')) { replacements.push({ start: statement.getStart(parsed), end: statement.end, text: '' }); continue; }
  const target = specifier === './agent-office/AgentOfficeScene' ? scene : specifier === '../hooks/useAgentOffice' ? live
    : ['./agent-office/OfficeProcessPanel', './agent-office/OfficeOutputMonitor', './agent-office/OfficeAgentControls', './agent-office/OfficeWorkPreview'].includes(specifier) ? moduleUrl('export default function Panel(){return null;}')
      : specifier.startsWith('.') ? await tsModuleUrl(new URL('../src/components/' + specifier + (specifier.includes('/lib/') ? '.ts' : '.tsx'), import.meta.url)) : import.meta.resolve(specifier);
  replacements.push({ start: statement.moduleSpecifier.getStart(parsed), end: statement.moduleSpecifier.end, text: JSON.stringify(target) });
}
for (const replacement of replacements.reverse()) code = code.slice(0, replacement.start) + replacement.text + code.slice(replacement.end);
const { default: Page } = await import(moduleUrl(code));

async function fixture(t) {
  storage.fail = false;
  appearance.resetEmployeeAppearances();
  storage.writes = [];
  const harness = { scene: null, mounts: 0, unmounts: 0, settings: 0, liveCalls: [], frames: new Map(), nextFrame: 0, liveAgents: [
    { id: 'live-first', name: '真实研究 Agent', role: '后台研究职责', task: '阅读真实任务', source: 'live', state: 'working' },
    { id: 'live-second', name: '真实写作 Agent', role: '后台写作职责', task: '撰写真实任务', source: 'live', state: 'thinking' },
  ] };
  globalThis.__appearancePage = harness;
  t.mock.method(window, 'requestAnimationFrame', callback => { const id = ++harness.nextFrame; harness.frames.set(id, callback); return id; });
  t.mock.method(window, 'cancelAnimationFrame', id => { harness.frames.delete(id); });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No backend calls in editor tests'); });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const props = { sessions: [{ id: 'one', title: '测试会话', messages: [] }], activeSessionId: 'one', streams: {}, onOpenChat() {}, onOpenSettings() { harness.settings++; } };
  await act(async () => root.render(createElement(Page, props)));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); storage.fail = false; });
  return { container, harness,
    dialog: () => document.querySelector('[role="dialog"]'),
    button: label => [...document.querySelectorAll('button')].find(item => item.textContent.replace(/[▶Ⅱ↺⌖↗]/g, '').trim() === label),
    async click(element) { assert.ok(element, 'target exists'); await act(async () => { element.focus(); element.click(); }); },
    async input(element, value) {
      const prototype = element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      await act(async () => element.dispatchEvent(new window.Event(element.tagName === 'SELECT' || element.type === 'color' ? 'change' : 'input', { bubbles: true })));
    },
    async escape() { await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); },
    async advance(now) { await act(async () => { const frames = [...harness.frames.values()]; harness.frames.clear(); for (const callback of frames) callback(now); }); },
  };
}

test('in-place draft previews preserve selection, close-up, mode and mounted scene; cancel restores the card without writes', async t => {
  const view = await fixture(t);
  await view.click(view.container.querySelector('[data-agent="researcher"]'));
  await view.click(view.button('近看选中员工'));
  const before = view.harness.scene;
  const original = before.agents.find(agent => agent.id === 'researcher').appearance;
  await view.click(view.button('编辑角色卡'));
  assert.ok(view.dialog());
  assert.equal(view.harness.settings, 0);
  await view.input(view.dialog().querySelector('.office-editor-fields input'), '新的研究伙伴');
  await view.input(view.dialog().querySelector('[aria-label="服装颜色"]'), '#123456');
  const preview = view.harness.scene.agents.find(agent => agent.id === 'researcher').appearance;
  assert.equal(preview.name, '新的研究伙伴');
  assert.equal(preview.shirtColor.toUpperCase(), '#123456');
  assert.equal(appearance.readEmployeeAppearances().find(card => card.id === 'researcher').name, original.name);
  assert.equal(view.harness.scene.selectedId, 'researcher');
  assert.equal(view.harness.scene.focusId, 'researcher');
  assert.equal(view.harness.scene.resetKey, before.resetKey);
  assert.equal(view.button('演示模式').getAttribute('aria-pressed'), 'true');
  assert.equal(view.harness.mounts, 1);
  assert.equal(view.harness.unmounts, 0);
  assert.deepEqual(storage.writes, []);
  await view.click(view.button('取消'));
  assert.equal(view.dialog(), null);
  assert.deepEqual(view.harness.scene.agents.find(agent => agent.id === 'researcher').appearance, original);
  assert.equal(view.harness.scene.focusId, 'researcher');
  assert.deepEqual(storage.writes, []);
});

test('saving validates and normalizes only the edited card and retains concurrent changes to other cards', async t => {
  const view = await fixture(t);
  await view.click(view.container.querySelector('[data-agent="researcher"]'));
  await view.click(view.button('近看选中员工'));
  await view.click(view.button('编辑角色卡'));
  await view.input(view.dialog().querySelector('.office-editor-fields input'), '  我的研究员  ');
  await act(async () => appearance.saveEmployeeAppearances(appearance.readEmployeeAppearances().map(card => card.id === 'writer' ? { ...card, name: '另一处更新的作者' } : card)));
  await view.click(view.button('保存角色卡'));
  assert.equal(view.dialog(), null);
  const saved = JSON.parse(storage.values.get('easel_employee_appearances')).value;
  assert.equal(saved.find(card => card.id === 'researcher').name, '我的研究员');
  assert.equal(saved.find(card => card.id === 'writer').name, '另一处更新的作者');
  assert.equal(saved.length, 7);
  assert.equal(view.harness.scene.selectedId, 'researcher');
  assert.equal(view.harness.scene.focusId, 'researcher');
  assert.equal(view.harness.mounts, 1);
  assert.equal(view.harness.unmounts, 0);
});

test('shared generic cards preview only the selected live Agent and keep real names and roles unchanged', async t => {
  const view = await fixture(t);
  await view.click(view.button('实时观测'));
  await view.click(view.container.querySelector('[data-agent="live-first"]'));
  const oldColor = view.harness.scene.agents[1].appearance.shirtColor;
  await view.click(view.button('编辑角色卡'));
  assert.match(view.dialog().textContent, /真实研究 Agent（live-first）/);
  assert.match(view.dialog().textContent, /不会改变提示词、技能、权限或任务/);
  assert.match(view.dialog().textContent, /2 位成员/);
  await view.input(view.dialog().querySelector('[aria-label="服装颜色"]'), '#445566');
  assert.equal(view.harness.scene.agents[0].appearance.shirtColor.toUpperCase(), '#445566');
  assert.equal(view.harness.scene.agents[1].appearance.shirtColor, oldColor);
  assert.equal(view.harness.scene.agents[0].name, '真实研究 Agent');
  assert.equal(view.harness.scene.agents[0].role, '后台研究职责');
  assert.equal(view.button('实时观测').getAttribute('aria-pressed'), 'true');
  await view.click(view.button('保存角色卡'));
  assert.ok(view.harness.scene.agents.every(agent => agent.appearance.shirtColor === '#445566'));
});

test('failed save retains draft, does not publish it or enqueue a later write, and cancel restores original', async t => {
  const view = await fixture(t);
  const original = view.harness.scene.agents[0].appearance;
  const oldValue = storage.values.get('easel_employee_appearances');
  await view.click(view.button('编辑角色卡'));
  await view.input(view.dialog().querySelector('.office-editor-fields input'), '失败后保留草稿');
  storage.fail = true;
  await view.click(view.button('保存角色卡'));
  assert.ok(view.dialog());
  assert.match(view.dialog().querySelector('[role="alert"]').textContent, /草稿仍保留/);
  assert.equal(view.dialog().querySelector('.office-editor-fields input').value, '失败后保留草稿');
  assert.equal(appearance.readEmployeeAppearances()[0].name, original.name);
  assert.equal(storage.values.get('easel_employee_appearances'), oldValue);
  const attempts = storage.writes.length;
  storage.fail = false;
  await act(async () => persistence.retryPendingLocalWrites());
  assert.equal(storage.writes.length, attempts, 'failed transactional draft is never queued');
  await view.click(view.button('取消'));
  assert.deepEqual(view.harness.scene.agents[0].appearance, original);
  assert.equal(storage.values.get('easel_employee_appearances'), oldValue);
});

test('invalid input stays editable and a storage failure can be retried without losing the current draft', async t => {
  const view = await fixture(t);
  await view.click(view.button('编辑角色卡'));
  await view.input(view.dialog().querySelector('.office-editor-fields input'), ' ');
  await view.click(view.button('保存角色卡'));
  assert.match(view.dialog().querySelector('[role="alert"]').textContent, /显示名/);
  assert.deepEqual(storage.writes, []);
  await view.input(view.dialog().querySelector('.office-editor-fields input'), '重试保存的角色');
  storage.fail = true;
  await view.click(view.button('保存角色卡'));
  assert.ok(view.dialog());
  storage.fail = false;
  await view.click(view.button('保存角色卡'));
  assert.equal(view.dialog(), null);
  assert.equal(appearance.readEmployeeAppearances()[0].name, '重试保存的角色');
});

test('Escape discards preview, returns focus to edit button and leaves camera inputs unchanged', async t => {
  const view = await fixture(t);
  const trigger = view.button('编辑角色卡');
  const before = view.harness.scene;
  await view.click(trigger);
  const close = view.dialog().querySelector('[aria-label="取消编辑并关闭"]');
  assert.equal(document.activeElement, close);
  await view.input(view.dialog().querySelector('.office-editor-fields input'), '不保留的草稿');
  await view.escape();
  assert.equal(view.dialog(), null);
  assert.equal(document.activeElement, trigger);
  assert.equal(view.harness.scene.resetKey, before.resetKey);
  assert.equal(view.harness.scene.focusId, before.focusId);
  assert.equal(view.harness.scene.selectedId, before.selectedId);
  assert.deepEqual(storage.writes, []);
});

test('opening from a scrolled inspector reveals the same preview and closing restores the prior scroll position', async t => {
  const view = await fixture(t);
  const page = view.container.querySelector('.agent-office-page');
  const preview = view.container.querySelector('.office-stage-viewport');
  page.scrollTop = 1000;
  t.mock.method(page, 'getBoundingClientRect', () => ({ top: 60 }));
  t.mock.method(preview, 'getBoundingClientRect', () => ({ top: -540 }));
  const before = view.harness.scene;
  await view.click(view.button('编辑角色卡'));
  assert.equal(page.scrollTop, 388, 'align preview 12 px beneath the page viewport');
  assert.equal(page.style.getPropertyValue('--office-preview-offset'), '96px', 'reserve app chrome above the narrow-screen preview');
  await view.input(view.dialog().querySelector('.office-editor-fields input'), '仍在预览');
  assert.equal(page.scrollTop, 388, 'typing must not repeatedly align or move the page');
  await view.click(view.button('取消'));
  assert.equal(page.scrollTop, 1000);
  assert.equal(page.style.getPropertyValue('--office-preview-offset'), '');
  await view.click(view.button('编辑角色卡'));
  assert.equal(page.scrollTop, 388);
  await view.click(view.button('保存角色卡'));
  assert.equal(page.scrollTop, 1000);
  assert.equal(view.harness.scene.resetKey, before.resetKey);
  assert.equal(view.harness.scene.focusId, before.focusId);
  assert.equal(view.harness.mounts, 1);
  assert.equal(view.harness.unmounts, 0);
});

test('opening the character study suspends the hidden demo clock and returning resumes from the same elapsed time', async t => {
  const view = await fixture(t);
  await view.advance(0); await view.advance(1200);
  const elapsed = Number(view.container.querySelector('.office-demo-seek').value);
  assert.equal(elapsed, 1.2);
  await view.click(view.button('角色与工位样板'));
  assert.equal(view.harness.frames.size, 0);
  await view.advance(60000);
  await view.click(view.button('返回办公室样板'));
  assert.equal(Number(view.container.querySelector('.office-demo-seek').value), elapsed);
  await view.advance(70000);
  assert.equal(Number(view.container.querySelector('.office-demo-seek').value), elapsed);
  await view.advance(70200);
  assert.equal(Number(view.container.querySelector('.office-demo-seek').value), 1.4);
});

test.after(async () => { await window.happyDOM.abort(); window.close(); });
