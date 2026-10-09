import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Actual ChatPage, Composer, BrushEntry and storage; HTTP replies are controlled.
// These are DOM integration checks, not browser screenshots or model execution.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
window.matchMedia = () => ({ matches: false });
window.HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
const { createRoot } = await import('react-dom/client');
const { default: Page } = await loadTsModule('../src/components/ChatPage.tsx', import.meta.url);
const { default: Composer } = await loadTsModule('../src/components/ChatComposer.tsx', import.meta.url);
const { readSelectedSkills, writeSelectedSkills } = await loadTsModule('../src/lib/selectedSkills.ts', import.meta.url);
const style = document.createElement('style');
style.textContent = fs.readFileSync(new URL('../src/styles/chat-composer.css', import.meta.url), 'utf8') + '\n' + fs.readFileSync(new URL('../src/styles/skill-picker.css', import.meta.url), 'utf8');
document.head.append(style);
const first = { name: 'card-xiaohongshu', description: '生成小红书知识卡片', layer: 'creation', needsApi: false, apiConfigured: true };
const second = { name: 'card-quote', description: '生成横版金句卡', layer: 'creation', needsApi: false, apiConfigured: true };
let sequence = 0;

async function fixture(t, initial = {}, mode = 'page') {
  const prefix = `skill-test-${++sequence}-`;
  const id = name => prefix + name;
  const key = name => `easel:selected-skills:${id(name)}`;
  const requirementKey = name => `easel:skill-requirements:${id(name)}`;
  const values = new Map(Object.entries(initial).map(([name, value]) => [key(name), typeof value === 'string' ? value : JSON.stringify(value)]));
  const storage = { values, reads: [], writes: [], failing: false,
    getItem(key) { this.reads.push(key); return values.get(key) ?? null; },
    setItem(key, value) { if (this.failing) throw new Error('storage full'); this.writes.push([key, value]); values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const h = { sent: [], catalogCalls: 0, catalog: async () => [first, second], accept: true };
  t.mock.method(globalThis, 'fetch', async url => {
    const data = url === '/api/skills' ? await h.catalog(++h.catalogCalls)
      : url === '/api/upload/limits' ? { max_mb: 50 }
        : String(url).startsWith('/api/skill/') ? { name: String(url).split('/').at(-1), content: '' } : { records: [] };
    return { ok: true, json: async () => data };
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let current = 'a', messages = [];
  const render = async (name = current, nextMessages = messages, sessionPatch = {}) => {
    current = name; messages = nextMessages;
    const shared = { onSend: (...args) => { h.sent.push(args); return h.accept; }, onStop() {} };
    await act(async () => root.render(mode === 'composer'
      ? createElement(Composer, { sessionId: id(name), isStreaming: false, ...shared })
      : createElement(Page, { session: { id: id(name), title: name, created: 1, messages, ...sessionPatch }, onResend() {}, ...shared })));
  };
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const click = async element => { assert.ok(element, 'interaction target exists'); await act(async () => element.click()); };
  return { h, container, storage, id, key, requirementKey, render, click,
    chips: () => [...container.querySelectorAll('.composer-skill-chip')].map(chip => chip.dataset.skill),
    trigger: () => container.querySelector('[aria-label="选择创作技能"]'),
    open: async () => click(container.querySelector('[aria-label="选择创作技能"]')),
    close: async () => click(document.querySelector('[aria-label="关闭技能选择"]')),
    async pick(name) { await click([...document.querySelectorAll('.brush-item')].find(button => button.textContent.includes(name))); },
    async reload() { await act(async () => root.render(null)); await render(); },
    async type(text) { const input = container.querySelector('textarea'); await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, text); input.dispatchEvent(new window.Event('input', { bubbles: true })); }); },
    async editRequirement(label = '小红书卡组') { await click(container.querySelector(`[aria-label="${label}技能详情与补充要求"]`)); },
    async typeRequirement(text) { const input = document.querySelector('.selected-skill-requirement-editor textarea'); assert.ok(input); await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, text); input.dispatchEvent(new window.Event('input', { bubbles: true })); }); },
    async requirementAction(text) { await click([...document.querySelectorAll('.selected-skill-popover button')].find(button => button.textContent === text)); },
  };
}

