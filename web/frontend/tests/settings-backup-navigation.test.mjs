import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { tsModuleUrl } from './load-ts.mjs';
import { selectOption, optionValues } from './select-helpers.mjs';

// Actual SettingsPanel, model picker, shared Select and provider fields; other
// cards and APIs are stubs. This verifies React behavior, not browser/backend.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.Event = window.Event;
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
  else if (specifier === './settings/ModelAvailabilityPanel') target = await tsModuleUrl(new URL('../src/components/settings/ModelAvailabilityPanel.tsx', import.meta.url));
  else if (specifier === '../hooks/useModelAvailability') target = await tsModuleUrl(new URL('../src/hooks/useModelAvailability.ts', import.meta.url));
  else if (specifier === './ui/Select') target = await tsModuleUrl(new URL('../src/components/ui/Select.tsx', import.meta.url));
  else if (specifier === './settings/AppearanceSettings') target = await tsModuleUrl(new URL('../src/components/settings/AppearanceSettings.tsx', import.meta.url));
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
      fetchHarnessSettings: { runtime: 'openclaw' },
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
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/api/settings/models/probe') && Object.hasOwn(harness.responses, 'probeModel')) {
      const payload = JSON.parse(init.body);
      harness.calls.push({name:'probeModel', args:[payload]});
      const response = harness.responses.probeModel;
      const result = typeof response === 'function' ? await response(payload) : response;
      return {ok:result.httpOk !== false,status:result.httpOk === false?503:200,json:async()=>result};
    }
    networkCalls++; throw new Error('No network allowed');
  });
  window.localStorage.clear();
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
  const render = async (navigationKey, conversationBackup = props, initialSection = 'backup') => act(async () => root.render(createElement(SettingsPanel, { initialSection: initialSection === 'default' ? undefined : initialSection, navigationKey, conversationBackup, demoDataPreference, onOpenOffice: () => { harness.officeOpens++; } })));
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
  assert.match(selected?.textContent, /^视频生成/);
  assert.ok(view.container.querySelector('.snav[aria-current="page"]')?.textContent.includes('模型'));
  assert.ok(view.harness.calls.some(call => call.name === 'fetchModelChannels'));
});

test('system group exposes backup and storage, and returning preserves callbacks', async t => {
  const view = await fixture(t);
  assert.equal(view.nav('系统与数据').getAttribute('aria-current'), 'page');
  assert.ok(view.container.querySelector('[data-testid="backup-card"]'));
  assert.ok(view.container.querySelector('[data-testid="backup-card"]').closest('details').open, 'backup deep link opens the destination');
  assert.deepEqual(view.harness.backupProps, view.props);
  await view.click(view.nav('模型与渠道'));
  assert.equal(view.container.querySelector('[data-testid="backup-card"]'), null);
  await view.click(view.nav('系统与数据'));
  assert.ok(view.container.querySelector('[data-testid="backup-card"]'));
});

test('legacy appearance opens preferences while backups live in system settings', async t => {
  const view = await fixture(t);
  const before = view.harness.calls.length;
  await view.render(1, view.props, 'appearance');
  assert.equal(view.nav('通用偏好').getAttribute('aria-current'), 'page');
  assert.ok(view.container.querySelector('.appearance-card [role=combobox]'));
  assert.equal(view.container.querySelector('[data-testid=backup-card]'), null);
  assert.equal(view.harness.calls.length, before);
});

test('agent deep links open collaboration without replacing model configuration state', async t => {
  const view = await fixture(t);
  const before = view.harness.calls.length;
  await view.click(view.nav('模型与渠道'));
  assert.equal(view.container.querySelector('.agent-runtime-panel').hidden, true);
  await view.render(1, view.props, 'agent-runtime');
  assert.equal(view.nav('Agent 与办公室').getAttribute('aria-current'), 'page');
  assert.equal(view.container.querySelector('.agent-runtime-panel').hidden, false);
  assert.equal(view.harness.calls.length, before);
});

test('fresh backup navigation restores destination and latest callbacks without losing channel state', async t => {
  const view = await fixture(t);
  await view.click(view.nav('模型与渠道'));
  const speech = [...view.container.querySelectorAll('.tab')].find(button => button.textContent.startsWith('文字配音'));
  await view.click(speech);
  const latest = { ...view.props, onExport: () => 'latest callback' };
  const before = view.harness.calls.length;
  await view.render(0, latest);
  assert.equal(view.container.querySelector('[data-testid="backup-card"]'), null);
  await view.render(1, latest);
  assert.ok(view.container.querySelector('[data-testid="backup-card"]'));
  assert.equal(view.harness.backupProps.onExport, latest.onExport);
  await view.click(view.nav('模型与渠道'));
  assert.match(view.container.querySelector('.tab.active').textContent, /^文字配音/);
  assert.equal(view.harness.calls.length, before);
});

