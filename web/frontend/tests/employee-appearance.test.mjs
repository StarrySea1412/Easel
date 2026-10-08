import { selectOption, optionValues } from './select-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { tsModuleUrl } from './load-ts.mjs';

const window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://easel.test/' }).window;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const prefix = 'data:text/javascript;base64,';
const moduleUrl = text => prefix + Buffer.from(text).toString('base64');
const appearanceUrl = await tsModuleUrl(new URL('../src/lib/employeeAppearance.ts', import.meta.url));
const persistenceUrl = await tsModuleUrl(new URL('../src/lib/localPersistence.ts', import.meta.url));
const componentUrl = await tsModuleUrl(new URL('../src/components/settings/EmployeeAppearanceSettings.tsx', import.meta.url));
const source = url => Buffer.from(url.slice(prefix.length), 'base64').toString();
let sequence = 0;

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values, calls: [], failRead: false, failWrite: false,
    getItem(key) { this.calls.push(['read', key]); if (this.failRead) throw new Error('blocked'); return values.get(key) ?? null; },
    setItem(key, value) { this.calls.push(['write', key]); if (this.failWrite) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); values.set(key, value); },
  };
}
async function isolated(saved = storage()) {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: saved });
  const persistence = `${persistenceUrl}#appearance-${++sequence}`;
  const module = `${moduleUrl(source(appearanceUrl).replaceAll(persistenceUrl, persistence))}#appearance-${sequence}`;
  return { saved, lib: await import(module), persistence: await import(persistence), module };
}

test('appearance imports are storage-free; complete defaults save and restore across module reloads', async () => {
  const first = await isolated();
  assert.deepEqual(first.saved.calls, []);
  assert.equal(first.lib.readEmployeeAppearances().length, 7);
  assert.deepEqual(first.lib.readEmployeeAppearances().map(card => card.id), first.lib.EMPLOYEE_APPEARANCE_IDS);
  assert.deepEqual(first.lib.readEmployeeAppearances().map(card => card.species), ['cat', 'fox', 'rabbit', 'rabbit', 'bear', 'fox', 'cat']);
  const cards = first.lib.readEmployeeAppearances().map(card => ({ ...card }));
  cards[0] = { ...cards[0], name: '  配置中的显示名  ', role: '视觉协调', shirtColor: '#aabbcc', hairStyle: 'long', accessory: 'glasses' };
  assert.equal(first.lib.saveEmployeeAppearances(cards), true);
  const next = await isolated(first.saved);
  assert.equal(next.lib.readEmployeeAppearances()[0].name, '配置中的显示名');
  assert.equal(next.lib.readEmployeeAppearances()[0].shirtColor, '#AABBCC');
  assert.equal(next.lib.readEmployeeAppearances()[0].hairStyle, 'long');
  assert.equal(next.lib.resetEmployeeAppearances(), true);
  assert.deepEqual(next.lib.readEmployeeAppearances(), next.lib.DEFAULT_EMPLOYEE_APPEARANCES);
});

test('legacy cards acquire their own default species without losing custom appearance or explicit Agent bindings', async () => {
  const initial = await isolated();
  const legacy = initial.lib.DEFAULT_EMPLOYEE_APPEARANCES.map(({ species: _species, ...card }, index) => ({
    ...card, name: `保留名称 ${index}`, role: `保留岗位 ${index}`, shirtColor: '#AABBCC', hairColor: '#112233',
    skinColor: '#DDEEFF', hairStyle: 'long', accessory: 'headset',
  })).reverse();
  const original = JSON.stringify({ version: 1, value: legacy });
  const binding = JSON.stringify({ version: 1, value: { 'live/session:child': 'designer' } });
  const saved = storage({ easel_employee_appearances: original, easel_employee_assignments: binding });
  const upgraded = await isolated(saved);
  const cards = upgraded.lib.readEmployeeAppearances();
  assert.equal(saved.values.get('easel_employee_appearances'), original, 'reading legacy cards does not rewrite storage');
  assert.equal(saved.calls.filter(([kind]) => kind === 'write').length, 0);
  for (const card of cards) {
    const old = legacy.find(item => item.id === card.id);
    const { species, ...remaining } = card;
    assert.equal(species, upgraded.lib.DEFAULT_EMPLOYEE_APPEARANCES.find(item => item.id === card.id).species);
    assert.deepEqual(remaining, old);
  }
  assert.equal(upgraded.lib.readEmployeeAssignments()['live/session:child'], 'designer');
  assert.equal(upgraded.lib.saveEmployeeAppearances(cards), true);
  const reloaded = await isolated(saved);
  assert.deepEqual(reloaded.lib.readEmployeeAppearances(), cards);
  assert.equal(saved.values.get('easel_employee_assignments'), binding);
});