test('actual picker selection remains visible after closing and sends exact selected IDs with the message', async t => {
  const view = await fixture(t);
  await view.render();
  await view.open();
  await view.pick('小红书卡组');
  await view.pick('金句卡 / 数据卡');
  assert.deepEqual(view.chips(), [first.name, second.name]);
  await view.close();
  assert.equal(document.querySelector('.skill-picker'), null);
  assert.deepEqual(view.chips(), [first.name, second.name]);
  assert.equal(view.trigger().querySelector('.composer-skill-count').textContent, '2');
  assert.match(view.container.querySelector('[aria-label="已选择的创作技能"]').textContent, /已选技能.*小红书卡组.*金句卡/);
  await view.type('只发送我输入的正文');
  await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.deepEqual(view.h.sent, [['只发送我输入的正文', [], [first.name, second.name], {}, 'medium']]);
  assert.deepEqual(view.chips(), [first.name, second.name], 'accepted sends retain the next-turn skill choices');
  await view.click(view.container.querySelector('[aria-label="移除技能 小红书卡组"]'));
  assert.deepEqual(view.chips(), [second.name]);
  assert.deepEqual(JSON.parse(view.storage.values.get(view.key('a'))), [second.name]);
  await view.reload();
  assert.deepEqual(view.chips(), [second.name]);
});

test('compact skill label and vector chevron share a non-wrapping flex row', async t => {
  const view = await fixture(t, { a: [first.name] });
  await view.render();
  const button = view.trigger();
  assert.equal(window.getComputedStyle(button).display, 'inline-flex');
  assert.equal(window.getComputedStyle(button).flexWrap, 'nowrap');
  assert.equal(window.getComputedStyle(button).whiteSpace, 'nowrap');
  const chevron = button.querySelector('svg.composer-skill-chevron');
  assert.ok(chevron && chevron.querySelector('path'));
  assert.equal(button.querySelector('span.composer-skill-chevron'), null);
  assert.equal(chevron.parentElement, button);
  assert.equal(window.getComputedStyle(view.container.querySelector('.composer-selected-skills')).display, 'flex');
});

test('a delayed initial empty catalogue cannot erase a selection made from the picker', async t => {
  const view = await fixture(t);
  let finish;
  view.h.catalog = call => call === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([first, second]);
  await view.render();
  await view.open(); await view.pick('小红书卡组'); await view.close();
  assert.deepEqual(view.chips(), [first.name]);
  await act(async () => finish([]));
  assert.deepEqual(view.chips(), [first.name]);
  assert.deepEqual(JSON.parse(view.storage.values.get(view.key('a'))), [first.name]);
  assert.match(view.container.textContent, /已保留选择/);
  await view.reload();
  assert.deepEqual(view.chips(), [first.name]);
});

test('failed and empty catalogues preserve previous selections without mount-time storage writes', async t => {
  const view = await fixture(t, { a: [first.name], b: [second.name] });
  view.h.catalog = async () => { throw new Error('temporary failure'); };
  await view.render('a');
  assert.deepEqual(view.chips(), [first.name]);
  assert.match(view.container.textContent, /技能列表暂时无法读取，已保留当前选择/);
  assert.equal(view.storage.writes.filter(([key]) => key.startsWith('easel:selected-skills:')).length, 0);
  view.h.catalog = async () => [];
  await view.render('b');
  assert.deepEqual(view.chips(), [second.name]);
  assert.deepEqual(JSON.parse(view.storage.values.get(view.key('a'))), [first.name]);
  assert.deepEqual(JSON.parse(view.storage.values.get(view.key('b'))), [second.name]);
  await view.render('a'); await view.reload();
  assert.deepEqual(view.chips(), [first.name]);
});

test('welcome-to-thread remount and cross-session navigation retain their own skill chips', async t => {
  const view = await fixture(t, { a: [first.name], b: [second.name] });
  await view.render('a');
  await view.render('a', [{ role: 'user', content: '实际会话记录', selectedSkills: [first.name] }]);
  assert.deepEqual(view.chips(), [first.name]);
  await view.render('b', []); assert.deepEqual(view.chips(), [second.name]);
  await view.render('a', []); assert.deepEqual(view.chips(), [first.name]);
  await view.reload(); assert.deepEqual(view.chips(), [first.name]);
});