test('office appearance is reachable from the Agent group and legacy employee links still work', async t => {
  const view = await fixture(t);
  const before = view.harness.calls.length;
  await view.click(view.nav('Agent 与办公室'));
  await view.click([...view.container.querySelectorAll('.settings-local-nav button')].find(b => b.textContent === '角色形象'));
  assert.ok(view.container.querySelector('[data-testid="employee-settings"]'));
  assert.equal(view.harness.employeeProps.defaultModelLabel, '尚未设置');
  await act(async () => view.harness.employeeProps.onOpenOffice());
  assert.equal(view.harness.officeOpens, 1);
  await act(async () => view.harness.employeeProps.onOpenModels());
  assert.equal(view.nav('模型与渠道').getAttribute('aria-current'), 'page');
  assert.match(view.container.querySelector('.tab.active').textContent, /^聊天与写作/);
  await view.render(1, view.props, 'employees');
  assert.ok(view.container.querySelector('[data-testid="employee-settings"]'));
  assert.equal(view.harness.calls.length, before);
});

test('settings defaults to models and demo management is grouped with system data', async t => {
  const view = await fixture(t);
  await view.render(1, view.props, 'default');
  assert.equal(view.nav('模型与渠道').getAttribute('aria-current'), 'page');
  await view.click(view.nav('系统与数据'));
  assert.ok(view.container.querySelector('[data-testid="demo-settings"]'));
  assert.deepEqual(view.harness.demoProps, view.demoDataPreference);
});

function notificationConfig(onDone = false) {
  const config = { EASEL_NOTIFY_EMAIL: 'saved@example.test', EASEL_NOTIFY_SMTP_HOST: 'smtp.example.test', EASEL_NOTIFY_ON_DONE: onDone ? '1' : '0' };
  return { apiSpec: { providers: [{ keys: Object.entries(config).map(([env, masked]) => ({ env, masked })) }] } };
}

test('legacy image links and image tab open a single channel form', async t => {
  const view = await fixture(t);
  await view.render(1, view.props, 'image');
  assert.equal(view.nav('模型与渠道').getAttribute('aria-current'), 'page');
  assert.equal(view.nav('生图通道'), undefined);
  assert.equal(view.nav('通用设置'), undefined);
  assert.match(view.container.querySelector('.tab.active').textContent, /^图片生成/);
  assert.equal(view.container.querySelectorAll('[aria-label="生图模型名称"]').length, 1);
  assert.equal(view.container.querySelector('.settings-actions').textContent.trim(), '');
  await view.click(view.nav('通用偏好'));
  await view.click(view.nav('模型与渠道'));
  assert.ok(view.container.querySelector('[aria-label="生图模型名称"]'));
});

test('image settings save model with the channel once and preserve an existing key', async t => {
  const view = await fixture(t, {
    fetchImagegenGallery: { channel: { baseUrl:'https://image.example.test/v1', keyMasked:'已保存', model:'image-a' } },
    saveImagegenChannel: { ok:true },
  });
  await view.render(1, view.props, 'image');
  const model = view.container.querySelector('[aria-label="生图模型名称"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(model, 'image-b');
    model.dispatchEvent(new window.Event('input', { bubbles:true }));
  });
  const save = [...view.container.querySelectorAll('button')].find(button=>button.textContent==='保存生图通道');
  await act(async () => { save.click(); save.click(); });
  assert.deepEqual(view.harness.calls.filter(call=>call.name==='saveImagegenChannel'), [
    { name:'saveImagegenChannel', args:['https://image.example.test/v1', '', 'image-b'] },
  ]);
  assert.equal(view.harness.calls.some(call=>call.name==='saveImagegenModel'), false);
  assert.equal(model.value, 'image-b');
  assert.match(view.container.textContent, /已保存/);
});

test('image model discovery stays in the model field, uses the dedicated slot and preserves manual input', async t => {
  let reads=0;
  const view=await fixture(t,{fetchImagegenGallery:{channel:{baseUrl:'https://image.test/v1',model:'saved-image',keyMasked:'fixture***'}},discoverModels:()=>({ok:true,kind:'ok',models:++reads===1?[]:['image-a','image-b'],message:'Synthetic catalog',fetchedAt:123,keySource:'saved'})});
  await view.render(1,view.props,'image');
  const button=()=>view.container.querySelector('[aria-label="获取生图模型"]');
  await view.click(button());assert.match(view.container.textContent,/可手动填写模型后保存/);
  await view.click(button());
  const select=view.container.querySelector('[aria-label="获取的生图模型"]');
  assert.ok(select.closest('.model-fetch'));
  await selectOption(select,'image-b');
  await view.click(findButton(view,'手动输入'));
  assert.equal(view.container.querySelector('[aria-label="生图模型名称"]').value,'image-b');
  const payload=view.harness.calls.find(call=>call.name==='discoverModels').args[0];
  assert.deepEqual(payload,{channel:'image',slot:'imagegen',baseUrl:'https://image.test/v1',apiKey:'',protocol:'openai'});
  assert.equal(view.harness.calls.some(call=>['saveImagegenChannel','probeModel','saveModelConfig'].includes(call.name)),false);
});

