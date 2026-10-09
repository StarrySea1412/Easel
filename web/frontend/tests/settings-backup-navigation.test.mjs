import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { tsModuleUrl } from './load-ts.mjs';

// Actual SettingsPanel, model picker, shared Select and provider fields; other
// cards and APIs are stubs. This verifies React behavior, not browser/backend.
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
  else if (specifier === './settings/ModelConfigPicker') target = await tsModuleUrl(new URL('../src/components/settings/ModelConfigPicker.tsx', import.meta.url));
  else if (specifier === './settings/ProviderBoard') target = await tsModuleUrl(new URL('../src/components/settings/ProviderBoard.tsx', import.meta.url));
  else if (specifier === './ui/Select') target = await tsModuleUrl(new URL('../src/components/ui/Select.tsx', import.meta.url));
  else if (specifier === './icons' || specifier === './settingsIcons') target = await tsModuleUrl(new URL(`../src/components/${specifier.slice(2)}.tsx`, import.meta.url));
  else if (specifier === '../lib/modelImports') target = await tsModuleUrl(new URL('../src/lib/modelImports.ts', import.meta.url));
  else if (specifier === './settings/ConversationBackupCard') {
    target = moduleUrl(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))};
      export default function BackupCard(props) {globalThis.__settingsBackupNavigation.backupProps=props;return createElement('section',{'data-testid':'backup-card'},'会话备份桩');}`);
  } else if (specifier === './settings/StorageSettingsCard') {
    target = moduleUrl(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))};
      export default function StorageCard() {return createElement('section',{'data-testid':'storage-card'},'保存位置桩');}`);
  } else if (specifier === './settings/EmployeeAppearanceSettings') {
    target = moduleUrl(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))};
      export default function EmployeeSettings(props) {globalThis.__settingsBackupNavigation.employeeProps=props;return createElement('section',{'data-testid':'employee-settings'},'员工角色卡桩');}`);
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
          const response=harness.responses[${JSON.stringify(name)}];
          return typeof response==='function'?response(...args):response;};`
      : `export function ${name}(){return null;}`).join('\n');
    target = moduleUrl(stub);
  }
  replacements.push({ start: statement.moduleSpecifier.getStart(), end: statement.moduleSpecifier.end, text: JSON.stringify(target) });
}
for (const replacement of replacements.reverse()) compiled = compiled.slice(0, replacement.start) + replacement.text + compiled.slice(replacement.end);
const { default: SettingsPanel } = await import(moduleUrl(compiled));

