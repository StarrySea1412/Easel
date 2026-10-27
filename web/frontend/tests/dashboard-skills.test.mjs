import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { tsModuleUrl } from './load-ts.mjs';

// Real DashboardPage, ChatComposer, skill picker, guide, requirement editor and
// draft storage in jsdom. HTTP and storage failures are controlled substitutes;
// these checks do not claim browser layout, App handoff or model execution.
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} disconnect() {} };
window.matchMedia = () => ({ matches: false });
window.HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1024 });
const { createRoot } = await import('react-dom/client');

const source = new URL('../src/', import.meta.url);
const dataPrefix = 'data:text/javascript;base64,';
const modulePaths = [
  ['persistence', 'lib/localPersistence.ts'],
  ['selectedSkills', 'lib/selectedSkills.ts'],
  ['draft', 'lib/chatDrafts.ts'],
  ['dashboardDraft', 'lib/dashboardDraft.ts'],
  ['skillsHook', 'hooks/useComposerSkills.ts'],
  ['selection', 'components/ComposerSkills.tsx'],
  ['composer', 'components/ChatComposer.tsx'],
  ['dashboard', 'components/DashboardPage.tsx'],
];
const bases = Object.fromEntries(await Promise.all(modulePaths.map(async ([key, path]) => [key, await tsModuleUrl(new URL(path, source))])));
const { createLazyPage } = await import(await tsModuleUrl(new URL('lib/lazyPage.ts', source)));
let sequence = 0;

function rewrite(url, replacements, suffix) {
  let code = Buffer.from(url.slice(dataPrefix.length), 'base64').toString();
  for (const [before, after] of replacements) code = code.replaceAll(before, after);
  return dataPrefix + Buffer.from(code).toString('base64') + suffix;
}

// A fixed Dashboard scope must not leak chatDrafts' in-memory cache between
// fixtures. Rewrite each consumer as well as its dependency, just as a cold
// application load would, while remount() deliberately retains those modules.
async function freshModules() {
  const suffix = `#dashboard-skills-${++sequence}`;
  const fresh = {}, replacements = [];
  for (const [key] of modulePaths) {
    fresh[key] = rewrite(bases[key], replacements, suffix);
    replacements.push([bases[key], fresh[key]]);
  }
  return {
    draft: await import(fresh.draft),
    selectedSkills: await import(fresh.selectedSkills),
    dashboardDraft: await import(fresh.dashboardDraft),
    Dashboard: (await import(fresh.dashboard)).default,
    Composer: (await import(fresh.composer)).default,
  };
}

const scope = 'dashboard-quick';
const draftKey = id => `easel:chat-draft:${id}`;
const selectedKey = id => `easel:selected-skills:${id}`;
const requirementKey = id => `easel:skill-requirements:${id}`;
const storedDraft = text => JSON.stringify({ version: 1, text, attachmentNames: [] });
const first = { name: 'card-xiaohongshu', description: '生成小红书知识卡片', layer: 'creation', needsApi: false, apiConfigured: true };
const second = { name: 'card-quote', description: '生成横版金句卡', layer: 'creation', needsApi: false, apiConfigured: true };
const firstLabel = '小红书卡组';
const secondLabel = '金句卡 / 数据卡';
const example = '请根据实地探店记录制作一组咖啡知识卡片。';

function skillDetail(name) {
  return {
    ...(name === second.name ? second : first), name, body: '# 已安装技能的原文', apiSpec: null,
    guide: {
      what: `${name}：将有依据的素材整理成知识卡片。`,
      whenToUse: ['已经有可核实的素材时'],
      needs: { inputs: ['原始记录与出处'], api: null, media: [], accounts: [], tools: [], os: [], prep: [] },
      howToStart: ['先整理原始记录'], steps: ['核对事实后编排卡片'],
      whatYouGet: ['可编辑的卡片文案'], examples: [example], terms: [],
    },
  };
}

function initialValues({ text, skills, requirements, extra = {} }) {
  return new Map([
    ...Object.entries(extra),
    ...(text === undefined ? [] : [[draftKey(scope), storedDraft(text)]]),
    ...(skills === undefined ? [] : [[selectedKey(scope), JSON.stringify(skills)]]),
    ...(requirements === undefined ? [] : [[requirementKey(scope), JSON.stringify(requirements)]]),
  ]);
}