test('changing image credentials invalidates a late model list and requires a new key for a new address', async t => {
  let finish;
  const view=await fixture(t,{fetchImagegenGallery:{channel:{baseUrl:'https://image.test/v1',model:'saved-image',keyMasked:'fixture***'}},discoverModels:()=>new Promise(resolve=>{finish=resolve;})});
  await view.render(1,view.props,'image');await view.click(view.container.querySelector('[aria-label="获取生图模型"]'));
  const input=view.container.querySelector('[aria-label="生图 Base URL"]');
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'https://new.test/v1');input.dispatchEvent(new window.Event('input',{bubbles:true}));});
  await act(async()=>finish({ok:true,models:['OLD-CATALOG'],message:'old',fetchedAt:123,keySource:'saved'}));
  assert.equal(view.container.querySelector('[aria-label="获取的生图模型"]'),null);
  assert.equal(view.container.querySelector('[aria-label="获取生图模型"]').disabled,true);
  assert.doesNotMatch(view.container.textContent,/OLD-CATALOG/);
});

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
const findButton = (view, text) => [...view.container.querySelectorAll('button')].find(button => button.textContent.trim() === text || (button.classList.contains('tab') && button.textContent.startsWith(text)));

async function removeProvider(view, index) {
  await view.click(view.container.querySelectorAll('.provider-more-trigger')[index]);
  const action = document.querySelector('.provider-actions-menu [role=menuitem]');
  assert.match(action.textContent, /删除供应商/);
  await view.click(action);
}

test('provider ellipsis opens a focused menu, Escape restores focus and outside click dismisses it', async t => {
  const view = await fixture(t, { fetchModelChannels: modelChannels(configuredRows()) });
  await view.render(1, view.props, 'model');
  const trigger = view.container.querySelector('.provider-more-trigger');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
  assert.equal(document.querySelector('[role=menuitem]'), null);
  await act(async () => trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true, cancelable:true })));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, document.querySelector('.provider-actions-menu [role=menuitem]'));
  await act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true })));
  assert.equal(document.querySelector('.provider-actions-menu'), null);
  assert.equal(document.activeElement, trigger);
  await view.click(trigger);
  await act(async () => document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles:true })));
  assert.equal(document.querySelector('.provider-actions-menu'), null);
  assert.equal(view.harness.calls.some(call => call.name === 'saveModelConfig'), false);
});

test('empty unsaved suppliers can be removed individually without deleting saved providers', async t => {
  const view = await fixture(t, { fetchModelChannels: modelChannels(configuredRows()) });
  await view.render(1, view.props, 'model');
  await view.click(findButton(view, '添加供应商'));
  await view.click(findButton(view, '添加供应商'));
  assert.equal(view.container.querySelectorAll('.provider-card').length, 4);
  await removeProvider(view, 3);
  assert.equal(view.container.querySelectorAll('.provider-card').length, 3);
  await removeProvider(view, 2);
  assert.equal(view.container.querySelectorAll('.provider-card').length, 2);
  assert.match(view.container.textContent, /已移除未保存的供应商/);
  assert.equal(view.harness.calls.some(call => call.name === 'saveModelConfig'), false);
  assert.equal(findButton(view, '保存全部修改').disabled, true);
});

test('deleting the default supplier is a draft and saving sends its slot with the surviving default', async t => {
  let saved = configuredRows();
  const view = await fixture(t, {
    fetchModelChannels: () => modelChannels(saved),
    saveModelConfig: (_channel, rows) => {
      saved = rows.map(row => ({ ...configuredRows().find(item => item.slot === row.slot), ...row, role:row.primary ? '主' : '备' }));
      return { ...modelChannels(saved), ok:true };
    },
  });
  await view.render(1, view.props, 'model');
  await removeProvider(view, 0);
  assert.equal(view.container.querySelectorAll('.provider-card').length, 1);
  assert.match(view.container.textContent, /点击“保存全部修改”后生效/);
  assert.equal(view.harness.calls.some(call => call.name === 'saveModelConfig'), false);
  await view.click(findButton(view, '保存全部修改'));
  const [channel, rows, deleted] = view.harness.calls.find(call => call.name === 'saveModelConfig').args;
  assert.equal(channel, 'chat'); assert.deepEqual(deleted, ['openai']);
  assert.equal(rows.length, 1); assert.equal(rows[0].slot, 'anthropic'); assert.equal(rows[0].primary, true);
  assert.equal(findButton(view, '保存全部修改').disabled, true);
});

test('deleting an edited custom supplier uses its saved identity and leaves no resurrected provider on retry', async t => {
  const custom = { ...configuredRows()[0], slot:'custom', providerId:'saved-name', name:'saved-name', deletable:true };
  let attempts = 0;
  const view = await fixture(t, {
    fetchModelChannels: modelChannels([custom]),
    saveModelConfig: () => { if (++attempts === 1) throw new Error('保存失败：模拟离线'); return { ...modelChannels([]), ok:true }; },
  });
  await view.render(1, view.props, 'model');
  const name = view.container.querySelector('input[aria-label="供应商名称"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(name, 'draft-name');
    name.dispatchEvent(new window.Event('input', { bubbles:true }));
  });
  await removeProvider(view, 0);
  await view.click(findButton(view, '保存全部修改'));
  assert.match(view.container.textContent, /保存失败/);
  assert.equal(findButton(view, '保存全部修改').disabled, false);
  await view.click(findButton(view, '保存全部修改'));
  const calls = view.harness.calls.filter(call => call.name === 'saveModelConfig');
  assert.equal(calls.length, 2);
  for (const call of calls) assert.deepEqual(call.args, ['chat', [], ['saved-name'], []]);
  assert.match(view.container.textContent, /当前未配置对话渠道/);
  assert.equal(findButton(view, '保存全部修改').disabled, true);
});