test('Composer itself isolates changed sessionId even when its parent provides no React key', async t => {
  const view = await fixture(t, { a: [first.name], b: [second.name] }, 'composer');
  let finish;
  view.h.catalog = call => call === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([first, second]);
  await view.render('a'); await view.render('b');
  assert.deepEqual(view.chips(), [second.name]);
  await act(async () => finish([]));
  assert.deepEqual(view.chips(), [second.name]);
  assert.deepEqual(JSON.parse(view.storage.values.get(view.key('a'))), [first.name]);
  assert.deepEqual(JSON.parse(view.storage.values.get(view.key('b'))), [second.name]);
  await view.render('a'); assert.deepEqual(view.chips(), [first.name]);
});

test('invalid saved selection is not overwritten merely by opening a conversation', async t => {
  const corrupt = '{preserve-invalid-selection';
  const view = await fixture(t, { a: corrupt });
  await view.render();
  assert.deepEqual(view.chips(), []);
  assert.equal(view.storage.values.get(view.key('a')), corrupt);
  assert.deepEqual(readSelectedSkills(view.id('a')), []);
  assert.equal(writeSelectedSkills(view.id('a'), [first.name, first.name, '../invalid']), true);
  assert.deepEqual(readSelectedSkills(view.id('a')), [first.name]);
});

test('storage failure keeps visible picks and identifies the refresh limitation', async t => {
  const view = await fixture(t);
  await view.render();
  view.storage.failing = true;
  await view.open(); await view.pick('小红书卡组'); await view.close();
  assert.deepEqual(view.chips(), [first.name]);
  assert.match(view.container.textContent, /浏览器未能保存技能选择或补充要求，刷新后需要重新设置/);
  view.storage.failing = false;
  await view.open(); await view.pick('金句卡 / 数据卡'); await view.close();
  assert.deepEqual(JSON.parse(view.storage.values.get(view.key('a'))), [first.name, second.name]);
});

test('actual Composer sends per-session requirements after navigation, remount and reload', async t => {
  const view = await fixture(t, { a: [first.name], b: [first.name] });
  view.storage.values.set(view.requirementKey('a'), JSON.stringify({ [first.name]: '会话一：保留出处' }));
  view.storage.values.set(view.requirementKey('b'), JSON.stringify({ [first.name]: '会话二：采用列表' }));
  await view.render('a'); await view.type('会话一正文');
  await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.deepEqual(view.h.sent.at(-1), ['会话一正文', [], [first.name], { [first.name]: '会话一：保留出处' }, 'medium']);
  await view.render('a', [{ role: 'user', content: '已发送正文' }]);
  await view.render('b', []); await view.reload(); await view.type('会话二正文');
  await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.deepEqual(view.h.sent.at(-1)[3], { [first.name]: '会话二：采用列表' });
  await view.render('a', []); await view.reload(); await view.type('回到会话一');
  await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.deepEqual(view.h.sent.at(-1)[3], { [first.name]: '会话一：保留出处' });
  assert.equal(view.storage.writes.filter(([key]) => key.startsWith('easel:skill-requirements:')).length, 0, 'mounts and sends never rewrite preferences');
});

test('failed and incomplete catalogues preserve scoped requirements for later sends', async t => {
  const view = await fixture(t, { a: [first.name] });
  view.storage.values.set(view.requirementKey('a'), JSON.stringify({ [first.name]: '读取失败时也不要覆盖' }));
  view.h.catalog = async () => { throw new Error('temporary failure'); };
  await view.render();
  view.h.catalog = async () => [];
  await view.reload(); await view.type('继续发送');
  await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.deepEqual(view.h.sent.at(-1)[3], { [first.name]: '读取失败时也不要覆盖' });
  assert.equal(view.storage.values.get(view.requirementKey('a')), JSON.stringify({ [first.name]: '读取失败时也不要覆盖' }));
});

test('removing a selected skill clears its requirements only from the active conversation', async t => {
  const view = await fixture(t, { a: [first.name, second.name], b: [first.name] });
  view.storage.values.set(view.requirementKey('a'), JSON.stringify({ [first.name]: '会随移除清空', [second.name]: '保留金句要求' }));
  view.storage.values.set(view.requirementKey('b'), JSON.stringify({ [first.name]: '另一会话保持' }));
  await view.render('a');
  await view.click(view.container.querySelector('[aria-label="移除技能 小红书卡组"]'));
  assert.deepEqual(JSON.parse(view.storage.values.get(view.requirementKey('a'))), { [second.name]: '保留金句要求' });
  assert.deepEqual(JSON.parse(view.storage.values.get(view.requirementKey('b'))), { [first.name]: '另一会话保持' });
  await view.open(); await view.pick('小红书卡组'); await view.close();
  await view.reload(); await view.type('重新选择的技能没有旧要求');
  await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.deepEqual(view.h.sent.at(-1)[3], { [second.name]: '保留金句要求' });
});