test('species are strictly allowlisted and invalid persisted species stay protected', async () => {
  const { lib, saved } = await isolated();
  lib.saveEmployeeAppearances(lib.DEFAULT_EMPLOYEE_APPEARANCES);
  const original = saved.values.get('easel_employee_appearances');
  for (const species of ['human', 'CAT', '', null, 1, ['cat'], { species: 'cat' }]) {
    const cards = lib.DEFAULT_EMPLOYEE_APPEARANCES.map(card => ({ ...card }));
    cards[0].species = species;
    assert.throws(() => lib.saveEmployeeAppearances(cards), /小猫、兔子、狐狸或小熊/);
    assert.equal(saved.values.get('easel_employee_appearances'), original);
  }
  const badCards = lib.DEFAULT_EMPLOYEE_APPEARANCES.map(card => ({ ...card, species: 'human' }));
  const corrupt = JSON.stringify({ version: 1, value: badCards });
  const protectedRecord = await isolated(storage({ easel_employee_appearances: corrupt }));
  assert.deepEqual(protectedRecord.lib.readEmployeeAppearances(), protectedRecord.lib.DEFAULT_EMPLOYEE_APPEARANCES);
  assert.equal(protectedRecord.lib.resetEmployeeAppearances(), false);
  assert.equal(protectedRecord.saved.values.get('easel_employee_appearances'), corrupt);
});

test('invalid card identities, enum values, colors, lengths and incomplete sets never replace saved data', async () => {
  const { lib, saved } = await isolated();
  lib.saveEmployeeAppearances(lib.DEFAULT_EMPLOYEE_APPEARANCES);
  const original = saved.values.get('easel_employee_appearances');
  const changes = [
    cards => cards.pop(),
    cards => { cards[0].id = 'generic'; },
    cards => { cards[0].id = 'inferred-real-agent-role'; },
    cards => { cards[0].name = ' '; },
    cards => { cards[0].name = '非法\n名称'; },
    cards => { cards[0].role = 'x'.repeat(41); },
    cards => { cards[0].shirtColor = 'url(https://example.test)'; },
    cards => { cards[0].hairStyle = ['short']; },
    cards => { cards[0].accessory = 'magic'; },
  ];
  for (const change of changes) {
    const cards = lib.DEFAULT_EMPLOYEE_APPEARANCES.map(card => ({ ...card }));
    change(cards);
    assert.throws(() => lib.saveEmployeeAppearances(cards));
    assert.equal(saved.values.get('easel_employee_appearances'), original);
  }
});

test('corrupt and unreadable appearance records remain protected during save and reset', async () => {
  for (const corrupt of ['{broken', JSON.stringify({ version: 99, value: [] })]) {
    const { lib, saved, persistence } = await isolated(storage({ easel_employee_appearances: corrupt }));
    const cards = lib.DEFAULT_EMPLOYEE_APPEARANCES.map(card => ({ ...card, name: '当前窗口' }));
    assert.equal(lib.saveEmployeeAppearances(cards), false, 'save establishes protection even without an earlier read');
    assert.equal(saved.values.get('easel_employee_appearances'), corrupt);
    assert.equal(lib.readEmployeeAppearances()[0].name, '当前窗口');
    assert.equal(lib.resetEmployeeAppearances(), false);
    assert.equal(persistence.retryPendingLocalWrites(), false);
    assert.equal(saved.values.get('easel_employee_appearances'), corrupt);
  }
  const saved = storage({ easel_employee_appearances: 'unread original' });
  saved.failRead = true;
  const { lib } = await isolated(saved);
  lib.readEmployeeAppearances();
  saved.failRead = false;
  assert.equal(lib.resetEmployeeAppearances(), false);
  assert.equal(saved.values.get('easel_employee_appearances'), 'unread original');
});

test('quota failure applies the latest appearance in memory and localPersistence retries exactly that snapshot', async () => {
  const { lib, saved, persistence } = await isolated();
  saved.failWrite = true;
  let changes = 0;
  const unsubscribe = lib.subscribeEmployeeAppearances(() => changes++);
  for (const name of ['第一次修改', '最新修改']) {
    assert.equal(lib.saveEmployeeAppearances(lib.DEFAULT_EMPLOYEE_APPEARANCES.map(card => ({ ...card, name }))), false);
  }
  assert.equal(changes, 2);
  assert.equal(lib.readEmployeeAppearances()[0].name, '最新修改');
  assert.equal(persistence.getLocalPersistenceStatus().unsaved, true);
  saved.failWrite = false;
  assert.equal(persistence.retryPendingLocalWrites(), true);
  assert.equal(JSON.parse(saved.values.get('easel_employee_appearances')).value[0].name, '最新修改');
  unsubscribe();
  lib.resetEmployeeAppearances();
  assert.equal(changes, 2);
});