test('every chat channel exposes its protocol and saves an explicit keyboard selection as a draft', async t => {
  const rows = [...configuredRows(),
    { ...configuredRows()[1], slot: 'relay', name: 'DeepSeek' },
    { ...configuredRows()[0], slot: 'custom', name: 'my-channel' }];
  let savedRows = rows;
  const view = await fixture(t, {
    fetchModelChannels: () => modelChannels(savedRows),
    saveModelConfig: async (_channel, saved) => {
      savedRows = saved.map((row, i) => ({ ...rows[i], ...row }));
      return { ...modelChannels(savedRows), ok: true };
    },
  });
  await view.render(1, view.props, 'model');
  const selectors = view.container.querySelectorAll('[aria-label="请求协议"]');
  assert.equal(selectors.length, 4);
  assert.deepEqual(await optionValues(selectors[2]), ['openai', 'openai-responses', 'anthropic']);
  for (const key of ['ArrowDown', 'Home', 'Enter']) await act(async () => selectors[2].dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
  assert.equal(selectors[2].textContent, 'OpenAI Chat Completions');
  assert.equal(view.harness.calls.some(call => ['saveModelConfig', 'discoverModels', 'runChannelSelftest'].includes(call.name)), false);
  await view.click(findButton(view, '保存全部修改'));
  const payload = view.harness.calls.find(call => call.name === 'saveModelConfig').args;
  assert.equal(payload[0], 'chat');
  assert.equal(payload[1][2].protocol, 'openai');
  assert.equal(payload[1][1].protocol, 'anthropic');
  assert.equal(view.container.querySelectorAll('[aria-label="请求协议"]')[2].textContent, 'OpenAI Chat Completions');
  assert.equal(findButton(view, '保存全部修改').disabled, true);
});

test('protocol changes invalidate old discovery and query the exact custom channel with the draft protocol', async t => {
  const rows = [{ ...configuredRows()[0], slot: 'custom', name: 'deepseek' }];
  const view = await fixture(t, {
    fetchModelChannels: modelChannels(rows),
    discoverModels: { ok: true, kind: 'models', models: ['old-catalog-model'], source: rows[0].baseUrl, fetchedAt: 123, keySource: 'saved', message: 'Synthetic list' },
  });
  await view.render(1, view.props, 'model');
  await view.click(findButton(view, '获取模型列表'));
  assert.ok(view.container.querySelector('[aria-label="获取的可用模型"]'));
  await selectOption(view.container.querySelector('[aria-label="请求协议"]'), 'anthropic');
  assert.equal(view.container.querySelector('[aria-label="获取的可用模型"]'), null);
  await view.click(findButton(view, '获取模型列表'));
  assert.deepEqual(view.harness.calls.filter(call => call.name === 'discoverModels').at(-1).args[0], {
    channel: 'chat', slot: 'deepseek', baseUrl: rows[0].baseUrl, apiKey: '', protocol: 'anthropic',
  });
  assert.equal(view.harness.calls.some(call => ['saveModelConfig', 'runChannelSelftest'].includes(call.name)), false);
});

test('gateway-owned and unknown protocols show truthful state without a silent OpenAI fallback', async t => {
  const rows = [
    { ...configuredRows()[0], protocol: 'openai', protocolEditable: false, protocolNote: '请在网关配置中修改上游协议。' },
    { ...configuredRows()[1], protocol: 'google-generative-ai', type: 'google-generative-ai' },
    { ...configuredRows()[1], slot: 'relay', protocol: 'openai-responses', type: 'openai-responses' },
  ];
  const view = await fixture(t, { fetchModelChannels: modelChannels(rows) });
  await view.render(1, view.props, 'model');
  const selectors = view.container.querySelectorAll('[aria-label="请求协议"]');
  assert.equal(selectors[0].disabled, true);
  assert.match(view.container.textContent, /请在网关配置中修改上游协议/);
  assert.equal(selectors[1].textContent, 'google-generative-ai（当前配置）');
  assert.equal(selectors[2].textContent, 'OpenAI Responses');
  await selectOption(selectors[2], 'anthropic');
  assert.equal(selectors[2].textContent, 'Anthropic Messages');
});
async function chooseLastModel(view) {
  await view.click([...view.container.querySelectorAll('.provider-default-action')].at(-1));
}

test('known context reference fills only on request, keeps manual values and hides after a model change', async t => {
  const rows = configuredRows().map(row => ({ ...row, model: 'glm-5.3', contextWindow: null,
    contextReference: { modelId: 'glm-5.3', tokens: 1048576, label: '1M', source: '智谱', url: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3', note: '渠道限制需核验' } }));
  const view = await fixture(t, { fetchModelChannels: modelChannels(rows) });
  await view.render(1, view.props, 'model');
  await view.click(view.container.querySelector('.model-provider-editors').closest('details').querySelector('summary'));
  await view.click(view.container.querySelector('.provider-toggle'));
  const input = () => view.container.querySelector('[aria-label="上下文窗口（Token）"]');
  assert.equal(input().value, '');
  await view.click(findButton(view, '填入参考值，保存后生效'));
  assert.equal(input().value, '1048576');
  const card = view.container.querySelector('.provider-card');
  assert.equal([...card.querySelectorAll('button')].some(button => button.textContent.includes('填入参考值')), false);
  assert.equal(view.harness.calls.some(call => call.name === 'saveModelConfig'), false, 'filling is a draft, never an automatic configuration write');
  const model = view.container.querySelector('input[aria-label="模型名称"]');
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(model, 'custom-alias'); model.dispatchEvent(new window.Event('input', { bubbles: true })); });
  assert.equal(input().value, '');
  assert.doesNotMatch(card.textContent, /原厂参考：1M/);
});

test('custom context budgets validate before saving, serialize clearing and reset on model changes', async t => {
  const rows = configuredRows().map(row => ({ ...row, contextWindow: 32768 }));
  const view = await fixture(t, {
    fetchModelChannels: modelChannels(rows),
    saveModelConfig: async (_channel, saved) => ({ ...modelChannels(saved.map((row, i) => ({ ...rows[i], ...row }))), ok: true }),
  });
  await view.render(1, view.props, 'model');
  const details = view.container.querySelector('.model-provider-editors').closest('details');
  await view.click(details.querySelector('summary'));
  await view.click(view.container.querySelector('.provider-toggle'));
  const input = () => view.container.querySelector('[aria-label="上下文窗口（Token）"]');
  const change = async (element, value) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.equal(input().value, '32768');
  await change(input(), '1');
  await view.click(findButton(view, '保存全部修改'));
  assert.match(view.container.textContent, /1024–10000000/);
  assert.equal(view.harness.calls.some(call => call.name === 'saveModelConfig'), false);
  await change(input(), '131072');
  await view.click(findButton(view, '保存全部修改'));
  assert.equal(view.harness.calls.find(call => call.name === 'saveModelConfig').args[1][0].contextWindow, 131072);
  await change(input(), '');
  await view.click(findButton(view, '保存全部修改'));
  assert.equal(view.harness.calls.filter(call => call.name === 'saveModelConfig').at(-1).args[1][0].contextWindow, null);
  await change(input(), '65536');
  const model = view.container.querySelector('input[aria-label="模型名称"]');
  await change(model, 'new-model');
  assert.equal(input().value, '');
});

test('row default button saves only that supplier, retains other drafts and import stays reachable', async t => {
  const original = configuredRows();
  const saved = original.map((row, index) => ({...row, role:index === 1 ? '主' : '备'}));
  const view = await fixture(t, {fetchModelChannels:modelChannels(original), fetchImportSources:{sources:[]}, saveModelConfig:{...modelChannels(saved),ok:true}});
  await view.render(1,view.props,'model');
  assert.equal(view.container.querySelector('.model-config-picker'),null);
  assert.equal(view.container.querySelector('.model-provider-editors').closest('details').open,true);
  const first=view.container.querySelector('[aria-label="模型名称"]');
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(first,'other-draft');first.dispatchEvent(new window.Event('input',{bubbles:true}));});
  await chooseLastModel(view);
  const call=view.harness.calls.find(call=>call.name==='saveModelConfig');
  assert.equal(call.args[1].length,1);assert.equal(call.args[1][0].slot,'anthropic');assert.equal(call.args[1][0].primary,true);
  assert.equal(first.value,'other-draft');
  assert.equal(view.container.querySelectorAll('.provider-default-action')[1].textContent,'默认模型');
  await view.click(findButton(view,'导入已有配置'));await view.click(findButton(view,'收起导入'));
  assert.equal(view.container.querySelector('[aria-label="模型名称"]').value,'other-draft');
});

test('default save failure preserves the draft and retry shows the actual server default and note', async t => {
  let attempts=0;
  const rows=configuredRows();
  const saved=rows.map((row,i)=>({...row,role:i===1?'主':'备',...(i===1?{model:'server-model-b'}:{})}));
  const view=await fixture(t,{fetchModelChannels:modelChannels(rows),saveModelConfig:()=>{if(++attempts===1)throw Error('synthetic save failure');return {...modelChannels(saved),ok:true,note:'网关尚未确认重新加载'};}});
  await view.render(1,view.props,'model');await chooseLastModel(view);
  assert.match(view.container.textContent,/保存失败：synthetic save failure/);
  assert.equal(view.container.querySelectorAll('[aria-label="模型名称"]')[1].value,'model-b');
  await chooseLastModel(view);
  assert.equal(view.container.querySelectorAll('[aria-label="模型名称"]')[1].value,'server-model-b');
  assert.match(view.container.textContent,/网关尚未确认重新加载/);
  assert.equal(view.harness.calls.filter(call=>call.name==='saveModelConfig').length,2);
});

test('import writes a channel directly, reports the actual default and preserves other provider drafts', async t => {
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
  await view.click(findButton(view, '导入已有配置'));
  await view.click(findButton(view, '2. 读取可导入渠道'));
  assert.equal(view.harness.calls.some(call => call.name === 'applyImport'), false);
  assert.equal(view.container.querySelector('.ii-ov'), null, 'replacement preview lines are gone');
  assert.equal(view.container.querySelector('.model-inline-import input[type="checkbox"]'), null, 'import applies directly without a separate selection checkbox');
  await view.click(findButton(view, '导入'));
  const apply = view.harness.calls.find(call => call.name === 'applyImport');
  assert.deepEqual(apply.args, ['cc-switch', 'source-entry', 'openai', 'synthetic-source.db', 'synthetic-preview-token', 'imported-model-a']);
  assert.match(view.container.querySelector('.import-msg').textContent, /已保存默认现为：OpenAI · imported-model-a/);
  assert.match(view.container.querySelector('.import-msg').textContent, /尚未进行真实调用测活/);
  await view.click(findButton(view, '收起导入'));
  assert.match(view.container.querySelector('.provider-chat-catalog').textContent, /imported-model-a/);
  assert.equal(view.container.querySelectorAll('input[aria-label="模型名称"]')[1].value, 'unsaved-model-b');
  assert.equal(findButton(view, '保存全部修改').disabled, false);
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
  assert.match(card.textContent, /保存后加入：catalog-second/);
  assert.match(view.container.querySelector('.provider-default-action').textContent, /默认模型|设为默认/);
  assert.equal(findButton(view, '保存全部修改').disabled, false);
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
  assert.equal([...view.container.querySelectorAll('button[aria-label^="检测"]')].every(button => button.disabled), true);
  assert.match(view.container.textContent, /先填写 API Key，或从配置导入/);
  assert.equal(view.harness.calls.some(call => call.name === 'discoverModels'), false);
});

test('compact supplier availability check runs immediately with built-in defaults, reports failure and retries', async t => {
  const rows = configuredRows();
  let finish;
  let reads = 0;
  const view = await fixture(t, { fetchModelChannels: modelChannels(rows), probeModel: () => {
    reads++;
    return new Promise(resolve => { finish = resolve; });
  } });
  await view.render(1, view.props, 'model');
  const card = view.container.querySelector('.provider-card');
  const check = card.querySelector('button[aria-label^="检测"]');
  assert.equal(reads, 0);
  assert.match(check.title, /内置参数/);
  await view.click(check);
  assert.equal(check.disabled, true);
  assert.equal(check.getAttribute('aria-busy'), 'true');
  assert.match(card.querySelector('[role=status]').textContent, /正在检测文本可用性/);
  assert.equal(card.querySelector('.provider-body').hidden, true);
  const result = { modelRef: `${rows[0].slot}/${rows[0].model}`, mode:'text', testedAt:123 };
  assert.deepEqual(view.harness.calls.find(call => call.name === 'probeModel').args[0], {modelRef:result.modelRef,mode:'text',prompt:'请只回复：连接成功'});
  await act(async () => finish({ ...result, state:'failed', detail: 'Synthetic HTTP 401' }));
  assert.match(card.querySelector('[role=status]').textContent, /文本检测未通过.*HTTP 401/);
  assert.equal(check.disabled, false);
  await view.click(check);
  await act(async () => finish({ ...result, state:'success', detail: '已收到非空文本响应。' }));
  assert.match(card.querySelector('[role=status]').textContent, /文本检测通过.*非空文本响应/);
  assert.equal(reads, 2);
  assert.equal(card.querySelector('.provider-body').hidden, true);
  assert.equal(view.harness.calls.some(call => ['saveModelConfig', 'runChannelSelftest', 'discoverModels'].includes(call.name)), false);
});

test('optional defaults remain separate from providers and change one-click checks only after saving', async t => {
  const rows = configuredRows();
  const view = await fixture(t, { fetchModelChannels:modelChannels(rows), probeModel: payload => ({...payload,state:'success',detail:'Synthetic model response',testedAt:123}) });
  await view.render(1,view.props,'model');
  const section = [...view.container.querySelectorAll('details.model-settings-details')].find(details => details.querySelector('summary')?.textContent.includes('测试设置'));
  assert.ok(section);
  assert.equal(section.closest('.provider-card'),null);
  await act(async () => { section.open = true; section.dispatchEvent(new window.Event('toggle')); });
  assert.match(section.textContent,/无需配置检测参数/);
  assert.equal(view.harness.calls.some(call=>call.name==='probeModel'),false);
  const input = section.querySelector('textarea[aria-label="默认检测提示词"]');
  assert.equal(input.value,'请只回复：连接成功');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(input,'只回复 OK');
    input.dispatchEvent(new window.Event('input',{bubbles:true}));
  });
  const check = view.container.querySelector('.provider-card button[aria-label^="检测"]');
  await view.click(check);
  assert.equal(view.harness.calls.find(call=>call.name==='probeModel').args[0].prompt,'请只回复：连接成功');
  await view.click([...section.querySelectorAll('button')].find(button=>button.textContent==='保存默认设置'));
  assert.equal(view.harness.calls.filter(call=>call.name==='probeModel').length,1);
  assert.match(window.localStorage.getItem('easel:model-check-defaults:v1'),/只回复 OK/);
  await view.click(check);
  assert.equal(view.harness.calls.filter(call=>call.name==='probeModel')[1].args[0].prompt,'只回复 OK');
});