async function fixture(t, initial = {}) {
  const values = initialValues(initial);
  const storage = {
    values, reads: [], writes: [], failing: false, failRead: () => false, failWrite: () => false,
    getItem(key) {
      this.reads.push(key);
      if (this.failRead(key)) throw Object.assign(new Error('storage temporarily unavailable'), { name: 'SecurityError' });
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      this.writes.push([key, value]);
      if (this.failing || this.failWrite(key, value)) throw Object.assign(new Error('storage full'), { name: 'QuotaExceededError' });
      values.set(key, value);
    },
    removeItem(key) { values.delete(key); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const h = {
    accepted: true, sent: [], chatSent: [], requests: [], caughtErrors: [], catalogCalls: 0,
    trends: initial.trends ?? [], topics: [], navigations: [],
    catalog: async () => [first, second],
    onQuick: null,
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = String(url);
    h.requests.push([path, options]);
    let data;
    if (path === '/api/skills') data = await h.catalog(++h.catalogCalls);
    else if (path.startsWith('/api/skill/')) data = skillDetail(decodeURIComponent(path.split('/').at(-1)));
    else if (path.startsWith('/api/trends?')) data = { trends: h.trends, updated: 0 };
    else if (path === '/api/upload/limits') data = { max_mb: 50 };
    else if (path.startsWith('/api/agent-office/models')) data = initial.runtime === 'api' ? {available:true,scope:'next_turn',runtime:'api',currentModelRef:'direct-api/local',options:[{id:'direct-api/local',provider:'direct-api',model:'local',configured:true}]} : { available:true, scope:'next_turn', currentModelRef:initial.thinkingLevels?'fixture/model':null, options:initial.thinkingLevels?[{id:'fixture/model',provider:'fixture',model:'model',configured:true,thinkingLevels:initial.thinkingLevels}]:[] };
    else if (path === '/api/settings/models/health') data = { results:[], schedules:[] };
    else if (path.startsWith('/api/settings/models/connection?')) data = { modelRef:'fixture/model',state:'unverified',channelName:'测试渠道',detail:'仅模拟配置，不发起推理' };
    else if (path.startsWith('/api/analytics/') && path.endsWith('/snapshot')) data = {data:initial.snapshot || null,running:false};
    else if (initial.analytics && path.startsWith('/api/analytics/') && !path.endsWith('/platforms')) data = await initial.analytics(path);
    else if (path === '/api/accounts') data = initial.accounts || [];
    else if (path === '/api/analytics/platforms') data = initial.analyticsPlatforms || [];
    else if (path.startsWith('/api/accounts/') && path.includes('/whoami')) data = {loggedIn:false,name:'',avatar:'',verified:false};
    else if (['/api/schedule', '/api/outputs', '/api/ideas'].includes(path)) data = [];
    else throw new Error(`Unexpected request: ${path}`);
    return { ok: true, json: async () => data };
  });
  let modules = await freshModules();
  assert.equal(modules.dashboardDraft.DASHBOARD_DRAFT_SCOPE, scope);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container, { onCaughtError: error => h.caughtErrors.push(error) });
  let gatewayStatus = initial.gatewayStatus ?? 'connected';
  const render = async (status = gatewayStatus) => {
    gatewayStatus = status;
    await act(async () => root.render(createElement(modules.Dashboard, {
      persona: '', gatewayStatus, onNavigate: page => h.navigations.push(page), onNavigateAnalysis: initial.onNavigateAnalysis, onUseTopic: title => h.topics.push(title),
      onQuickPrompt: (...args) => {
        h.sent.push(args.slice(0,3));
        h.sentRoute = args.slice(3);
        return h.onQuick ? h.onQuick(...args) : h.accepted;
      },
    })));
  };
  const click = async element => {
    assert.ok(element, 'interaction target exists');
    await act(async () => element.click());
  };
  const typeInto = async (element, value) => {
    assert.ok(element, 'editable control exists');
    const prototype = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const key = async (element, value, init = {}) => {
    assert.ok(element, 'keyboard target exists');
    await act(async () => element.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value, ...init })));
  };
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return {
    h, storage, container, render, click, key,
    modules: () => modules,
    input: () => container.querySelector('textarea#quick-create'),
    chips: () => [...container.querySelectorAll('.composer-skill-chip')].map(chip => chip.dataset.skill),
    trigger: () => container.querySelector('button[aria-label="选择创作技能"]'),
    send: async () => click([...container.querySelectorAll('button')].find(button => button.textContent.trim() === '开始创作 →')),
    type: async value => typeInto(container.querySelector('textarea#quick-create'), value),
    open: async () => click(container.querySelector('button[aria-label="选择创作技能"]')),
    close: async () => click(document.querySelector('[aria-label="关闭技能选择"]')),
    pick: async label => click([...document.querySelectorAll('.brush-item')].find(button => button.textContent.includes(label))),
    skillButton: label => [...document.querySelectorAll('.brush-item')].find(button => button.textContent.includes(label)),
    detailTrigger: (label = firstLabel) => container.querySelector(`[aria-label="${label}技能详情与补充要求"]`),
    editRequirement: async (label = firstLabel) => { await click(container.querySelector(`[aria-label="${label}技能详情与补充要求"]`)); await click([...document.querySelectorAll('.selected-skill-popover button')].find(button => button.textContent.trim() === '编辑补充要求')); },
    typeRequirement: async value => typeInto(document.querySelector('.selected-skill-requirement-editor textarea'), value),
    requirementAction: async label => click([...document.querySelectorAll('.selected-skill-popover button')].find(button => button.textContent.trim() === label)),
    hover: async element => {
      assert.ok(element);
      await act(async () => element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: null })));
    },
    focus: async element => { assert.ok(element); await act(async () => element.focus()); },
    async waitForGuide(name = first.name) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); });
      assert.ok(h.requests.some(([path]) => path === `/api/skill/${name}`), 'guide was fetched from its real component');
      assert.match(document.body.textContent, /将有依据的素材整理成知识卡片/);
    },
    async away() { await act(async () => root.render(createElement('section', null, 'Other page'))); },
    async renderPage(element) { await act(async () => root.render(element)); },
    async remount() { await act(async () => root.render(null)); await render(); },
    async reload() { await act(async () => root.render(null)); modules = await freshModules(); await render(); },
    async renderChat(id) {
      await act(async () => root.render(createElement(modules.Composer, {
        sessionId: id, isStreaming: false, onStop() {},
        onSend: (...args) => { h.chatSent.push(args); return false; },
      })));
    },
  };
}

test('API dashboard uses its saved model without skills or effort and clears the submitted draft', async t => {
  const view = await fixture(t, {runtime:'api'});
  await view.render(); await view.type('本机快捷发送检查'); await view.send();
  assert.deepEqual(view.h.sent, [['本机快捷发送检查', [], {}]]);
  assert.deepEqual(view.h.sentRoute, [undefined, 'direct-api/local']);
  assert.equal(view.trigger(), null);
  assert.equal(view.container.querySelector('.thinking-level-trigger'), null);
  assert.equal(view.input().value, '');
});

test('Dashboard uses the actual picker, keeps existing text when choosing skills or examples, and removes picks explicitly', async t => {
  const view = await fixture(t);
  await view.render();
  assert.ok(view.trigger(), 'the skill entry is present before making any selection');
  await view.type('保留已有素材与创作目的');
  await view.open(); await view.pick(firstLabel); await view.pick(secondLabel);
  assert.deepEqual(view.chips(), [first.name, second.name]);
  assert.equal(view.input().value, '保留已有素材与创作目的');
  assert.equal(view.skillButton(firstLabel).getAttribute('aria-pressed'), 'true');
  await view.pick(secondLabel);
  assert.deepEqual(view.chips(), [first.name]);
  await view.focus(view.skillButton(firstLabel)); await view.waitForGuide();
  await view.click(document.querySelector('button.brush-guide-example'));
  assert.equal(document.querySelector('.skill-picker'), null);
  assert.equal(view.input().value, `保留已有素材与创作目的\n${example}`);
  assert.deepEqual(view.chips(), [first.name]);
  await view.click(view.container.querySelector(`[aria-label="移除技能 ${firstLabel}"]`));
  assert.deepEqual(view.chips(), []);
  assert.deepEqual(JSON.parse(view.storage.values.get(selectedKey(scope))), []);
  assert.equal(view.h.sent.length, 0);
});

test('recent outputs keeps the image studio launch inside the content card', async t => {
  const view = await fixture(t);
  await view.render();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  const launch = view.container.querySelector('.dash-studio-launch');
  assert.ok(launch, 'image studio launch is part of the dashboard content area');
  assert.equal(view.container.querySelector('.dash-studio-entry'), null, 'old detached launch is gone');
  assert.match(launch.textContent, /开始生成图片/);
  assert.match(launch.textContent, /生图工坊/);
  await view.click(launch);
  assert.deepEqual(view.h.navigations, ['image']);
});