test('assignments persist explicit choices, notify subscribers and reject prototype keys, unknown cards and oversized maps', async () => {
  const first = await isolated();
  assert.equal(Object.keys(first.lib.readEmployeeAssignments()).length, 0, 'no live role is inferred');
  let changes = 0;
  first.lib.subscribeEmployeeAppearances(() => changes++);
  assert.equal(first.lib.assignEmployeeAppearance('live/session:agent-1', 'designer'), true);
  assert.equal(changes, 1);
  const second = await isolated(first.saved);
  assert.equal(second.lib.readEmployeeAssignments()['live/session:agent-1'], 'designer');
  assert.throws(() => second.lib.assignEmployeeAppearance('__proto__', 'writer'));
  assert.throws(() => second.lib.assignEmployeeAppearance('agent\n1', 'writer'));
  assert.throws(() => second.lib.assignEmployeeAppearance('x'.repeat(161), 'writer'));
  assert.throws(() => second.lib.assignEmployeeAppearance('agent', 'unknown-card'));
  const full = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`agent-${index}`, 'generic']));
  const max = await isolated(storage({ easel_employee_assignments: JSON.stringify({ version: 1, value: full }) }));
  assert.throws(() => max.lib.assignEmployeeAppearance('overflow', 'writer'), /256/);
  assert.equal(max.lib.assignEmployeeAppearance('agent-0', 'writer'), true, 'editing an existing binding remains possible at capacity');
});

test('corrupt bindings are never overwritten; appearance save/reset does not erase explicit assignments', async () => {
  const corrupt = '{preserve bindings';
  const { lib, saved, persistence } = await isolated(storage({ easel_employee_assignments: corrupt }));
  assert.equal(lib.assignEmployeeAppearance('real-id', 'researcher'), false);
  assert.equal(saved.values.get('easel_employee_assignments'), corrupt);
  assert.equal(lib.readEmployeeAssignments()['real-id'], 'researcher');
  lib.resetEmployeeAppearances();
  assert.equal(lib.readEmployeeAssignments()['real-id'], 'researcher');
  assert.equal(persistence.retryPendingLocalWrites(), false);
  assert.equal(saved.values.get('easel_employee_assignments'), corrupt);
});

test('settings animal portraits preview species and fur colors, explicitly save, and preserve internal legacy fields', async t => {
  const fixture = await isolated();
  const { default: Settings } = await import(`${moduleUrl(source(componentUrl).replaceAll(appearanceUrl, fixture.module))}#ui-${sequence}`);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(createElement(Settings)));
  assert.equal(container.querySelectorAll('.employee-card').length, 7);
  assert.match(container.textContent, /不会修改模型提示词、权限或执行行为/);
  assert.equal(container.querySelectorAll('input[type="color"]').length, 21);
  assert.match(container.textContent, /动物种类/);
  assert.match(container.textContent, /点缀色/);
  assert.match(container.textContent, /毛色/);
  assert.doesNotMatch(container.textContent, /发型|短发|长发|发髻|肤色|头发/);
  const species = container.querySelector('.employee-card [role="combobox"]');
  assert.deepEqual(await optionValues(species), ['cat', 'rabbit', 'fox', 'bear']);
  const portrait = container.querySelector('.employee-card__portrait');
  assert.equal(portrait.dataset.species, 'cat');
  const variants = new Set();
  for (const value of ['cat', 'rabbit', 'fox', 'bear']) {
    await selectOption(species, value);
    assert.equal(portrait.dataset.species, value);
    variants.add(portrait.innerHTML);
  }
  assert.equal(variants.size, 4, 'each animal selection changes its visible SVG shapes');
  assert.equal(fixture.lib.readEmployeeAppearances()[0].species, 'cat', 'species previews are not saved implicitly');
  const previousHairStyle = fixture.lib.readEmployeeAppearances()[0].hairStyle;
  const name = container.querySelector('.employee-card input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(name, '新显示名');
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.equal(fixture.lib.readEmployeeAppearances()[0].name, 'Easel', 'form edits only affect the wardrobe preview until saved');
  await act(async () => container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(fixture.lib.readEmployeeAppearances()[0].name, '新显示名');
  assert.equal(fixture.lib.readEmployeeAppearances()[0].species, 'bear');
  assert.equal(fixture.lib.readEmployeeAppearances()[0].hairStyle, previousHairStyle, 'hidden legacy fields survive animal edits');
  assert.equal(JSON.parse(fixture.saved.values.get('easel_employee_appearances')).value[0].species, 'bear');
  assert.match(container.querySelector('[role="status"]').textContent, /已保存/);
  const reset = [...container.querySelectorAll('button')].find(button => button.textContent === '恢复默认');
  await act(async () => reset.click());
  assert.equal(name.value, 'Easel');
  assert.equal(species.value, 'cat');
  assert.equal(fixture.lib.readEmployeeAppearances()[0].name, '新显示名', 'reset is previewed and awaits explicit save');
  await act(async () => container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(fixture.lib.readEmployeeAppearances()[0].name, 'Easel');
  assert.equal(fixture.lib.readEmployeeAppearances()[0].species, 'cat');
});

test.after(() => window.close());
