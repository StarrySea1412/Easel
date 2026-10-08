import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { tsModuleUrl } from './load-ts.mjs';

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
  else if (specifier === './settings/SettingsField') target = await tsModuleUrl(new URL('../src/components/settings/SettingsField.tsx', import.meta.url));
  else if (specifier === './settings/ConversationBackupCard') {
    target = moduleUrl(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))};
      export default function BackupCard(props) {globalThis.__settingsBackupNavigation.backupProps=props;return createElement('section',{'data-testid':'backup-card'},'会话备份桩');}`);
  } else if (specifier === './settings/StorageSettingsCard') {
    target = moduleUrl(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))};
      export default function StorageCard() {return createElement('section',{'data-testid':'storage-card'},'保存位置桩');}`);
  } else if (specifier === './settings/EmployeeAppearanceSettings') {
    target = moduleUrl(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))};
      export default function EmployeeSettings() {return createElement('section',{'data-testid':'employee-settings'},'员工角色卡桩');}`);
  } else if (specifier === './settings/DemoDataSettingsCard') {
    target = moduleUrl(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))};
      export default function DemoSettings(props) {globalThis.__settingsBackupNavigation.demoProps=props;return createElement('section',{'data-testid':'demo-settings'},'演示数据设置桩');}`);
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

async function fixture(t, responseOverrides = {}) {
  const harness = {
    calls: [], backupProps: null,
    responses: {
      fetchEnvTools: { tools: [], python: 'simulated-python' },
      fetchModelPresets: { presets: {} },
      fetchModelChannels: { channels: Object.fromEntries(['chat', 'transcribe', 'speech', 'image', 'video', 'music'].map(key => [key, { rows: [] }])) },
      fetchSkillDetail: { apiSpec: { providers: [] } },
      fetchImagegenGallery: { channel: { baseUrl: '', keyMasked: '', model: '' } },
      ...responseOverrides,
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
  const demoDataPreference = { enabled: false, saved: true, error: '', onChange() {} };
  const render = async (navigationKey, conversationBackup = props, initialSection = 'more') => act(async () => root.render(createElement(SettingsPanel, { initialSection: initialSection === 'default' ? undefined : initialSection, navigationKey, conversationBackup, demoDataPreference })));
  await render(0);
  return {
    container, harness, props, render, demoDataPreference,
    nav: label => [...container.querySelectorAll('.snav')].find(button => button.textContent.startsWith(label)),
    click: async button => act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))),
  };
}

test('the studio video configuration link opens the existing model video channel directly', async t => {
  const view = await fixture(t);
  await view.render(1, view.props, 'video');
  const selected = view.container.querySelector('[role="tab"][aria-selected="true"]');
  assert.equal(selected?.textContent, '视频');
  assert.ok(view.container.querySelector('.snav[aria-current="page"]')?.textContent.includes('模型'));
  assert.ok(view.harness.calls.some(call => call.name === 'fetchModelChannels'));
});

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

test('settings opens general by default and the demo preference remains reachable from model configuration', async t => {
  const view = await fixture(t);
  await view.render(1, view.props, 'default');
  assert.equal(view.nav('通用设置').getAttribute('aria-current'), 'page');
  assert.ok(view.container.querySelector('[data-testid="demo-settings"]'));
  assert.deepEqual(view.harness.demoProps, view.demoDataPreference);
  const before = view.harness.calls.length;
  await view.click(view.nav('模型配置'));
  assert.equal(view.container.querySelector('[data-testid="demo-settings"]'), null);
  await view.click(view.nav('通用设置'));
  assert.ok(view.container.querySelector('[data-testid="demo-settings"]'));
  assert.equal(view.harness.calls.length, before);
});

function notificationConfig(onDone = false) {
  const config = { EASEL_NOTIFY_EMAIL: 'saved@example.test', EASEL_NOTIFY_SMTP_HOST: 'smtp.example.test', EASEL_NOTIFY_ON_DONE: onDone ? '1' : '0' };
  return { apiSpec: { providers: [{ keys: Object.entries(config).map(([env, masked]) => ({ env, masked })) }] } };
}

test('notification test clearly uses saved settings and does not save pending form edits', async t => {
  const view = await fixture(t, {
    fetchSkillDetail: notificationConfig(), testNotifyEmail: { ok: true, detail: '模拟发送结果', to: ['saved@example.test'] },
  });
  await view.render(1, view.props, 'notify');
  assert.match(view.container.textContent, /测试邮件使用已保存的收件人和 SMTP 配置/);
  const email = [...view.container.querySelectorAll('.settings-field')].find(field => field.textContent.startsWith('收件人')).querySelector('input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(email, 'unsaved@example.test');
    email.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const send = [...view.container.querySelectorAll('button')].find(button => button.textContent.includes('用已保存配置发测试邮件'));
  await view.click(send);
  const calls = view.harness.calls.filter(call => ['testNotifyEmail', 'saveEnv'].includes(call.name));
  assert.deepEqual(calls, [{ name: 'testNotifyEmail', args: [] }]);
  assert.match(view.container.textContent, /收件人 saved@example.test/);
  assert.equal(email.value, 'unsaved@example.test');
});

for (const onDone of [false, true]) test(`saving notification configuration reports automatic mail ${onDone ? 'enabled' : 'disabled'} accurately`, async t => {
  const view = await fixture(t, { fetchSkillDetail: notificationConfig(onDone), saveEnv: { ok: true } });
  await view.render(1, view.props, 'notify');
  await view.click([...view.container.querySelectorAll('button')].find(button => button.textContent === '保存通知配置'));
  assert.equal(view.harness.calls.find(call => call.name === 'saveEnv').args[0].EASEL_NOTIFY_ON_DONE, onDone ? '1' : '0');
  assert.match(view.container.querySelector('.save-note').textContent, onDone ? /已保存并开启自动邮件通知/ : /自动邮件通知已关闭/);
});

test.after(async () => {
  await window.happyDOM.abort();
  window.close();
});