test('click and keyboard reveal the real guide, while creation-scoped requirements save and cancel independently', async t => {
  const view = await fixture(t, { skills: [first.name], text: '准备发送的首页草稿' });
  await view.render();
  await view.hover(view.container.querySelector('.composer-skill-detail-trigger'));
  assert.equal(document.querySelector('.selected-skill-popover'), null);
  await view.click(view.detailTrigger());
  await view.waitForGuide();
  assert.match(document.querySelector('.selected-skill-popover').textContent, /本次创作补充要求/);
  assert.match(document.querySelector('.selected-skill-popover').textContent, /原始记录与出处/);
  await view.key(view.detailTrigger(), 'Escape');
  assert.equal(document.querySelector('.selected-skill-popover'), null);
  assert.equal(document.activeElement, view.detailTrigger());
  await view.focus(view.input()); await view.focus(view.detailTrigger());
  assert.equal(document.querySelector('.selected-skill-popover'), null);
  await view.click(view.detailTrigger()); await view.waitForGuide();
  await view.key(view.detailTrigger(), 'ArrowDown');
  const editor = document.querySelector('.selected-skill-requirement-editor textarea');
  assert.equal(document.activeElement, editor);
  assert.equal(document.querySelector(`label[for="${editor.id}"]`).textContent, '本次创作补充要求');
  await view.typeRequirement('  本次先核对事实，再给出卡片文案。  ');
  await view.requirementAction('保存补充要求');
  assert.ok(view.container.querySelector('[aria-label="已添加本次创作补充要求"]'));
  assert.deepEqual(JSON.parse(view.storage.values.get(requirementKey(scope))), { [first.name]: '本次先核对事实，再给出卡片文案。' });
  await view.editRequirement(); await view.typeRequirement('不应生效的未保存改动'); await view.requirementAction('取消');
  await view.editRequirement();
  assert.equal(document.querySelector('.selected-skill-requirement-editor textarea').value, '本次先核对事实，再给出卡片文案。');
  await view.requirementAction('取消');
  view.h.accepted = false;
  await view.send();
  assert.deepEqual(view.h.sent.at(-1), ['准备发送的首页草稿', [first.name], { [first.name]: '本次先核对事实，再给出卡片文案。' }]);
});

test('accepted creation sends independent snapshots and clears only Dashboard text, selection and requirements', async t => {
  const other = 'separate-chat';
  const unrelated = {
    [draftKey(other)]: storedDraft('其他会话正文'),
    [selectedKey(other)]: JSON.stringify([second.name]),
    [requirementKey(other)]: JSON.stringify({ [second.name]: '其他会话的要求' }),
  };
  const view = await fixture(t, {
    text: '  本次创作正文  ', skills: [first.name, second.name],
    requirements: { [first.name]: '仅本次使用', [second.name]: '保留引用' }, extra: unrelated,
  });
  await view.render(); await view.send();
  const snapshot = view.h.sent[0];
  assert.deepEqual(snapshot, ['本次创作正文', [first.name, second.name], { [first.name]: '仅本次使用', [second.name]: '保留引用' }]);
  assert.equal(view.input().value, '');
  assert.deepEqual(view.chips(), []);
  assert.equal(JSON.parse(view.storage.values.get(draftKey(scope))).text, '');
  assert.deepEqual(JSON.parse(view.storage.values.get(selectedKey(scope))), []);
  assert.deepEqual(JSON.parse(view.storage.values.get(requirementKey(scope))), {});
  for (const [key, value] of Object.entries(unrelated)) assert.equal(view.storage.values.get(key), value);
  await view.open(); await view.pick(firstLabel); await view.close();
  await view.editRequirement(); await view.typeRequirement('下一份独立草稿的新要求'); await view.requirementAction('保存补充要求');
  assert.deepEqual(snapshot, ['本次创作正文', [first.name, second.name], { [first.name]: '仅本次使用', [second.name]: '保留引用' }], 'later edits never mutate an accepted call');
  await view.click(view.container.querySelector(`[aria-label="移除技能 ${firstLabel}"]`));
  await view.type(''); await view.reload();
  assert.equal(view.input().value, '');
  assert.deepEqual(view.chips(), []);
  assert.deepEqual(view.modules().selectedSkills.readSkillRequirements(scope), {});
});

test('removing a skill clears only that Dashboard requirement and keeps other selected skills and conversations intact', async t => {
  const other = 'requirements-in-another-chat';
  const view = await fixture(t, {
    text: '移除后仍可发送', skills: [first.name, second.name],
    requirements: { [first.name]: '移除时应一起清除', [second.name]: '仍然有效的要求' },
    extra: {
      [selectedKey(other)]: JSON.stringify([first.name]),
      [requirementKey(other)]: JSON.stringify({ [first.name]: '另一会话不受影响' }),
    },
  });
  await view.render();
  await view.click(view.container.querySelector(`[aria-label="移除技能 ${firstLabel}"]`));
  assert.deepEqual(view.chips(), [second.name]);
  assert.deepEqual(JSON.parse(view.storage.values.get(requirementKey(scope))), { [second.name]: '仍然有效的要求' });
  assert.deepEqual(view.modules().selectedSkills.readSkillRequirements(other), { [first.name]: '另一会话不受影响' });
  await view.open(); await view.pick(firstLabel); await view.close();
  view.h.accepted = false; await view.send();
  assert.deepEqual(view.h.sent.at(-1), ['移除后仍可发送', [second.name, first.name], { [second.name]: '仍然有效的要求' }], 'reselecting a skill does not resurrect its removed note');
});

for (const outcome of ['rejected', 'thrown']) test(`${outcome} quick creation retains the complete draft through remount and cold reload`, async t => {
  const requirement = { [first.name]: '失败时仍保留的补充要求' };
  const view = await fixture(t, { text: '  未被接收的正文\n第二行  ', skills: [first.name], requirements: requirement });
  view.h.onQuick = () => { if (outcome === 'thrown') throw new Error('temporary failure'); return false; };
  await view.render(); await view.send();
  assert.deepEqual(view.h.sent, [['未被接收的正文\n第二行', [first.name], requirement]]);
  assert.equal(view.input().value, '  未被接收的正文\n第二行  ');
  assert.deepEqual(view.chips(), [first.name]);
  assert.match(view.container.textContent, /草稿(?:和技能)?已保留/);
  await view.remount(); await view.reload();
  assert.equal(view.input().value, '  未被接收的正文\n第二行  ');
  assert.deepEqual(view.chips(), [first.name]);
  assert.deepEqual(view.modules().selectedSkills.readSkillRequirements(scope), requirement);
});

