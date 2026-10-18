import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'http://127.0.0.1:7880/' });
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.sessionStorage = window.sessionStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const theme = await loadTsModule('../src/lib/theme.ts', import.meta.url);
const events = await loadTsModule('../src/lib/eventNotifications.ts', import.meta.url);
const { default: Center } = await loadTsModule('../src/components/EventNotificationCenter.tsx', import.meta.url);
const { default: Appearance } = await loadTsModule('../src/components/settings/AppearanceSettings.tsx', import.meta.url);
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const bootstrap = html.split('<script id="easel-theme-init">')[1].split('</script>')[0];

test('pre-paint theme honors saved preference, system default, invalid values and denied storage', () => {
  for (const [saved, system, expected] of [['dark', false, 'dark'], ['light', true, 'light'], ['system', true, 'dark'], [null, false, 'light'], ['bad', true, 'dark'], ['denied', true, 'dark']]) {
    const element = { dataset: {}, style: {} };
    vm.runInNewContext(bootstrap, { document: { documentElement: element }, window: { matchMedia: () => ({ matches: system }) }, localStorage: { getItem: () => { if (saved === 'denied') throw Error('restricted'); return saved; } } });
    assert.equal(element.dataset.theme, expected); assert.equal(element.style.colorScheme, expected);
  }
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('easel-theme-init') < html.indexOf('fonts.googleapis.com'));
});

test('theme follows system live, persists manual mode, syncs tabs and cleans listeners', t => {
  let changed; let removed = 0;
  const media = { matches: false, addEventListener: (_, fn) => { changed = fn; }, removeEventListener: () => removed++ };
  t.mock.method(window, 'matchMedia', () => media);
  window.localStorage.clear();
  const stop = theme.initializeTheme(); assert.equal(theme.initializeTheme(), stop);
  const seen = []; const unsubscribe = theme.subscribeTheme(() => seen.push(theme.readTheme().resolved));
  assert.equal(theme.readTheme().preference, 'system');
  media.matches = true; changed(); assert.equal(document.documentElement.dataset.theme, 'dark');
  theme.setThemePreference('light'); assert.equal(window.localStorage.getItem(theme.THEME_STORAGE_KEY), 'light');
  changed(); assert.equal(theme.readTheme().resolved, 'light');
  window.dispatchEvent(new window.StorageEvent('storage', { key: theme.THEME_STORAGE_KEY, newValue: 'dark' }));
  assert.equal(theme.readTheme().preference, 'dark');
  window.dispatchEvent(new window.StorageEvent('storage', { key: null }));
  assert.equal(theme.readTheme().preference, 'system');
  assert.ok(seen.includes('dark') && seen.includes('light')); unsubscribe(); stop(); assert.equal(removed, 1);
  theme.initializeTheme()(); assert.equal(theme.readTheme().preference, 'light', 'reload reads stored preference');
});

test('storage failures keep theme usable with an honest persistence status', t => {
  t.mock.method(window.localStorage, 'getItem', () => { throw Error('denied'); });
  t.mock.method(window.localStorage, 'setItem', () => { throw Error('denied'); });
  const stop = theme.initializeTheme();
  assert.equal(theme.readTheme().persisted, false);
  theme.setThemePreference('dark'); assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(theme.readTheme().persisted, false); stop();
});

async function view(t, Component, props = {}) {
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  await act(async () => root.render(createElement(Component, props)));
  t.after(async () => { await act(async () => root.unmount()); node.remove(); });
  return { node, click: element => act(async () => element.click()) };
}
const buttonText = text => [...document.querySelectorAll('.global-events-panel button')].find(button => button.textContent === text);

