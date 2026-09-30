import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';

// Actual SettingsPanel navigation/controller; child cards and every API are
// stubs. This verifies React behavior, not browser layout or backend access.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const source = fs.readFileSync(new URL('../src/components/SettingsPanel.tsx', import.meta.url), 'utf8');

let compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const parsed = ts.createSourceFile('SettingsPanel.js', compiled, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
const replacements = [];
for (const statement of parsed.statements.filter(ts.isImportDeclaration)) {
  const specifier = statement.moduleSpecifier.text;
  if (specifier.endsWith('.css')) {
    replacements.push({ start: statement.getStart(), end: statement.end, text: '' });
    continue;
  }
  let target;
  if (!specifier.startsWith('.')) target = import.meta.resolve(specifier);
  else if (specifier === './settings/ConversationBackupCard') {
    target = moduleUrl(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))};
      export default function BackupCard(props) {globalThis.__settingsBackupNavigation.backupProps=props;return createElement('section',{'data-testid':'backup-card'},'会话备份桩');}`);
  } else if (specifier === './settings/StorageSettingsCard') {
    target = moduleUrl(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))};
      export default function StorageCard() {return createElement('section',{'data-testid':'storage-card'},'保存位置桩');}`);
  } else if (specifier === './settings/EmployeeAppearanceSettings') {
    target = moduleUrl(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))};
      export default function EmployeeSettings() {return createElement('section',{'data-testid':'employee-settings'},'员工角色卡桩');}`);
  } else {
    const named = statement.importClause?.namedBindings;
    const names = named && ts.isNamedImports(named) ? named.elements.map(item => (item.propertyName || item.name).text) : [];
    let stub = statement.importClause?.name ? 'export default function Stub(){return null;}\n' : '';
    stub += names.map(name => specifier === '../lib/api'
      ? `export const ${name}=async (...args)=>{
          const harness=globalThis.__settingsBackupNavigation;harness.calls.push({name:${JSON.stringify(name)},args});
          if(!Object.hasOwn(harness.responses,${JSON.stringify(name)}))throw new Error('Unexpected API: '+${JSON.stringify(name)});
          return harness.responses[${JSON.stringify(name)}];};`
      : `export function ${name}(){return null;}`).join('\n');
    target = moduleUrl(stub);
  }
  replacements.push({ start: statement.moduleSpecifier.getStart(), end: statement.moduleSpecifier.end, text: JSON.stringify(target) });
}
for (const replacement of replacements.reverse()) compiled = compiled.slice(0, replacement.start) + replacement.text + compiled.slice(replacement.end);
const { default: SettingsPanel } = await import(moduleUrl(compiled));

async function fixture(t) {
  const harness = {
    calls: [], backupProps: null,
    responses: {
      fetchEnvTools: { tools: [], python: 'simulated-python' },
      fetchModelPresets: { presets: {} },
      fetchModelChannels: { channels: Object.fromEntries(['chat', 'transcribe', 'speech', 'image', 'video', 'music'].map(key => [key, { rows: [] }])) },
      fetchSkillDetail: { apiSpec: { providers: [] } },
      fetchImagegenGallery: { channel: { baseUrl: '', keyMasked: '', model: '' } },
    },
  };
  globalThis.__settingsBackupNavigation = harness;
  let networkCalls = 0;
  t.mock.method(globalThis, 'fetch', () => { networkCalls++; throw new Error('No network allowed'); });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const props = { onExport: () => null, onExportRaw: () => null, onImport: () => ({ count: 1 }), onOpenSession: () => {} };
  t.after(async () => {
    await act(async () => root.unmount());
    assert.equal(networkCalls, 0);
    container.remove();
    delete globalThis.__settingsBackupNavigation;
  });
  const render = async (navigationKey, conversationBackup = props) => act(async () => root.render(createElement(SettingsPanel, { initialSection: 'more', navigationKey, conversationBackup })));
  await render(0);
  return {
    container, harness, props, render,
    nav: label => [...container.querySelectorAll('.snav')].find(button => button.textContent.startsWith(label)),
    click: async button => act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))),
  };
}

test('more settings initially exposes both cards and its menu returns to the backup entry', async t => {
  const view = await fixture(t);
  const more = view.nav('更多设置');
  assert.ok(more);
  assert.match(more.textContent, /保存位置与备份/);
  assert.equal(more.getAttribute('aria-current'), 'page');
  assert.ok(view.container.querySelector('[data-testid="backup-card"]'));
  assert.ok(view.container.querySelector('[data-testid="storage-card"]'));
  assert.deepEqual(view.harness.backupProps, view.props);
  await view.click(view.nav('模型配置'));
  assert.equal(view.container.querySelector('[data-testid="backup-card"]'), null);
  await view.click(more);
  assert.ok(view.container.querySelector('[data-testid="backup-card"]'));
  assert.equal(more.getAttribute('aria-current'), 'page');
  assert.equal(view.harness.calls.length, 5);
});

test('a fresh navigation key restores the same more section with latest props without remounting settings state', async t => {
  const view = await fixture(t);
  await view.click(view.nav('模型配置'));
  const speech = [...view.container.querySelectorAll('.tab')].find(button => button.textContent === '配音');
  assert.ok(speech);
  await view.click(speech);
  assert.equal(view.container.querySelector('.tab.active')?.textContent, '配音');
  const callsBeforeNavigation = view.harness.calls.length;
  const latest = { ...view.props, onExport: () => 'latest callback', onOpenSession: () => 'latest open' };

  await view.render(0, latest);
  assert.equal(view.container.querySelector('[data-testid="backup-card"]'), null, 'unchanged navigation request preserves internal selection');
  await view.render(1, latest);
  assert.ok(view.container.querySelector('[data-testid="backup-card"]'));
  assert.equal(view.nav('更多设置').getAttribute('aria-current'), 'page');
  assert.equal(view.harness.backupProps.onExport, latest.onExport);
  assert.equal(view.harness.backupProps.onOpenSession, latest.onOpenSession);

  await view.click(view.nav('模型配置'));
  assert.equal(view.container.querySelector('.tab.active')?.textContent, '配音', 'channel state survives the external navigation');
  assert.equal(view.harness.calls.length, callsBeforeNavigation, 'settings initialization effects did not remount');
  await view.render(2, latest);
  assert.ok(view.container.querySelector('[data-testid="backup-card"]'));
});

test('employee appearance is a reachable independent settings section without additional server requests', async t => {
  const view = await fixture(t);
  const before = view.harness.calls.length;
  const entry = view.nav('员工角色卡');
  assert.ok(entry);
  await view.click(entry);
  assert.equal(entry.getAttribute('aria-current'), 'page');
  assert.ok(view.container.querySelector('[data-testid="employee-settings"]'));
  assert.equal(view.container.querySelector('[data-testid="backup-card"]'), null);
  assert.equal(view.harness.calls.length, before);
  await view.click(view.nav('更多设置'));
  assert.equal(view.container.querySelector('[data-testid="employee-settings"]'), null);
  assert.ok(view.container.querySelector('[data-testid="backup-card"]'));
});

test.after(async () => {
  await window.happyDOM.abort();
  window.close();
});