test('Dashboard and a real ChatComposer restore separate drafts and requirement scopes after navigation and cold reload', async t => {
  const chat = 'existing-conversation';
  const view = await fixture(t, { extra: {
    [draftKey(chat)]: storedDraft('会话里未发的消息'),
    [selectedKey(chat)]: JSON.stringify([second.name]),
    [requirementKey(chat)]: JSON.stringify({ [second.name]: '会话自己的要求' }),
  } });
  await view.render(); await view.type('首页的独立草稿');
  await view.open(); await view.pick(firstLabel); await view.close();
  await view.editRequirement(); await view.typeRequirement('首页自己的要求'); await view.requirementAction('保存补充要求');
  await view.renderChat(chat);
  assert.equal(view.container.querySelector('textarea').value, '会话里未发的消息');
  assert.deepEqual(view.chips(), [second.name]);
  await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.deepEqual(view.h.chatSent[0], ['会话里未发的消息', [], [second.name], { [second.name]: '会话自己的要求' }, undefined]);
  await view.render();
  assert.equal(view.input().value, '首页的独立草稿');
  assert.deepEqual(view.chips(), [first.name]);
  await view.away(); await view.render(); await view.reload();
  view.h.accepted = false; await view.send();
  assert.deepEqual(view.h.sent.at(-1), ['首页的独立草稿', [first.name], { [first.name]: '首页自己的要求' }]);
  assert.equal(view.modules().draft.getChatDraft(chat).text, '会话里未发的消息');
  assert.deepEqual(view.modules().selectedSkills.readSkillRequirements(chat), { [second.name]: '会话自己的要求' });
});

test('a late empty initial catalogue cannot erase picks or requirements made through the picker', async t => {
  const view = await fixture(t);
  let finish;
  view.h.catalog = call => call === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([first, second]);
  await view.render();
  await view.type('在目录加载中编写');
  await view.open(); await view.pick(firstLabel); await view.close();
  await view.editRequirement(); await view.typeRequirement('比初次目录更新的用户选择'); await view.requirementAction('保存补充要求');
  await act(async () => finish([]));
  assert.deepEqual(view.chips(), [first.name]);
  assert.match(view.container.textContent, /已保留选择/);
  assert.deepEqual(view.modules().selectedSkills.readSkillRequirements(scope), { [first.name]: '比初次目录更新的用户选择' });
  view.h.accepted = false; await view.send();
  assert.deepEqual(view.h.sent.at(-1), ['在目录加载中编写', [first.name], { [first.name]: '比初次目录更新的用户选择' }]);
});

for (const catalogue of ['failed', 'empty']) test(`${catalogue} catalogues preserve saved Dashboard selection and requirements without mount-time writes`, async t => {
  const requirement = { [first.name]: '目录故障不应擦除' };
  const view = await fixture(t, { text: '仍可恢复的草稿', skills: [first.name], requirements: requirement });
  view.h.catalog = async () => { if (catalogue === 'failed') throw new Error('catalogue temporarily unavailable'); return []; };
  await view.render();
  assert.deepEqual(view.chips(), [first.name]);
  assert.match(view.container.textContent, /已保留/);
  assert.deepEqual(view.storage.writes, [], 'reading an incomplete catalogue is not an explicit edit');
  await view.open();
  if (catalogue === 'failed') assert.match(document.querySelector('.skill-picker').textContent, /catalogue temporarily unavailable/);
  await view.close(); await view.reload();
  assert.deepEqual(view.chips(), [first.name]);
  assert.deepEqual(view.modules().selectedSkills.readSkillRequirements(scope), requirement);
  view.h.accepted = false; await view.send();
  assert.deepEqual(view.h.sent.at(-1), ['仍可恢复的草稿', [first.name], requirement]);
});

test('temporary skill storage read failure recovers the saved picks when the catalogue becomes available', async t => {
  const requirement = { [first.name]: '重连后应恢复的要求' };
  const view = await fixture(t, { text: '服务重启期间保留的草稿', skills: [first.name], requirements: requirement });
  let unavailable = true, finishCatalogue;
  view.storage.failRead = key => unavailable && key === selectedKey(scope);
  view.h.catalog = () => new Promise(resolve => { finishCatalogue = resolve; });
  await view.render('disconnected');
  const pendingNotice = view.container.textContent;
  assert.equal(view.input().value, '服务重启期间保留的草稿');
  assert.deepEqual(view.storage.writes, [], 'an unreadable selection is never saved as an empty one');
  unavailable = false;
  await act(async () => finishCatalogue([first, second]));
  await view.render('connected');
  assert.deepEqual(view.chips(), [first.name], 'a successful catalogue load must recover the saved selection after a temporary read failure');
  assert.match(pendingNotice, /技能选择暂时无法读取/);
  assert.deepEqual(view.modules().selectedSkills.readSkillRequirements(scope), requirement);
  assert.deepEqual(view.storage.writes, [], 'recovery only reads existing values');
  await view.reload();
  assert.deepEqual(view.chips(), [first.name]);
});

test('unreadable skill selection cannot be overwritten by a new pick and recovers when the window is focused', async t => {
  const requirement = { [first.name]: '读取失败时不能覆盖的要求' };
  const view = await fixture(t, { text: '已有草稿', skills: [first.name], requirements: requirement });
  let unavailable = true;
  view.storage.failRead = key => unavailable && key === selectedKey(scope);
  await view.render(); await view.open(); await view.pick(secondLabel);
  assert.deepEqual(JSON.parse(view.storage.values.get(selectedKey(scope))), [first.name], 'do not replace an unread saved selection with only the latest click');
  assert.deepEqual(JSON.parse(view.storage.values.get(requirementKey(scope))), requirement);
  assert.deepEqual(view.storage.writes, []);
  unavailable = false;
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  assert.deepEqual(view.chips(), [first.name]);
  await view.pick(secondLabel);
  assert.deepEqual(view.chips(), [first.name, second.name]);
  assert.deepEqual(JSON.parse(view.storage.values.get(selectedKey(scope))), [first.name, second.name]);
  assert.deepEqual(JSON.parse(view.storage.values.get(requirementKey(scope))), requirement);
});