test('appearance uses shared keyboard selector and applies selected mode immediately', async t => {
  const stop = theme.initializeTheme(); t.after(stop);
  const v = await view(t, Appearance);
  const select = v.node.querySelector('[role=combobox]'); assert.ok(select); assert.equal(v.node.querySelector('select'), null);
  await v.click(select);
  const dark = [...document.querySelectorAll('[role=option]')].find(option => option.querySelector('.easel-select-option-label')?.textContent === '深色 · 夜间模式');
  await v.click(dark); assert.equal(theme.readTheme().preference, 'dark');
  assert.match(v.node.querySelector('[role=status]').textContent, /当前为深色/);
  assert.equal(document.activeElement, select);
  await v.click(select);
  await act(async () => select.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  await act(async () => select.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(theme.readTheme().preference, 'system');
});

test('notification filters keep counts and keyboard focus when the last unread row disappears', async t => {
  events.clearEvents(); events.recordEvent('已完成的任务', 'success', undefined, 'polish-read'); events.markEventsRead();
  events.recordEvent('<script>很长的任务错误</script>', 'error', undefined, 'polish-unread', { page: 'chat', sessionId: 's1' });
  const v = await view(t, Center, { onOpen: () => {} }); await v.click(v.node.querySelector('button'));
  assert.equal(document.querySelectorAll('.event-card').length, 2);
  assert.equal(document.querySelector('.event-card-message script'), null);
  assert.ok(document.querySelector('.event-date-heading'));
  const unread = [...document.querySelectorAll('.event-filters button')][1]; await v.click(unread);
  assert.equal(document.querySelectorAll('.event-card').length, 1);
  await v.click(document.querySelector('.event-mark-one:not(:disabled)'));
  assert.equal(document.activeElement, unread); assert.equal(document.querySelectorAll('.event-card').length, 0);
  assert.match(document.querySelector('.event-empty').textContent, /都看过了/);
  await v.click(buttonText('查看全部事件')); assert.equal(document.querySelectorAll('.event-card').length, 2);
});

test('notification clear requires explicit confirmation and does not replay a pending event', async t => {
  events.clearEvents(); events.recordEvent('需要回答', 'info', undefined, 'polish-clear');
  const v = await view(t, Center, { onOpen: () => {} }); await v.click(v.node.querySelector('button'));
  await v.click(buttonText('清空')); assert.equal(events.readEvents().length, 1);
  assert.equal(document.activeElement, buttonText('取消'), 'safe confirmation action receives keyboard focus');
  await v.click(buttonText('取消')); assert.equal(events.readEvents().length, 1);
  await v.click(buttonText('清空')); await v.click(buttonText('确认清空'));
  assert.equal(events.readEvents().length, 0); assert.equal(document.activeElement, document.querySelector('.global-events-panel'));
  assert.match(document.querySelector('.event-empty').textContent, /暂时没有新动态/);
  assert.equal(events.recordEvent('需要回答', 'info', undefined, 'polish-clear'), false);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(document.querySelector('.global-events-panel'), null); assert.equal(document.activeElement, v.node.querySelector('button'));
});

test('notification receives new events while filtered, preserves long text and runs explicit action once', async t => {
  events.clearEvents();
  const v = await view(t, Center, { onOpen: () => assert.fail('callback-only event has no route') });
  await v.click(v.node.querySelector('button'));
  const unread = document.querySelectorAll('.event-filters button')[1]; await v.click(unread);
  let runs = 0; const message = '长任务说明'.repeat(120);
  await act(async () => events.recordEvent(message, 'error', { label: '处理', run: () => runs++ }, 'live-long'));
  assert.equal(document.querySelector('.event-card-message').textContent, message);
  assert.equal(document.querySelector('.event-card').classList.contains('error'), true);
  assert.equal(unread.textContent, '未读1');
  await v.click(document.querySelector('.event-view'));
  assert.equal(runs, 1); assert.equal(events.readEvents()[0].read, true);
  assert.equal(document.querySelector('.global-events-panel'), null);
  assert.equal(document.activeElement, v.node.querySelector('button'));
});

test('jumping marks the notice read and the status dot sits in the right slot', async t => {
  events.clearEvents();
  events.recordEvent('已完成的任务', 'success', undefined, 'ux-read-row'); events.markEventsRead();
  events.recordEvent('失败任务提示', 'error', undefined, 'ux-unread-row', { page: 'chat', sessionId: 's9' });
  const opened = [];
  const v = await view(t, Center, { onOpen: target => opened.push(target) });
  await v.click(v.node.querySelector('button'));
  const readCard = [...document.querySelectorAll('.event-card')].find(card => card.classList.contains('is-read'));
  const unreadCard = [...document.querySelectorAll('.event-card')].find(card => card.classList.contains('is-unread'));
  assert.equal(readCard.querySelector('.event-mark-one'), null, 'read rows render no check at all');
  assert.ok(unreadCard.querySelector('.event-row-state .event-mark-one'), 'unread rows keep the revealable check');
  assert.equal(unreadCard.querySelector('.event-mark-one').hasAttribute('disabled'), false);
  // 读态点＝右侧唯一槽位里的状态指示：未读实心、已读弱化；不再挂在时间行上。
  const readDot = readCard.querySelector('.event-row-state .event-read-state.is-read');
  const unreadDot = unreadCard.querySelector('.event-row-state .event-read-state.is-unread');
  assert.ok(readDot && unreadDot, 'both rows carry a read-state dot in the right slot');
  assert.equal(readDot.getAttribute('aria-label'), '已读');
  assert.equal(unreadDot.getAttribute('aria-label'), '未读');
  assert.ok(unreadDot.parentElement.querySelector('.event-mark-one'), 'dot and check share the row-state slot');
  assert.equal(unreadCard.querySelector('.event-card-meta .event-read-state'), null, 'the dot no longer sits next to the time');
  assert.ok(unreadCard.querySelector('.event-card-meta time'), 'time stays in the meta line');
  assert.equal(unreadCard.querySelector('.event-message-link svg'), null, 'the jump link no longer draws a chevron');
  await v.click(unreadCard.querySelector('.event-message-link'));
  assert.equal(events.readEvents().find(item => item.id === 'ux-unread-row').read, true, 'clicking to jump is the read action');
  assert.deepEqual(opened, [{ page: 'chat', sessionId: 's9' }]);
  assert.equal(document.querySelector('.global-events-panel'), null);
});