test('unsaved changes and late or malformed availability receipts cannot appear as a passed current model', async t => {
  let finish;
  const view = await fixture(t, {fetchModelChannels:modelChannels(configuredRows()),probeModel:()=>new Promise(resolve=>{finish=resolve;})});
  await view.render(1,view.props,'model');
  const card=view.container.querySelector('.provider-card');
  const check=card.querySelector('button[aria-label^="检测"]');
  await view.click(check);
  const input=card.querySelector('input[aria-label="模型名称"]');
  await act(async()=>{
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'unsaved-model');
    input.dispatchEvent(new window.Event('input',{bubbles:true}));
  });
  await act(async()=>finish({modelRef:'openai/model-a',mode:'text',state:'success',detail:'OLD MODEL PASSED',testedAt:123}));
  assert.equal(check.disabled,false);
  assert.match(check.title,/测试/);
  assert.doesNotMatch(card.textContent,/OLD MODEL PASSED/);
});

test('legacy import links open the single model page and expand its import workflow', async t => {
  const view = await fixture(t, { fetchImportSources: { sources: [] } });
  await view.render(1, view.props, 'import');
  assert.equal(view.nav('模型与渠道').getAttribute('aria-current'), 'page');
  assert.equal(view.nav('配置导入'), undefined);
  assert.equal(view.container.querySelector('.model-inline-import').open, true);
  assert.equal(view.container.querySelector('.model-config-picker'), null);
  assert.ok(view.container.querySelector('.model-provider-editors'));
  assert.equal(view.container.querySelectorAll('.model-import-steps').length, 1);
});