for (const failedPart of ['selection', 'requirements']) test(`unreadable Dashboard ${failedPart} blocks incomplete sends and edits until explicit recovery`, async t => {
  const requirement = { [first.name]: '恢复前不能忽略的原要求' };
  const text = '先恢复全部技能状态再发送';
  const view = await fixture(t, { text, skills: [first.name], requirements: requirement });
  const unreadableKey = failedPart === 'selection' ? selectedKey(scope) : requirementKey(scope);
  let unavailable = true;
  view.storage.failRead = key => unavailable && key === unreadableKey;
  await view.render();
  if (failedPart === 'requirements') {
    assert.deepEqual(view.chips(), [first.name], 'readable skill names remain visible while their notes are unavailable');
    await view.click(view.container.querySelector(`[aria-label="移除技能 ${firstLabel}"]`));
    assert.deepEqual(view.chips(), [first.name], 'removal cannot destroy an unread saved note');
    await view.editRequirement(); await view.typeRequirement('读取原要求失败时的新草稿');
    await view.requirementAction('保存补充要求');
    assert.match(document.querySelector('.selected-skill-error').textContent, /尚未完成保存/);
    await view.requirementAction('取消');
  }
  await view.open(); await view.pick(secondLabel); await view.close();
  await view.send(); await view.key(view.input(), 'Enter');
  assert.deepEqual(view.h.sent, [], 'no creation may silently omit unread skills or requirements');
  assert.equal(view.input().value, text);
  assert.deepEqual(JSON.parse(view.storage.values.get(selectedKey(scope))), [first.name]);
  assert.deepEqual(JSON.parse(view.storage.values.get(requirementKey(scope))), requirement);
  assert.deepEqual(view.storage.writes, []);
  const retry = () => [...view.container.querySelectorAll('button')].find(button => button.textContent === '重试恢复技能');
  await view.click(retry());
  assert.match(view.container.textContent, /技能选择暂时无法读取/);
  unavailable = false;
  await view.click(retry());
  assert.deepEqual(view.chips(), [first.name]);
  assert.equal(retry(), undefined);
  assert.deepEqual(view.storage.writes, [], 'explicit recovery does not replace saved state');
  view.h.accepted = false; await view.send();
  assert.deepEqual(view.h.sent, [[text, [first.name], requirement]]);
});

for (const failedPart of ['selection', 'requirements']) test(`unreadable conversation ${failedPart} cannot be omitted by click or Enter sends`, async t => {
  const chat = `unreadable-chat-${failedPart}`;
  const text = '会话也必须保留完整的发送要求';
  const requirement = { [first.name]: '这个会话的原要求' };
  const view = await fixture(t, { extra: {
    [draftKey(chat)]: storedDraft(text),
    [selectedKey(chat)]: JSON.stringify([first.name]),
    [requirementKey(chat)]: JSON.stringify(requirement),
  } });
  const unreadableKey = failedPart === 'selection' ? selectedKey(chat) : requirementKey(chat);
  let unavailable = true;
  view.storage.failRead = key => unavailable && key === unreadableKey;
  await view.renderChat(chat);
  const send = () => view.click(view.container.querySelector('[aria-label="发送消息"]'));
  await send(); await view.key(view.container.querySelector('textarea'), 'Enter');
  assert.deepEqual(view.h.chatSent, []);
  assert.equal(view.container.querySelector('textarea').value, text);
  assert.match(view.container.textContent, /技能选择暂时无法读取/);
  assert.deepEqual(view.storage.writes, []);
  unavailable = false;
  await send();
  assert.deepEqual(view.chips(), [first.name]);
  assert.deepEqual(view.h.chatSent, [[text, [], [first.name], requirement, undefined]], 'the first retry sends the complete recovered snapshot');
  assert.deepEqual(view.storage.writes, []);
  assert.deepEqual(JSON.parse(view.storage.values.get(requirementKey(chat))), requirement);
});

test('navigation through a rejected lazy page and its retry preserves Dashboard picks, notes and text', async t => {
  const text = '页面加载失败前保存的草稿';
  const requirement = { [first.name]: '切回工作台后继续使用的要求' };
  const view = await fixture(t, { text, skills: [first.name], requirements: requirement });
  let finishOldCatalogue;
  view.h.catalog = call => call === 1 ? new Promise(resolve => { finishOldCatalogue = resolve; }) : Promise.resolve([first, second]);
  await view.render();
  assert.deepEqual(view.chips(), [first.name]);
  let rejectPage, finishPage, loads = 0;
  const OtherPage = createLazyPage('图片工作室', () => ++loads === 1
    ? new Promise((_, reject) => { rejectPage = reject; })
    : new Promise(resolve => { finishPage = resolve; }));
  await view.renderPage(createElement(OtherPage));
  const failedImport = new Error('simulated dynamically imported module failure');
  await act(async () => rejectPage(failedImport));
  assert.match(view.container.querySelector('[role="alert"]').textContent, /图片工作室暂时无法打开/);
  assert.deepEqual(view.h.caughtErrors, [failedImport]);
  await view.click([...view.container.querySelectorAll('button')].find(button => button.textContent === '重新尝试'));
  await act(async () => finishPage({ default: () => createElement('section', null, 'Recovered page') }));
  assert.equal(view.container.textContent, 'Recovered page');
  await view.render();
  await act(async () => finishOldCatalogue([]));
  assert.equal(view.input().value, text);
  assert.deepEqual(view.chips(), [first.name]);
  assert.deepEqual(view.modules().selectedSkills.readSkillRequirements(scope), requirement);
  assert.deepEqual(view.storage.writes, [], 'unmount, error boundary retry and stale catalogue completion are never edits');
  await view.reload();
  view.h.accepted = false; await view.send();
  assert.deepEqual(view.h.sent, [[text, [first.name], requirement]]);
});

for (const action of ['保存补充要求', '清除补充要求']) test(`failed ${action} keeps the editor draft and the old active requirement until a successful retry`, async t => {
  const original = { [first.name]: '此前保存且仍生效的要求' };
  const view = await fixture(t, { text: '用于验证生效值', skills: [first.name], requirements: original });
  await view.render(); await view.editRequirement(); await view.typeRequirement('尚未保存的新要求');
  view.storage.failWrite = key => key === requirementKey(scope);
  await view.requirementAction(action);
  assert.equal(document.querySelector('.selected-skill-requirement-editor textarea').value, '尚未保存的新要求');
  assert.match(document.querySelector('.selected-skill-error').textContent, /尚未完成保存/);
  assert.deepEqual(JSON.parse(view.storage.values.get(requirementKey(scope))), original);
  await view.requirementAction('取消');
  view.h.accepted = false; await view.send();
  assert.deepEqual(view.h.sent.at(-1)[2], original);
  await view.editRequirement();
  assert.equal(document.querySelector('.selected-skill-requirement-editor textarea').value, original[first.name]);
  await view.typeRequirement('恢复存储后的要求');
  view.storage.failWrite = () => false;
  await view.requirementAction(action); await view.send();
  const expected = action === '清除补充要求' ? {} : { [first.name]: '恢复存储后的要求' };
  assert.deepEqual(view.h.sent.at(-1)[2], expected);
  assert.deepEqual(JSON.parse(view.storage.values.get(requirementKey(scope))), expected);
});

test('composition, native composing Enter, keyCode 229 and Shift+Enter never start a creation', async t => {
  const view = await fixture(t, { text: '中文输入法候选', skills: [first.name], requirements: { [first.name]: '一起保留' } });
  await view.render();
  const input = view.input();
  await view.key(input, 'Enter', { isComposing: true });
  await view.key(input, 'Enter', { keyCode: 229 });
  await view.key(input, 'Enter', { shiftKey: true });
  await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
  await view.key(input, 'Enter');
  assert.equal(view.h.sent.length, 0);
  assert.equal(view.input().value, '中文输入法候选');
  assert.deepEqual(view.chips(), [first.name]);
  await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
  await view.key(input, 'Enter');
  assert.deepEqual(view.h.sent, [['中文输入法候选', [first.name], { [first.name]: '一起保留' }]]);
});