test('welcome suggestions include the active conversation requirements', async t => {
  const view = await fixture(t, { a: [first.name] });
  view.storage.values.set(view.requirementKey('a'), JSON.stringify({ [first.name]: '建议入口也遵守' }));
  await view.render();
  await view.click(view.container.querySelector('.suggestion-card'));
  assert.deepEqual(view.h.sent.at(-1).slice(1), [undefined, [first.name], { [first.name]: '建议入口也遵守' }]);
});

test('read-only imported conversations do not mount skill controls or read forged requirement preferences', async t => {
  const view = await fixture(t, { a: [first.name] });
  view.storage.values.set(view.requirementKey('a'), JSON.stringify({ [first.name]: '只读备份不能加载成执行配置' }));
  await view.render('a', [{ role: 'user', content: '导入文字', selectedSkills: [first.name], skillRequirements: { [first.name]: '旧消息要求' } }], { importedFromBackup: true });
  assert.equal(view.container.querySelector('.composer-skill-chip'), null);
  assert.equal(view.container.querySelector('textarea'), null);
  assert.equal(view.storage.reads.includes(view.requirementKey('a')), false);
  assert.equal(view.storage.reads.includes(view.key('a')), false);
  assert.deepEqual(view.h.sent, []);
});

test('editing a real selected-skill chip saves, restores, updates future sends and clears its scoped note', async t => {
  const view = await fixture(t, { a: [first.name], b: [first.name] });
  view.storage.values.set(view.requirementKey('b'), JSON.stringify({ [first.name]: '其他会话的要求' }));
  await view.render(); await view.editRequirement();
  const editor = document.querySelector('.selected-skill-requirement-editor textarea');
  assert.equal(document.querySelector(`label[for="${editor.id}"]`).textContent, '本会话补充要求');
  assert.match(document.querySelector('.selected-skill-scope').textContent, /仅用于此技能在本会话之后发送的消息/);
  await view.typeRequirement('  先说明依据，再列出建议。  ');
  await view.requirementAction('保存补充要求');
  assert.equal(document.querySelector('.selected-skill-popover'), null);
  assert.ok(view.container.querySelector('[aria-label="已添加本会话补充要求"]'));
  assert.deepEqual(JSON.parse(view.storage.values.get(view.requirementKey('a'))), { [first.name]: '先说明依据，再列出建议。' });
  await view.type('第一轮正文'); await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  const originalSend = view.h.sent.at(-1);
  await view.render('b'); await view.render('a'); await view.reload(); await view.editRequirement();
  assert.equal(document.querySelector('.selected-skill-requirement-editor textarea').value, '先说明依据，再列出建议。');
  await view.typeRequirement('下一轮保持简洁。'); await view.requirementAction('保存补充要求');
  await view.type('第二轮正文'); await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.deepEqual(originalSend[3], { [first.name]: '先说明依据，再列出建议。' });
  assert.deepEqual(view.h.sent.at(-1)[3], { [first.name]: '下一轮保持简洁。' });
  await view.editRequirement(); await view.requirementAction('清除补充要求');
  assert.equal(view.container.querySelector('[aria-label="已添加本会话补充要求"]'), null);
  assert.deepEqual(JSON.parse(view.storage.values.get(view.requirementKey('a'))), {});
  assert.deepEqual(JSON.parse(view.storage.values.get(view.requirementKey('b'))), { [first.name]: '其他会话的要求' });
  await view.reload(); await view.type('清除后正文'); await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.deepEqual(view.h.sent.at(-1)[3], {});
  assert.deepEqual(view.chips(), [first.name]);
});