test('testing saves only the selected row, preserves other drafts and does not probe after a failed save', async t => {
  const rows = configuredRows(); let attempts=0;
  const view = await fixture(t, {fetchModelChannels:modelChannels(rows), saveModelConfig:(_channel, submitted) => {
    if (++attempts === 1) throw Error('blocked save');
    return {...modelChannels(rows.map(row => row.slot === submitted[0].slot ? {...row,...submitted[0],chatModels:[submitted[0].model]} : row)),ok:true};
  },probeModel:payload=>({...payload,state:'success',detail:'Synthetic response',testedAt:123})});
  await view.render(1,view.props,'model');
  const change=async(input,value)=>act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new window.Event('input',{bubbles:true}));});
  await change(view.container.querySelectorAll('[aria-label="模型名称"]')[0],'new-model');
  await view.click(findButton(view,'添加供应商'));
  const check=view.container.querySelector('.provider-connection-action');
  assert.equal(check.textContent,'测试');await view.click(check);
  assert.equal(view.harness.calls.filter(call=>call.name==='probeModel').length,0);
  await view.click(check);
  const calls=view.harness.calls.filter(call=>['saveModelConfig','probeModel'].includes(call.name));
  assert.deepEqual(calls.map(call=>call.name),['saveModelConfig','saveModelConfig','probeModel']);
  assert.equal(calls[1].args[1].length,1);
  assert.equal(calls[2].args[0].modelRef,'openai/new-model');
  assert.equal(view.container.querySelectorAll('.provider-card').length,3);
});