for (const gatewayStatus of ['connecting', 'disconnected', 'error']) test(`${gatewayStatus} gateway blocks both click and Enter without losing the draft`, async t => {
  const requirement = { [first.name]: '连接恢复后沿用' };
  const view = await fixture(t, { gatewayStatus, text: '等待连接的草稿', skills: [first.name], requirements: requirement });
  await view.render(); await view.send(); await view.key(view.input(), 'Enter');
  assert.deepEqual(view.h.sent, []);
  assert.equal(view.input().value, '等待连接的草稿');
  assert.deepEqual(view.chips(), [first.name]);
  await view.reload();
  assert.equal(view.input().value, '等待连接的草稿');
  assert.deepEqual(view.modules().selectedSkills.readSkillRequirements(scope), requirement);
  await view.render('connected'); await view.send();
  assert.deepEqual(view.h.sent, [['等待连接的草稿', [first.name], requirement]]);
});

for (const failedPart of ['text', 'skills', 'requirements']) test(`failed ${failedPart} persistence during accepted cleanup is reported without claiming the full draft was saved empty`, async t => {
  const text = '已经交给新会话的正文';
  const requirement = { [first.name]: '已经移交的要求' };
  const view = await fixture(t, { text, skills: [first.name], requirements: requirement });
  const original = new Map(view.storage.values);
  const failedKey = { text: draftKey(scope), skills: selectedKey(scope), requirements: requirementKey(scope) }[failedPart];
  view.h.onQuick = () => {
    view.storage.failWrite = key => key === failedKey;
    return true;
  };
  await view.render(); await view.send();
  assert.deepEqual(view.h.sent, [[text, [first.name], requirement]]);
  assert.equal(view.input().value, '');
  assert.deepEqual(view.chips(), []);
  assert.match(view.modules().draft.getChatDraft(scope).error, /创作已开始，但浏览器未能保存工作台草稿的清理/);
  assert.match(view.container.textContent, /创作已开始，但浏览器未能保存工作台草稿的清理/);
  assert.equal(view.storage.values.get(failedKey), original.get(failedKey), 'the failed cleanup did not reach browser storage');
  assert.equal(view.modules().dashboardDraft.isDashboardDraftTextCleared(), failedPart !== 'text', 'the text receipt alone cannot prove that all three parts were cleared');
  for (const [key, emptyValue] of [[draftKey(scope), storedDraft('')], [selectedKey(scope), '[]'], [requirementKey(scope), '{}']]) {
    if (key !== failedKey) assert.equal(view.storage.values.get(key), emptyValue, 'independent successful writes remain saved');
  }
});

test('Dashboard trends show five topics per source with identifying icons and preserve full topic actions', async t => {
  const fetchedAt = 1791952080;
  const trends = ['weibo', 'douyin'].map((platform, index) => ({
    platform, label: index === 0 ? '微博' : '抖音', fetchedAt, status: index === 0 ? 'cached' : 'stale',
    items: Array.from({ length: 6 }, (_, rank) => ({ title: `${platform} ${rank + 1} 完整热点标题`, url: 'https://example.test/topic' })),
    ...(index === 1 ? { error: { message: '来源暂不可用，保留上次结果' } } : {}),
  }));
  const view = await fixture(t, { trends });
  await view.render();
  const card = view.container.querySelector('[aria-label="今日热点"]');
  assert.ok(view.h.requests.some(([path]) => path === '/api/trends?platforms=weibo%2Cdouyin&limit=5'));
  for (const group of trends) {
    const section = card.querySelector(`[aria-label="${group.label}热点"]`);
    const buttons = section.querySelectorAll('.dash-trend-title');
    assert.equal(buttons.length, 5);
    assert.ok(section.querySelector(`img[alt="${group.label}标志"]`).getAttribute('src'));
    assert.equal(section.querySelector('time').dateTime, new Date(fetchedAt * 1000).toISOString());
    assert.match(section.textContent, group.status === 'cached' ? /缓存/ : /上次可用/);
    assert.ok(!section.textContent.includes(group.items[5].title));
    assert.match(buttons[4].getAttribute('title'), new RegExp(group.items[4].title));
    await view.focus(buttons[4]);
    assert.equal(document.activeElement, buttons[4]);
    await view.click(buttons[4]);
  }
  assert.deepEqual(view.h.topics, trends.map(group => group.items[4].title));
  assert.match(card.textContent, /来源暂不可用，保留上次结果/);
  await view.click(card.querySelector('.dash-more'));
  assert.deepEqual(view.h.navigations, ['trends']);
});

test('Dashboard trends keep each source error visible when every source is empty and preserve the empty-state action', async t => {
  const trends = [
    { platform: 'weibo', label: '微博', items: [], error: { message: '微博来源限流' } },
    { platform: 'douyin', label: '抖音', items: [], error: { message: '抖音来源连接失败' } },
  ];
  const view = await fixture(t, { trends });
  await view.render();
  const card = () => view.container.querySelector('[aria-label="今日热点"]');
  for (const group of trends) assert.equal(card().querySelector(`[aria-label="${group.label}热点"] [role="status"]`).textContent, group.error.message);
  assert.ok(!card().textContent.includes('暂无可用热点'));
  view.h.trends = [];
  await view.remount();
  assert.match(card().textContent, /暂无可用热点/);
  await view.click([...card().querySelectorAll('button')].find(button => button.textContent === '查看热点雷达'));
  assert.deepEqual(view.h.navigations, ['trends']);
});

test.after(() => window.close());

test('Dashboard exposes the shared thinking control and hands the selected level to creation', async t => {
  const view = await fixture(t, { text: '第一轮强度验收', thinkingLevels: ['off','low','medium','high'] });
  await view.render();
  const trigger = view.container.querySelector('.thinking-level-trigger');
  assert.ok(trigger);
  await view.click(trigger);
  const slider = document.querySelector('.thinking-level-menu input[type="range"]');
  await view.key(slider, 'Home');
  await view.key(slider, 'Enter');
  await view.send();
  assert.equal(view.h.sentRoute[0], 'off');
  assert.equal(view.h.sentRoute[1], undefined);
});