async function fixture(t, responseOverrides = {}) {
  const harness = {
    calls: [], backupProps: null, employeeProps: null, officeOpens: 0,
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
  const render = async (navigationKey, conversationBackup = props, initialSection = 'more') => act(async () => root.render(createElement(SettingsPanel, { initialSection: initialSection === 'default' ? undefined : initialSection, navigationKey, conversationBackup, demoDataPreference, onOpenOffice: () => { harness.officeOpens++; } })));
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
  assert.equal(view.harness.employeeProps.defaultModelLabel, '尚未设置');
  await act(async () => view.harness.employeeProps.onOpenOffice());
  assert.equal(view.harness.officeOpens, 1);
  assert.equal(view.container.querySelector('[data-testid="backup-card"]'), null);
  assert.equal(view.harness.calls.length, before);
  await act(async () => view.harness.employeeProps.onOpenModels());
  assert.equal(view.nav('模型配置').getAttribute('aria-current'), 'page');
  assert.equal(view.container.querySelector('.tab.active').textContent, '对话与脚本');
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

const configuredRows = () => [
  { slot: 'openai', order: 1, name: 'OpenAI', sub: '', type: 'openai', model: 'model-a', baseUrl: 'https://a.example.test/v1', keyMasked: 'sk***a', role: '主', result: '已配置' },
  { slot: 'anthropic', order: 2, name: 'Anthropic', sub: '', type: 'anthropic', model: 'model-b', baseUrl: 'https://b.example.test', keyMasked: 'sk***b', role: '备', result: '已配置' },
];
const modelChannels = rows => ({ channels: Object.fromEntries(['chat', 'transcribe', 'speech', 'image', 'video', 'music'].map(key => [key, { rows: key === 'chat' ? rows : [] }])) });
const findButton = (view, text) => [...view.container.querySelectorAll('button')].find(button => button.textContent === text);
async function chooseLastModel(view) {
  const picker = view.container.querySelector('button[aria-label="主模型"]');
  for (const key of ['ArrowDown', 'End', 'Enter']) await act(async () => picker.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
}

test('default model selection is a draft until saved and survives the single import entry round trip', async t => {
  const view = await fixture(t, { fetchModelChannels: modelChannels(configuredRows()), fetchImportSources: { sources: [] } });
  await view.render(1, view.props, 'model');
  assert.match(view.container.querySelector('.model-default-current').textContent, /OpenAI · model-a/);
  assert.equal(view.container.querySelector('.model-provider-editors').closest('details').open, false);
  assert.equal(findButton(view, '保存并使用').disabled, true);
  await chooseLastModel(view);
  assert.match(view.container.querySelector('.model-default-current').textContent, /OpenAI · model-a/);
  assert.match(view.container.querySelector('.model-default-pending').textContent, /待保存：Anthropic · model-b/);
  assert.match(view.container.querySelector('.model-default-pending').textContent, /保存前仍使用已保存默认：OpenAI · model-a/);
  assert.equal(view.harness.calls.some(call => ['saveModelConfig', 'applyImport', 'runChannelSelftest'].includes(call.name)), false);
  assert.equal(view.container.querySelectorAll('button').length > 0, true);
  await view.click(findButton(view, '从 CC Switch / OpenClaw 导入'));
  assert.equal(view.container.querySelectorAll('.model-import-steps li').length, 3);
  await view.click(findButton(view, '收起导入'));
  assert.equal(view.nav('模型配置').getAttribute('aria-current'), 'page');
  assert.equal(view.nav('配置导入'), undefined);
  assert.match(view.container.querySelector('button[aria-label="主模型"]').textContent, /model-b/);
  assert.equal(findButton(view, '保存并使用').disabled, false);
  await view.click(findButton(view, '＋ 添加供应商'));
  assert.equal(view.container.querySelector('.model-provider-editors').closest('details').open, true);
  assert.ok(view.container.querySelector('input[aria-label="供应商名称"]'));
});

test('failed save preserves the chosen draft; success displays the server model and routing note', async t => {
  let attempts = 0;
  const savedRows = configuredRows().map((row, index) => ({ ...row, role: index === 1 ? '主' : '备', ...(index === 1 ? { model: 'server-model-b' } : {}) }));
  const view = await fixture(t, {
    fetchModelChannels: modelChannels(configuredRows()),
    saveModelConfig: async () => {
      if (++attempts === 1) throw new Error('synthetic save failure');
      return { ...modelChannels(savedRows), ok: true, note: '网关尚未确认重新加载，请核对执行回执' };
    },
  });
  await view.render(1, view.props, 'model');
  await chooseLastModel(view);
  await view.click(findButton(view, '保存并使用'));
  assert.match(view.container.querySelector('[role="alert"]').textContent, /保存失败：synthetic save failure/);
  assert.match(view.container.querySelector('button[aria-label="主模型"]').textContent, /model-b/);
  assert.match(view.container.querySelector('.model-default-current').textContent, /model-a/);
  await view.click(findButton(view, '保存并使用'));
  assert.match(view.container.querySelector('.model-default-current').textContent, /server-model-b/);
  assert.equal(view.container.querySelector('.model-default-pending'), null);
  assert.match(view.container.querySelector('.model-picker-message').textContent, /已保存默认：Anthropic · server-model-b/);
  assert.match(view.container.querySelector('.model-picker-message').textContent, /网关尚未确认重新加载/);
  assert.equal(view.harness.calls.filter(call => call.name === 'saveModelConfig').length, 2);
  assert.equal(view.harness.calls.find(call => call.name === 'saveModelConfig').args[1].find(row => row.slot === 'anthropic').primary, true);
  assert.equal(view.harness.calls.some(call => call.name === 'runChannelSelftest'), false);
});

test('import preview needs explicit confirmation, reports the actual default and preserves other provider drafts', async t => {
  const rows = configuredRows();
  const importedRows = rows.map((row, index) => index === 0 ? { ...row, model: 'imported-model-a' } : row);
  const candidate = { id: 'source-entry', name: 'Imported source', model: 'imported-model-a', baseUrl: rows[0].baseUrl, protocol: 'openai',
    keyMasked: 'sk***z', compatible: true, targetSlot: 'openai', overwrites: [{ field: 'model', current: 'model-a', incoming: 'imported-model-a' }], previewToken: 'synthetic-preview-token' };
  const view = await fixture(t, {
    fetchModelChannels: modelChannels(rows), fetchImportSources: { sources: [{ id: 'cc-switch', label: 'CC Switch', available: true, detail: 'Synthetic local source' }] },
    previewImport: { path: 'synthetic-source.db', candidates: [candidate], errors: [], note: '' },
    applyImport: { ...modelChannels(importedRows), ok: true, applied: { name: 'Imported source', slot: 'openai', source: 'cc-switch', fields: ['model'] } },
  });
  await view.render(1, view.props, 'model');
  const secondModel = view.container.querySelectorAll('input[aria-label="模型名称"]')[1];
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(secondModel, 'unsaved-model-b');
    secondModel.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await view.click(findButton(view, '从 CC Switch / OpenClaw 导入'));
  await view.click(findButton(view, '2. 预览可导入模型'));
  assert.equal(view.harness.calls.some(call => call.name === 'applyImport'), false);
  await view.click(view.container.querySelector('input[type="radio"]'));
  assert.equal(findButton(view, '3. 确认导入并保存').disabled, true);
  await view.click(view.container.querySelector('input[type="checkbox"]'));
  await view.click(findButton(view, '3. 确认导入并保存'));
  const apply = view.harness.calls.find(call => call.name === 'applyImport');
  assert.deepEqual(apply.args, ['cc-switch', 'source-entry', 'openai', 'synthetic-source.db', 'synthetic-preview-token']);
  assert.match(view.container.querySelector('.import-msg').textContent, /已保存默认现为：OpenAI · imported-model-a/);
  assert.match(view.container.querySelector('.import-msg').textContent, /尚未进行真实调用测活/);
  await view.click(findButton(view, '收起导入'));
  assert.match(view.container.querySelector('.model-default-current').textContent, /imported-model-a/);
  assert.equal(view.container.querySelectorAll('input[aria-label="模型名称"]')[1].value, 'unsaved-model-b');
  assert.equal(findButton(view, '保存并使用').disabled, false);
  assert.equal(view.harness.calls.some(call => call.name === 'runChannelSelftest'), false);
});

test('model-list discovery reports failure and empty results, then fills a draft without saving or running a model', async t => {
  let reads = 0;
  const rows = configuredRows().map((row, index) => index === 0 ? { ...row, sub: '官方直连' } : row);
  const view = await fixture(t, {
    fetchModelChannels: modelChannels(rows),
    discoverModels: async () => {
      reads++;
      const common = { channel: 'chat', slot: 'openai', source: rows[0].baseUrl, fetchedAt: 123, keySource: 'saved' };
      if (reads === 1) return { ...common, ok: false, kind: 'http_error', models: [], message: 'Synthetic HTTP 403' };
      return { ...common, ok: true, kind: 'models', models: reads === 2 ? [] : ['catalog-first', 'catalog-second'], message: 'Synthetic list response' };
    },
  });
  await view.render(1, view.props, 'model');
  const card = view.container.querySelector('.provider-card');
  assert.doesNotMatch(card.textContent, /官方直连/);
  const discover = [...card.querySelectorAll('button')].find(button => button.textContent === '获取模型列表');
  assert.match(discover.title, /不发起模型推理/);
  await view.click(discover);
  assert.match(card.textContent, /Synthetic HTTP 403/);
  assert.match(card.textContent, /核对地址、协议和 Key/);
  await view.click(discover);
  assert.match(card.textContent, /接口没有返回模型列表/);
  assert.ok(card.querySelector('[aria-label="获取的可用模型"]') === null, 'The old provider catalogue must not be selectable');
  await view.click(discover);
  const list = card.querySelector('button[aria-label="获取的可用模型"]');
  for (const key of ['ArrowDown', 'End', 'Enter']) await act(async () => list.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
  assert.equal(card.querySelector('input[aria-label="模型名称"]').value, 'catalog-second');
  assert.match(card.textContent, /已填入“模型名称”：catalog-second/);
  assert.match(view.container.querySelector('.model-default-current').textContent, /model-a/);
  assert.equal(findButton(view, '保存并使用').disabled, false);
  assert.equal(view.harness.calls.some(call => ['saveModelConfig', 'applyImport', 'runChannelSelftest'].includes(call.name)), false);
  assert.deepEqual(view.harness.calls.find(call => call.name === 'discoverModels').args[0], {
    channel: 'chat', slot: 'openai', baseUrl: rows[0].baseUrl, apiKey: '', protocol: '',
  });
});

test('unconfigured models show why discovery is unavailable and expand their editable setup', async t => {
  const rows = configuredRows().map(row => ({ ...row, keyMasked: '—', result: '缺 Key' }));
  const view = await fixture(t, { fetchModelChannels: modelChannels(rows) });
  await view.render(1, view.props, 'model');
  assert.equal(view.container.querySelector('.model-provider-editors').closest('details').open, true);
  const discover = [...view.container.querySelectorAll('button')].filter(button => button.textContent === '获取模型列表');
  assert.equal(discover.length, 2);
  assert.equal(discover.every(button => button.disabled), true);
  assert.match(view.container.textContent, /先填写 API Key，或从配置导入/);
  assert.equal(view.harness.calls.some(call => call.name === 'discoverModels'), false);
});

test('legacy import links open the single model page and expand its import workflow', async t => {
  const view = await fixture(t, { fetchImportSources: { sources: [] } });
  await view.render(1, view.props, 'import');
  assert.equal(view.nav('模型配置').getAttribute('aria-current'), 'page');
  assert.equal(view.nav('配置导入'), undefined);
  assert.equal(view.container.querySelector('.model-inline-import').open, true);
  assert.ok(view.container.querySelector('.model-config-picker'));
  assert.equal(view.container.querySelectorAll('.model-import-steps').length, 1);
});

test('source cards read their own models immediately and reject a late response from the previous source', async t => {
  let finishFirst;
  const first = new Promise(resolve => { finishFirst = resolve; });
  const sourceCards = [
    { id: 'cc-switch', label: 'CC Switch', available: true, detail: 'Synthetic local source' },
    { id: 'openclaw', label: 'OpenClaw', available: true, detail: 'Synthetic local source' },
    { id: 'missing-source', label: 'Custom source', available: false, detail: 'Not found' },
  ];
  const candidate = { id: 'new-source-entry', name: 'OpenClaw model', compatible: true, model: 'current-source-model', baseUrl: 'https://example.test/v1', keyMasked: 'sk***', protocol: 'openai', targetSlot: 'openai', overwrites: [], previewToken: 'synthetic-token' };
  const current = { source: 'openclaw', path: '', candidates: [candidate], errors: [], note: '' };
  const view = await fixture(t, {
    fetchModelChannels: modelChannels(configuredRows()), fetchImportSources: { sources: sourceCards },
    previewImport: async source => source === 'cc-switch' ? first : current,
  });
  await view.render(1, view.props, 'model');
  await view.click(findButton(view, '从 CC Switch / OpenClaw 导入'));
  const cards = () => [...view.container.querySelectorAll('.imp-card')];
  assert.match(cards()[0].textContent, /点击读取模型/);
  assert.match(cards()[0].textContent, /已检测到/);
  await view.click(cards()[0]);
  assert.match(cards()[0].textContent, /正在读取模型/);
  assert.equal(cards()[1].disabled, false);
  await view.click(cards()[1]);
  assert.match(cards()[1].textContent, /已读取 1 个模型/);
  assert.match(view.container.querySelector('.import-list').textContent, /current-source-model/);
  await act(async () => finishFirst({ ...current, source: 'cc-switch', candidates: [{ ...candidate, name: 'STALE_SOURCE', model: 'STALE_MODEL' }] }));
  assert.doesNotMatch(view.container.querySelector('.import-list').textContent, /STALE/);
  assert.deepEqual(view.harness.calls.filter(call => call.name === 'previewImport').map(call => call.args), [['cc-switch', 'auto', ''], ['openclaw', 'auto', '']]);
  assert.equal(view.harness.calls.some(call => call.name === 'applyImport'), false);
  await view.click(cards()[2]);
  assert.equal(view.container.querySelector('.import-advanced').open, true);
  assert.match(view.container.querySelector('.import-msg').textContent, /填写配置文件路径/);
  assert.equal(view.container.querySelector('input[aria-label="自定义配置路径"]').disabled, false);
  assert.equal(view.harness.calls.filter(call => call.name === 'previewImport').length, 2);
});

test('import discovery keeps source credentials on the server and requires fresh confirmation for the fetched model', async t => {
  const candidate = { id: 'catalog-source', source: 'cc-switch', name: 'Catalog source', compatible: true,
    model: 'source-model', baseUrl: 'https://catalog.example.test/v1', keyPresent: true, keyMasked: 'sk***',
    protocol: 'openai', targetSlot: 'openai', overwrites: [], previewToken: 'original-token' };
  let finishSelection;
  const pendingSelection = new Promise(resolve => { finishSelection = resolve; });
  const view = await fixture(t, {
    fetchModelChannels: modelChannels(configuredRows()),
    fetchImportSources: { sources: [{ id: 'cc-switch', label: 'CC Switch', available: true }] },
    previewImport: { source: 'cc-switch', path: 'synthetic-source.db', candidates: [candidate], errors: [], note: '' },
    discoverImportModels: { ok: true, models: ['source-model', 'fetched-model'], message: '获取到 2 个模型', keySource: 'source' },
    selectImportModel: () => pendingSelection,
    applyImport: { ...modelChannels(configuredRows()), ok: true, applied: { name: 'Catalog source', slot: 'openai' } },
  });
  await view.render(1, view.props, 'import');
  await view.click(findButton(view, '2. 预览可导入模型'));
  await view.click(view.container.querySelector('input[type="radio"]'));
  await view.click(view.container.querySelector('input[type="checkbox"]'));
  await view.click(findButton(view, '获取该渠道模型'));
  assert.deepEqual(view.harness.calls.find(call => call.name === 'discoverImportModels').args, [{
    source: 'cc-switch', path: 'synthetic-source.db', id: candidate.id, slot: 'openai', previewToken: 'original-token',
  }]);
  const picker = view.container.querySelector('button[aria-label="Catalog source渠道可用模型"]');
  for (const key of ['ArrowDown', 'End', 'Enter']) await act(async () => picker.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
  assert.equal(view.container.querySelector('input[type="checkbox"]').checked, false);
  assert.equal(findButton(view, '3. 确认导入并保存').disabled, true);
  await act(async () => finishSelection({ ...candidate, model: 'fetched-model', previewToken: 'selected-token',
    overwrites: [{ field: 'OPENAI_MODEL', current: 'model-a', incoming: 'fetched-model' }] }));
  assert.match(view.container.querySelector('.ii-ov').textContent, /model-a → fetched-model/);
  assert.match(view.container.querySelector('.import-msg').textContent, /尚未保存/);
  assert.equal(view.harness.calls.some(call => call.name === 'applyImport'), false);
  await view.click(view.container.querySelector('input[type="checkbox"]'));
  await view.click(findButton(view, '3. 确认导入并保存'));
  assert.deepEqual(view.harness.calls.find(call => call.name === 'applyImport').args, [
    'cc-switch', candidate.id, 'openai', 'synthetic-source.db', 'selected-token',
  ]);
  assert.equal(view.harness.calls.some(call => ['runChannelSelftest', 'discoverModels', 'saveModelConfig'].includes(call.name)), false);
});

test('late source discovery is ignored when the user switches import sources', async t => {
  let finishDiscovery;
  const pending = new Promise(resolve => { finishDiscovery = resolve; });
  const candidate = { id: 'catalog-source', name: 'Catalog source', compatible: true, model: 'source-model',
    baseUrl: 'https://example.test/v1', keyPresent: true, keyMasked: 'sk***', protocol: 'openai', targetSlot: 'openai',
    overwrites: [], previewToken: 'synthetic-token' };
  const view = await fixture(t, {
    fetchModelChannels: modelChannels(configuredRows()),
    fetchImportSources: { sources: ['cc-switch', 'openclaw'].map(id => ({ id, label: id, available: true })) },
    previewImport: async source => ({ source, path: '', candidates: [{ ...candidate, name: source }], errors: [], note: '' }),
    discoverImportModels: () => pending,
  });
  await view.render(1, view.props, 'import');
  await view.click(findButton(view, '2. 预览可导入模型'));
  await view.click(findButton(view, '获取该渠道模型'));
  await view.click([...view.container.querySelectorAll('.imp-card')][1]);
  await act(async () => finishDiscovery({ ok: true, models: ['STALE_MODEL'], message: 'STALE_CATALOG' }));
  assert.doesNotMatch(view.container.querySelector('.import-list').textContent, /STALE/);
  assert.match(view.container.querySelector('.ii-name').textContent, /openclaw/);
  assert.equal(findButton(view, '获取该渠道模型').disabled, false);
});

test('provider cards hide internal order, collapse independently, and preserve editable drafts', async t => {
  const rows = configuredRows();
  const view = await fixture(t, { fetchModelChannels: modelChannels(rows) });
  await view.render(1, view.props, 'model');
  const cards = [...view.container.querySelectorAll('.provider-card')];
  assert.equal(cards.every(card => card.querySelector('.provider-body').hidden), true);
  assert.equal(view.container.querySelector('.provider-card .step'), null);
  assert.equal(cards.every(card => card.querySelector('.provider-glyph svg, .provider-glyph img')), true);
  const toggle = cards[0].querySelector('.provider-toggle');
  assert.equal(toggle.tagName, 'BUTTON');
  assert.equal(toggle.getAttribute('aria-controls'), cards[0].querySelector('.provider-body').id);
  await view.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(cards[1].querySelector('.provider-body').hidden, true);
  const input = cards[0].querySelector('input[aria-label="模型名称"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'draft-model');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await view.click(toggle);
  await view.click(toggle);
  assert.equal(input.value, 'draft-model');
  assert.equal(view.harness.calls.some(call => call.name === 'saveModelConfig'), false);
});

test('transcription cards use natural roles and missing key guidance rather than zero-based indices', async t => {
  const response = modelChannels(configuredRows());
  response.channels.transcribe.rows = [
    { order: 0, name: '自带字幕', sub: '视频自带字幕', type: '脚本层', model: '—', baseUrl: '—', keyMasked: '—', role: '免配', result: '优先' },
    { slot: 'siliconflow', order: 1, name: 'siliconflow', sub: '硅基流动', type: 'openai', model: 'SenseVoiceSmall', baseUrl: 'https://api.example.test/v1', keyMasked: '—', role: '主', result: '缺 key' },
  ];
  const view = await fixture(t, { fetchModelChannels: response });
  await view.render(1, view.props, 'model');
  await view.click(findButton(view, '语音转写'));
  const cards = [...view.container.querySelectorAll('.provider-card')];
  assert.deepEqual(cards.map(card => card.querySelector('.provider-heading strong').textContent), ['自带字幕', '云端转写', '本地兜底']);
  assert.deepEqual(cards.map(card => card.querySelector('.provider-body').hidden), [true, true, true]);
  assert.equal(cards.every(card => card.querySelector('.provider-glyph svg, .provider-glyph img')), true);
  assert.match(cards[0].querySelector('.provider-head').textContent, /免配置/);
  assert.match(cards[1].querySelector('.provider-head').textContent, /API Key/);
  assert.match(cards[2].querySelector('.provider-head').textContent, /云端不可用时接替/);
  assert.equal(view.container.querySelector('.step'), null);
  assert.ok(cards[1].querySelector('input[aria-label="模型名称"]'));
  assert.equal([...view.container.querySelectorAll('[role="tab"]')].every(tab => tab.querySelector('.channel-icon svg')), true);
  await view.click(cards[2].querySelector('.provider-toggle'));
  assert.match(cards[2].textContent, /无需 API Key/);
  await view.click(findButton(view, '打开环境安装'));
  assert.equal(view.nav('环境安装').getAttribute('aria-current'), 'page');
});

for (const [channel, label] of [['speech', '配音'], ['image', '生图'], ['video', '视频'], ['music', '音乐']]) test(`editable ${channel} models and addresses are available directly after expanding the provider`, async t => {
  const response = modelChannels(configuredRows());
  response.channels[channel].rows = [{ slot: 'editable-provider', order: 0, name: 'Editable provider', sub: channel,
    type: 'openai', model: 'configured-model', baseUrl: 'https://media.example.test/v1', keyMasked: 'sk***',
    role: '主', result: '已配置', modelEditable: true, baseEditable: true, baseOptional: true, adv: false }];
  const view = await fixture(t, { fetchModelChannels: response, saveModelConfig: { ...response, ok: true } });
  await view.render(1, view.props, 'model');
  await view.click(findButton(view, label));
  const card = view.container.querySelector('.provider-card');
  await view.click(card.querySelector('.provider-toggle'));
  const model = card.querySelector('input[aria-label="模型名称"]');
  const base = card.querySelector('input[aria-label="Base URL"]');
  assert.ok(model && base);
  assert.equal(model.closest('[hidden]'), null);
  assert.equal(base.closest('[hidden]'), null);
  assert.equal(card.querySelector('button[aria-label="服务商预设"]'), null);
  assert.equal([...card.querySelectorAll('button')].some(button => button.textContent === '高级'), false);
  for (const [input, value] of [[model, 'manual-model'], [base, 'https://edited.example.test/v1']]) await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await view.click(card.querySelector('.provider-toggle'));
  await view.click(card.querySelector('.provider-toggle'));
  assert.equal(model.value, 'manual-model');
  await view.click(findButton(view, '保存配置'));
  const saved = view.harness.calls.find(call => call.name === 'saveModelConfig');
  assert.equal(saved.args[0], channel);
  assert.equal(saved.args[1][0].model, 'manual-model');
  assert.equal(saved.args[1][0].baseUrl, 'https://edited.example.test/v1');
  assert.equal(view.harness.calls.some(call => call.name === 'runChannelSelftest'), false);
});

test('fixed media fields explain their limits while the API key remains editable', async t => {
  const response = modelChannels(configuredRows());
  response.channels.music.rows = [{ slot: 'fixed-provider', order: 0, name: 'Fixed provider', sub: 'music', type: 'music',
    model: '', baseUrl: '', keyMasked: '—', role: '主', result: '未配置', modelEditable: false, baseEditable: false }];
  const view = await fixture(t, { fetchModelChannels: response });
  await view.render(1, view.props, 'model');
  await view.click(findButton(view, '音乐'));
  const card = view.container.querySelector('.provider-card');
  assert.equal(card.querySelector('.provider-body').hidden, true);
  await view.click(card.querySelector('.provider-toggle'));
  assert.equal(card.querySelector('input[aria-label="模型名称"]'), null);
  assert.equal(card.querySelector('input[aria-label="Base URL"]'), null);
  assert.ok(card.querySelector('input[aria-label="API Key"]'));
  assert.match(card.textContent, /预置模型.*不支持覆盖.*支持自定义模型/);
  assert.match(card.textContent, /预置服务地址.*不支持覆盖.*支持自定义地址/);
});

test('model-list discovery discards a delayed response after the provider address changes', async t => {
  let finish;
  const rows = configuredRows();
  const view = await fixture(t, {
    fetchModelChannels: modelChannels(rows),
    discoverModels: () => new Promise(resolve => { finish = resolve; }),
  });
  await view.render(1, view.props, 'model');
  const card = view.container.querySelector('.provider-card');
  await view.click([...card.querySelectorAll('button')].find(button => button.textContent === '获取模型列表'));
  const address = card.querySelector('input[aria-label="Base URL"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(address, 'https://changed.example.test/v1');
    address.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => finish({ ok: true, kind: 'models', models: ['original-provider-only-model'],
    message: 'Original provider result', channel: 'chat', slot: 'openai', source: rows[0].baseUrl,
    fetchedAt: 123, keySource: 'saved' }));
  assert.equal(address.value, 'https://changed.example.test/v1');
  assert.equal(card.querySelector('[aria-label="获取的可用模型"]'), null);
  assert.doesNotMatch(card.textContent, /Original provider result/);
  assert.equal(view.harness.calls.some(call => ['saveModelConfig', 'runChannelSelftest'].includes(call.name)), false);
});

test('transcription saving protects editable fields until the server responds', async t => {
  let finish;
  const initial = modelChannels(configuredRows());
  initial.channels.transcribe.rows = [{ slot: 'siliconflow', order: 1, name: 'siliconflow', sub: 'transcribe',
    type: 'openai', model: 'original-asr', baseUrl: 'https://asr.example.test/v1', keyMasked: 'masked',
    role: '主', result: '已配置' }];
  const view = await fixture(t, {
    fetchModelChannels: initial, saveModelConfig: () => new Promise(resolve => { finish = resolve; }),
  });
  await view.render(1, view.props, 'model');
  await view.click(findButton(view, '语音转写'));
  const model = view.container.querySelector('input[aria-label="模型名称"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(model, 'first-edit');
    model.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await view.click(findButton(view, '保存配置'));
  const protectedWhileSaving = model.disabled || Boolean(model.closest('fieldset[disabled]'));
  if (!protectedWhileSaving) await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(model, 'second-edit-during-save');
    model.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const saved = structuredClone(initial);
  saved.channels.transcribe.rows[0].model = 'first-edit';
  await act(async () => finish({ ...saved, ok: true }));
  assert.ok(protectedWhileSaving, `Save accepted another edit, then replaced it with ${model.value}`);
  assert.equal(view.container.querySelector('input[aria-label="模型名称"]').value, 'first-edit');
  assert.equal(findButton(view, '保存配置').disabled, false);
  assert.equal(view.harness.calls.filter(call => call.name === 'saveModelConfig').length, 1);
});

test.after(async () => {
  await window.happyDOM.abort();
  window.close();
});
