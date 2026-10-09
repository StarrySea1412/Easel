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
    catalog: async () => [first, second],
    onQuick: null,
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = String(url);
    h.requests.push([path, options]);
    let data;
    if (path === '/api/skills') data = await h.catalog(++h.catalogCalls);
    else if (path.startsWith('/api/skill/')) data = skillDetail(decodeURIComponent(path.split('/').at(-1)));
    else if (path.startsWith('/api/trends?')) data = { trends: [], updated: 0 };
    else if (path === '/api/upload/limits') data = { max_mb: 50 };
    else if (['/api/schedule', '/api/outputs', '/api/accounts', '/api/ideas', '/api/analytics/platforms'].includes(path)) data = [];
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
      persona: '', gatewayStatus, onNavigate() {}, onUseTopic() {},
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
  assert.deepEqual(view.h.chatSent[0], ['会话里未发的消息', [], [second.name], { [second.name]: '会话自己的要求' }, 'medium']);
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
  assert.deepEqual(view.h.chatSent, [[text, [], [first.name], requirement, 'medium']], 'the first retry sends the complete recovered snapshot');
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

test.after(() => window.close());

test('Dashboard exposes the shared thinking control and hands the selected level to creation', async t => {
  const view = await fixture(t, { text: '第一轮强度验收' });
  await view.render();
  const trigger = view.container.querySelector('.thinking-level-trigger');
  assert.ok(trigger);
  await view.click(trigger);
  const slider = view.container.querySelector('.thinking-level-menu input[type="range"]');
  await view.key(slider, 'Home');
  await view.key(slider, 'Enter');
  await view.send();
  assert.equal(view.h.sentRoute[0], 'off');
  assert.equal(view.h.sentRoute[1], undefined);
});