test('account analysis keeps platform icons during reverification and restores the same identity snapshot', async t => {
  const identity={loggedIn:true,name:'Saved account',avatar:'',identityKey:'scope-keep',accountId:'own',verified:false,ts:Date.now()};
  const data={platform:'douyin',name:'抖音',nickname:'Saved account',loggedIn:true,followers:17,likes:3,posts:2,following:null,notes:[],metrics:[],growth:{},fetched_at:Date.now()/1000};
  const savedScope=JSON.stringify(['scope-keep','own']);
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:window.sessionStorage});
  sessionStorage.setItem('easel:analytics-cache:v1',JSON.stringify({douyin:{scope:savedScope,at:Date.now(),data}}));
  const view=await fixture(t,{accounts:[{platform:'douyin',name:'抖音',supported:true,loggedIn:false,hasLocalSession:true,identityKey:'scope-keep'}],analyticsPlatforms:[{platform:'douyin',name:'抖音',loggedIn:false}],extra:{easel_whoami:JSON.stringify({douyin:identity})}});
  await view.render();
  const chip=()=>view.container.querySelector('.ana-plats .chip');
  assert.ok(chip()); assert.ok(chip().querySelector('img.ana-platform-icon'));
  assert.ok(chip().querySelector('.ana-platform-state.is-unknown'));
  assert.doesNotMatch(view.container.querySelector('.dash-grid').textContent,/让每一次发布都有反馈/);
  await act(async()=>chip().click());
  assert.match(view.container.textContent,/@Saved account/);
  assert.ok(!view.h.requests.some(([path])=>path.startsWith('/api/analytics/douyin') && !path.endsWith('/snapshot')),'viewing saved data does not re-scrape');
  await view.remount();
  await act(async()=>chip().click());
  assert.match(view.container.textContent,/@Saved account/);
  sessionStorage.clear();
});

test('explicit logged-out platforms remain visible with red state and cannot start account collection', async t => {
  const identity={loggedIn:false,name:'',avatar:'',identityKey:'scope-out',verified:true,authState:'login_required',checkedAt:Date.now(),ts:Date.now()};
  const view=await fixture(t,{accounts:[{platform:'xiaohongshu',name:'小红书',supported:true,loggedIn:false,hasLocalSession:true,identityKey:'scope-out'}],analyticsPlatforms:[{platform:'xiaohongshu',name:'小红书',loggedIn:false}],extra:{easel_whoami:JSON.stringify({xiaohongshu:identity})}});
  await view.render();
  const chip=view.container.querySelector('.ana-plats .chip');
  assert.ok(chip.querySelector('.ana-platform-state.is-login_required'));
  await act(async()=>chip.click());
  assert.match(view.container.textContent,/小红书账号未登录/);
  const connect=view.container.querySelector('.ana-account-empty-action');
  assert.equal(connect.textContent,'连接账号');
  await view.focus(connect); assert.equal(document.activeElement,connect);
  await view.click(connect); assert.deepEqual(view.h.navigations,['accounts']);
  assert.ok(!view.h.requests.some(([path])=>path.startsWith('/api/analytics/xiaohongshu') && !path.endsWith('/snapshot')));
});


test('account metrics use an aligned data table and distinguish zero from missing comparison', async t => {
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:window.sessionStorage});
  sessionStorage.clear();
  const identity={loggedIn:true,name:'表格账号',avatar:'',identityKey:'scope-metrics-table',accountId:'table-owner',verified:true,authState:'online',checkedAt:Date.now(),ts:Date.now()};
  const metrics=[{label:'播放量',value:'1294',vs:'+65'},{label:'主页访问量',value:'30',vs:'+15'},{label:'作品点赞',value:'58',vs:'+11'},{label:'作品分享',value:'62',vs:'+13'},{label:'作品评论',value:'3',vs:null},{label:'净增粉丝',value:'0',vs:'0'}];
  const data={platform:'douyin',name:'抖音',nickname:identity.name,loggedIn:true,followers:17,likes:3,posts:2,following:null,notes:[],metrics,metrics_title:'近7日表现',metrics_source:{schema:'douyin-account-overview-v2',section:'账号总览',url:'https://creator.douyin.com/creator-micro/home',period:'last_7_days',from:'2026-10-14',to:'2026-10-20'},growth:{},fetched_at:Date.now()/1000};
  sessionStorage.setItem('easel:analytics-cache:v1',JSON.stringify({douyin:{scope:JSON.stringify([identity.identityKey,identity.accountId]),at:Date.now(),data}}));
  sessionStorage.setItem('easel:analytics-platform','douyin');
  const view=await fixture(t,{accounts:[{platform:'douyin',name:'抖音',supported:true,loggedIn:true,hasLocalSession:true,identityKey:identity.identityKey}],analyticsPlatforms:[{platform:'douyin',name:'抖音',loggedIn:true}],extra:{easel_whoami:JSON.stringify({douyin:identity})}});
  await view.render();
  const table=view.container.querySelector('table.ana-metrics-table');
  assert.ok(table);
  assert.deepEqual([...table.querySelectorAll('thead th')].map(c=>c.textContent),['指标','数值','较前7日']);
  assert.ok([...table.querySelectorAll('thead th')].every(c=>c.scope==='col'));
  const rows=[...table.querySelectorAll('tbody tr')];
  assert.equal(rows.length,6);
  assert.deepEqual(rows.map(r=>[...r.children].map(c=>c.textContent)),metrics.map(m=>[m.label,m.value,m.vs??'—']));
  assert.ok(rows.every(r=>r.querySelector('th').scope==='row'));
  assert.equal(rows[4].lastElementChild.title,'平台未提供对比数据');
  assert.match(table.closest('section').title,/2026-10-14 至 2026-10-20/);
  await view.remount();
  assert.equal(view.container.querySelectorAll('table.ana-metrics-table tbody tr').length,6);
  assert.ok(!view.h.requests.some(([path])=>path.startsWith('/api/analytics/douyin?')));
  sessionStorage.clear();
});