test('failed note persistence preserves the editor draft and retries the actual save', async t => {
  const view = await fixture(t, { a: [first.name] });
  await view.render(); await view.editRequirement(); await view.typeRequirement('存储失败也不要丢失正在编辑的要求');
  view.storage.failing = true;
  await view.requirementAction('保存补充要求');
  assert.equal(document.querySelector('.selected-skill-requirement-editor textarea').value, '存储失败也不要丢失正在编辑的要求');
  assert.match(document.querySelector('.selected-skill-error').textContent, /尚未完成保存/);
  assert.match(view.container.textContent, /浏览器未能保存本会话补充要求/);
  assert.equal(view.storage.values.has(view.requirementKey('a')), false);
  view.storage.failing = false;
  await view.requirementAction('保存补充要求');
  assert.equal(document.querySelector('.selected-skill-popover'), null);
  assert.deepEqual(JSON.parse(view.storage.values.get(view.requirementKey('a'))), { [first.name]: '存储失败也不要丢失正在编辑的要求' });
  await view.reload(); await view.type('下一轮'); await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.deepEqual(view.h.sent.at(-1)[3], { [first.name]: '存储失败也不要丢失正在编辑的要求' });
});

for (const action of ['保存补充要求', '清除补充要求']) {
  test(`failed ${action} followed by cancel preserves the active note until a successful retry`, async t => {
    const view = await fixture(t, { a: [first.name] });
    const original = { [first.name]: '原来已保存且生效的要求' };
    view.storage.values.set(view.requirementKey('a'), JSON.stringify(original));
    await view.render(); await view.editRequirement();
    await view.typeRequirement('尚未保存的新要求');
    view.storage.failing = true;
    await view.requirementAction(action);
    assert.equal(document.querySelector('.selected-skill-requirement-editor textarea').value, '尚未保存的新要求');
    assert.match(view.container.textContent, /原要求仍然生效/);
    assert.deepEqual(JSON.parse(view.storage.values.get(view.requirementKey('a'))), original);
    await view.requirementAction('取消');
    await view.type('取消后发送'); await view.click(view.container.querySelector('[aria-label="发送消息"]'));
    assert.deepEqual(view.h.sent.at(-1)[3], original, 'an unsuccessful edit or clear must not affect the next send');
    await view.editRequirement();
    assert.equal(document.querySelector('.selected-skill-requirement-editor textarea').value, original[first.name]);
    await view.typeRequirement('重试成功的新要求');
    view.storage.failing = false;
    await view.requirementAction(action);
    const expected = action === '清除补充要求' ? {} : { [first.name]: '重试成功的新要求' };
    await view.type('重试后发送'); await view.click(view.container.querySelector('[aria-label="发送消息"]'));
    assert.deepEqual(view.h.sent.at(-1)[3], expected);
    assert.deepEqual(JSON.parse(view.storage.values.get(view.requirementKey('a'))), expected);
  });
}

test('combined requirement length rejection retains the new draft without silently dropping existing notes', async t => {
  const selected = [first.name, second.name, 'test-a', 'test-b', 'test-c', 'test-d'];
  const existing = Object.fromEntries(selected.slice(1).map(name => [name, '字'.repeat(2000)]));
  const view = await fixture(t, { a: selected });
  view.storage.values.set(view.requirementKey('a'), JSON.stringify(existing));
  await view.render(); await view.editRequirement(); await view.typeRequirement('超出总长的新要求');
  await view.requirementAction('保存补充要求');
  assert.equal(document.querySelector('.selected-skill-requirement-editor textarea').value, '超出总长的新要求');
  assert.match(view.container.textContent, /总共 10000 字/);
  assert.deepEqual(JSON.parse(view.storage.values.get(view.requirementKey('a'))), existing);
  await view.requirementAction('取消');
  await view.type('原来的合法要求仍可发送'); await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.deepEqual(view.h.sent.at(-1)[3], existing);
});

test('the note editor handles prototype-named installed skills as ordinary own keys', async t => {
  const view = await fixture(t, { a: ['__proto__'] });
  view.h.catalog = async () => [{ ...first, name: '__proto__' }];
  await view.render(); await view.editRequirement('__proto__'); await view.typeRequirement('普通的技能补充要求');
  await view.requirementAction('保存补充要求');
  const saved = JSON.parse(view.storage.values.get(view.requirementKey('a')));
  assert.equal(Object.hasOwn(saved, '__proto__'), true);
  assert.equal(saved.__proto__, '普通的技能补充要求');
  assert.equal(Object.getPrototypeOf(saved), Object.prototype);
  await view.type('发送普通键'); await view.click(view.container.querySelector('[aria-label="发送消息"]'));
  assert.deepEqual(Object.keys(view.h.sent.at(-1)[3]), ['__proto__']);
  assert.equal(view.h.sent.at(-1)[3].__proto__, '普通的技能补充要求');
});