test('provider keyboard sorting and enablement remain drafts until save and retain stable card state', async t => {
  const rows=configuredRows().map(row=>({...row,providerId:row.slot,chatModels:[row.model],enabled:true}));
  const view=await fixture(t,{fetchModelChannels:modelChannels(rows),saveModelConfig:(_channel,submitted,_gone,order)=>({...modelChannels(order.map(id=>{const row=submitted.find(row=>row.slot===id);return {...rows.find(row=>row.slot===id),...row,role:row.primary?'主':'备'};})),ok:true})});
  await view.render(1,view.props,'model');
  const cards=()=>[...view.container.querySelectorAll('.provider-card')];
  await view.click(cards()[1].querySelector('.provider-toggle'));
  const handle=cards()[1].querySelector('.provider-drag-handle');handle.focus();
  await act(async()=>handle.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true})));
  assert.equal(cards()[0].dataset.providerKey,'anthropic');
  assert.equal(cards()[0].querySelector('.provider-body').hidden,false);
  assert.equal(document.activeElement,handle);
  await view.click(cards()[0].querySelector('[role=switch]'));
  assert.equal(cards()[0].classList.contains('is-disabled'),true);
  assert.equal(view.harness.calls.some(call=>call.name==='saveModelConfig'),false);
  await view.click(findButton(view,'保存全部修改'));
  const call=view.harness.calls.find(call=>call.name==='saveModelConfig');
  assert.deepEqual(call.args[3],['anthropic','openai']);assert.equal(call.args[1][0].enabled,false);
  assert.equal(cards()[0].classList.contains('is-disabled'),true);
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
  await view.click(findButton(view, '导入已有配置'));
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
  await view.click(findButton(view, '2. 读取可导入渠道'));
  await view.click(findButton(view, '获取该渠道模型'));
  assert.deepEqual(view.harness.calls.find(call => call.name === 'discoverImportModels').args, [{
    source: 'cc-switch', path: 'synthetic-source.db', id: candidate.id, slot: 'openai', previewToken: 'original-token',
  }]);
  const picker = view.container.querySelector('button[aria-label="Catalog source导入模型"]');
  for (const key of ['ArrowDown', 'End', 'Enter']) await act(async () => picker.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
  assert.match(picker.textContent, /fetched-model/);
  assert.equal(view.harness.calls.some(call => call.name === 'applyImport'), false);
  await view.click(findButton(view, '导入'));
  assert.deepEqual(view.harness.calls.find(call => call.name === 'applyImport').args, [
    'cc-switch', candidate.id, 'openai', 'synthetic-source.db', 'original-token', 'fetched-model',
  ]);
  assert.equal(view.harness.calls.some(call => ['runChannelSelftest', 'discoverModels', 'saveModelConfig', 'selectImportModel'].includes(call.name)), false);
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
  await view.click(findButton(view, '2. 读取可导入渠道'));
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
  assert.equal(cards[0].querySelector('.provider-heading small').textContent, rows[0].baseUrl);
  assert.equal(cards[0].querySelector('.provider-default-badge').textContent, '默认');
  assert.equal(cards[1].querySelector('.provider-default-badge'), null);
  const edit = cards[0].querySelector('button[aria-label^="编辑"]');
  assert.ok(edit.querySelector('svg'));
  const toggle = cards[0].querySelector('.provider-toggle');
  assert.equal(toggle.tagName, 'BUTTON');
  assert.equal(toggle.getAttribute('aria-controls'), cards[0].querySelector('.provider-body').id);
  await view.click(edit);
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
  await view.click(findButton(view, '语音转文字'));
  const cards = [...view.container.querySelectorAll('.provider-card')];
  assert.deepEqual(cards.map(card => card.querySelector('.provider-heading strong').textContent), ['自带字幕', '云端转写', '本地兜底']);
  assert.deepEqual(cards.map(card => card.querySelector('.provider-body').hidden), [true, true, true]);
  assert.equal(cards.every(card => card.querySelector('.provider-glyph svg, .provider-glyph img')), true);
  assert.match(cards[0].querySelector('.provider-head').textContent, /免配置/);
  assert.equal(cards[1].querySelector('.provider-heading small').textContent, 'https://api.example.test/v1');
  assert.match(cards[1].querySelector('.provider-body').textContent, /API Key/);
  assert.match(cards[2].querySelector('.provider-head').textContent, /云端不可用时接替/);
  assert.equal(view.container.querySelector('.step'), null);
  assert.ok(cards[1].querySelector('input[aria-label="模型名称"]'));
  assert.equal([...view.container.querySelectorAll('[role="tab"]')].every(tab => tab.querySelector('.channel-icon svg')), true);
  await view.click(cards[2].querySelector('.provider-toggle'));
  assert.match(cards[2].textContent, /无需 API Key/);
  await view.click(findButton(view, '打开环境安装'));
  assert.equal(view.nav('系统与数据').getAttribute('aria-current'), 'page');
});