test('account growth windows change the visible deltas and comparison baseline', async t => {
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:window.sessionStorage});
  sessionStorage.clear();
  const identity={loggedIn:true,name:'窗口账号',avatar:'',identityKey:'scope-growth',accountId:'growth-owner',verified:true,authState:'online',checkedAt:Date.now(),ts:Date.now()};
  const growth={
    last:{followers:1,likes:2,posts:3,since_days:.1,baseline_at:1799990000,current_at:1800000000},
    day:{followers:11,likes:12,posts:13,since_days:1,baseline_at:1799913600,current_at:1800000000},
    week:{followers:21,likes:22,posts:23,since_days:7,baseline_at:1799395200,current_at:1800000000},
    month:{followers:null,likes:null,posts:null,since_days:null},
    year:null,
  };
  const data={platform:'douyin',name:'抖音',nickname:identity.name,loggedIn:true,followers:100,likes:200,posts:10,following:null,notes:[],metrics:[],growth,growthSchema:'account-history-v1',fetched_at:1800000000};
  sessionStorage.setItem('easel:analytics-cache:v1',JSON.stringify({douyin:{scope:JSON.stringify([identity.identityKey,identity.accountId]),at:Date.now(),data}}));
  sessionStorage.setItem('easel:analytics-platform','douyin');
  const view=await fixture(t,{accounts:[{platform:'douyin',name:'抖音',supported:true,loggedIn:true,hasLocalSession:true,identityKey:identity.identityKey}],analyticsPlatforms:[{platform:'douyin',name:'抖音',loggedIn:true}],extra:{easel_whoami:JSON.stringify({douyin:identity})}});
  await view.render();
  const card=()=>view.container.querySelector('[aria-label=账号分析]');
  const buttons=()=>[...card().querySelectorAll('.ana-win')];
  const deltaText=()=>[...card().querySelectorAll('.ana-stat-delta')].map(node=>node.textContent);
  assert.deepEqual(deltaText(),['较上周 ▲+21','较上周 ▲+22','较上周 ▲+23']);
  await view.click(buttons()[0]);
  assert.deepEqual(deltaText(),['较上次 ▲+1','较上次 ▲+2','较上次 ▲+3']);
  assert.match(card().querySelector('.ana-wins-note').textContent,/较上次 · 对比/);
  await view.click(buttons()[1]);
  assert.deepEqual(deltaText(),['较昨日 ▲+11','较昨日 ▲+12','较昨日 ▲+13']);
  assert.match(card().querySelector('.ana-wins-note').textContent,/较昨日 · 对比/);
  await view.click(buttons()[2]);
  assert.deepEqual(deltaText(),['较上周 ▲+21','较上周 ▲+22','较上周 ▲+23']);
  await view.click(buttons()[3]);
  assert.deepEqual(deltaText(),['较上月 未提供','较上月 未提供','较上月 未提供']);
  assert.match(card().querySelector('.ana-wins-note').textContent,/较上月 · 暂无该时段对比/);
  await view.click(buttons()[4]);
  assert.deepEqual(deltaText(),['较去年 暂无对比','较去年 暂无对比','较去年 暂无对比']);
  assert.match(card().querySelector('.ana-wins-note').textContent,/较去年 · 暂无该时段对比/);
  assert.equal(buttons().filter(b=>b.getAttribute('aria-pressed')==='true').length,1);
  assert.deepEqual([...card().querySelectorAll('.ana-stat-val')].map(n=>n.textContent),['100','200','10']);
  assert.equal(view.h.requests.filter(([path])=>path.startsWith('/api/analytics/douyin') && !path.endsWith('/snapshot')).length,0);
  sessionStorage.clear();
});

test('a restored snapshot upgrades same-timestamp growth without collecting again', async t => {
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:window.sessionStorage});
  sessionStorage.clear();
  const identity={loggedIn:true,name:'缓存账号',avatar:'',identityKey:'scope-growth-upgrade',accountId:'upgrade-owner',verified:true,authState:'online',checkedAt:Date.now(),ts:Date.now()};
  const data={platform:'douyin',name:'抖音',nickname:identity.name,loggedIn:true,followers:100,likes:200,posts:10,following:null,notes:[],metrics:[],growth:{week:null},fetched_at:1800000000};
  sessionStorage.setItem('easel:analytics-cache:v1',JSON.stringify({douyin:{scope:JSON.stringify([identity.identityKey,identity.accountId]),at:Date.now(),data}}));
  sessionStorage.setItem('easel:analytics-platform','douyin');
  const snapshot={...data,growthSchema:'account-history-v1',growth:{week:{followers:42,likes:0,posts:-1,since_days:7}}};
  const view=await fixture(t,{snapshot,accounts:[{platform:'douyin',name:'抖音',supported:true,loggedIn:true,identityKey:identity.identityKey}],analyticsPlatforms:[{platform:'douyin',name:'抖音',loggedIn:true}],extra:{easel_whoami:JSON.stringify({douyin:identity})}});
  await view.render();
  assert.deepEqual([...view.container.querySelectorAll('.ana-stat-delta')].map(n=>n.textContent),['较上周 ▲+42','较上周 持平','较上周 ▼1']);
  assert.deepEqual(view.h.requests.filter(([path])=>path.startsWith('/api/analytics/douyin')).map(([path])=>path),['/api/analytics/douyin/snapshot']);
  sessionStorage.clear();
});

test('account analysis retains previous data and loading across page unmount then shows the shared final result', async t => {
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:window.sessionStorage});
  sessionStorage.clear();
  const identity={loggedIn:true,name:'旧结果账号',avatar:'',identityKey:'scope-navigation-new',accountId:'owner',verified:true,authState:'online',checkedAt:Date.now(),ts:Date.now()};
  const data={platform:'douyin',name:'抖音',nickname:'旧结果账号',loggedIn:true,followers:17,likes:3,posts:2,following:null,notes:[],metrics:[],growth:{},fetched_at:1};
  sessionStorage.setItem('easel:analytics-cache:v1',JSON.stringify({douyin:{scope:JSON.stringify([identity.identityKey,identity.accountId]),at:Date.now(),data}}));
  sessionStorage.setItem('easel:analytics-platform','douyin');
  let finish; const navigations=[];
  const view=await fixture(t,{accounts:[{platform:'douyin',name:'抖音',supported:true,loggedIn:true,hasLocalSession:true,identityKey:identity.identityKey}],analyticsPlatforms:[{platform:'douyin',name:'抖音',loggedIn:true}],extra:{easel_whoami:JSON.stringify({douyin:identity})},analytics:()=>new Promise(resolve=>{finish=resolve;}),onNavigateAnalysis:p=>navigations.push(p)});
  await view.render();
  const card=()=>view.container.querySelector('[aria-label=账号分析]');
  assert.match(card().textContent,/@旧结果账号/);
  assert.equal(card().querySelectorAll('.ana-stat').length,3);
  assert.ok(card().querySelector('.ana-identity .account-connection-dot'));
  assert.equal(card().querySelector('.ana-col-metrics'),null);
  assert.doesNotMatch(card().textContent,/上次采集结果/);
  await view.click([...card().querySelectorAll('button')].find(b=>b.textContent==='主动分析'));
  assert.ok(card().querySelector('.ana-refresh-status .publish-spinner'));
  assert.match(card().textContent,/@旧结果账号/);
  await view.click([...card().querySelectorAll('button')].find(b=>b.textContent==='内容分析 →'));
  assert.deepEqual(navigations,['douyin']);
  await view.remount();
  assert.match(card().textContent,/@旧结果账号/);
  assert.ok(card().querySelector('.ana-refresh-status .publish-spinner'));
  assert.equal(view.h.requests.filter(([path])=>path==='/api/analytics/douyin?refresh=true').length,1);
  await act(async()=>finish({...data,nickname:'新的分析结果',followers:28,fetched_at:2}));
  assert.match(card().textContent,/@新的分析结果/);
  assert.equal(card().querySelector('.ana-refresh-status .publish-spinner'),null);
  sessionStorage.clear();
});