for (const [channel, label] of [['speech', '文字配音'], ['video', '视频生成'], ['music', '音乐生成']]) test(`editable ${channel} models and addresses are available directly after expanding the provider`, async t => {
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
  await view.click(findButton(view, '语音转文字'));
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

test('provider pointer sorting moves stable cards and stops on pointer release',async t=>{
  const rows=configuredRows().map(row=>({...row,providerId:row.slot,enabled:true}));
  const view=await fixture(t,{fetchModelChannels:modelChannels(rows)});
  await view.render(1,view.props,'model');
  const list=view.container.querySelector('.provider-list');
  const cards=()=>[...list.querySelectorAll('.provider-card')];
  for(const card of cards()) {
    Object.defineProperty(card,'offsetTop',{configurable:true,get:()=>cards().indexOf(card)*100});
    Object.defineProperty(card,'offsetHeight',{configurable:true,get:()=>90});
  }
  const handle=cards()[0].querySelector('.provider-drag-handle');
  await act(async()=>handle.dispatchEvent(new window.PointerEvent('pointerdown',{pointerId:7,button:0,isPrimary:true,bubbles:true,cancelable:true})));
  await act(async()=>window.dispatchEvent(new window.PointerEvent('pointermove',{pointerId:7,clientY:150,cancelable:true})));
  assert.equal(cards()[1].dataset.providerKey,'openai');
  assert.equal(cards()[1].querySelector('.provider-drag-handle'),handle);
  assert.equal(cards()[1].classList.contains('is-dragging'),true);
  await act(async()=>window.dispatchEvent(new window.PointerEvent('pointerup',{pointerId:7})));
  await act(async()=>window.dispatchEvent(new window.PointerEvent('pointermove',{pointerId:7,clientY:0})));
  assert.equal(cards()[1].dataset.providerKey,'openai');
  assert.equal(list.querySelector('.is-dragging'),null);
  assert.equal(view.harness.calls.some(call=>call.name==='saveModelConfig'),false);
});

test.after(async () => {
  await window.happyDOM.abort();
  window.close();
});
