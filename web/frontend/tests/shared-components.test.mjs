import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { tsModuleUrl } from './load-ts.mjs';

// Small shared components rendered for real: skeleton placeholders, platform
// icons (brand file vs neutral fallback) and the chat turn navigation.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');

const skeletonUrl = await tsModuleUrl(new URL('../src/components/Skeleton.tsx', import.meta.url));
const platformUrl = await tsModuleUrl(new URL('../src/components/PlatformIcon.tsx', import.meta.url));
const turnUrl = await tsModuleUrl(new URL('../src/components/ChatTurnNavigation.tsx', import.meta.url));

async function mount(t, url, props) {
  const module = await import(url);
  const Component = module.default ?? Object.values(module)[0];
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Component, props)));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return container;
}

test('skeleton renders title bar, requested rows and image ratio label', async t => {
  const Sk = (await import(skeletonUrl));
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement('div', null,
    createElement(Sk.SkeletonCard, { rows: 4, title: true }),
    createElement(Sk.SkeletonImage, { ratio: '16 / 9', label: '封面加载中' }),
  )));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  assert.equal(container.querySelectorAll('.sk-row, [class*="sk"]').length >= 4, true);
  assert.ok(container.textContent.includes('封面加载中'), 'image skeleton keeps its loading label for screen readers');
});

test('platform icon uses brand image for known platforms and neutral svg for unknown', async t => {
  const known = await mount(t, platformUrl, { platform: 'xiaohongshu', name: '小红书' });
  const img = known.querySelector('img.platform-icon');
  assert.ok(img, 'known platform renders its brand asset');
  assert.equal(img.getAttribute('alt'), '小红书标志');

  const unknown = await mount(t, platformUrl, { platform: 'future-net', name: '未来平台' });
  const svg = unknown.querySelector('svg.platform-icon');
  assert.ok(svg, 'unknown platform renders the neutral globe');
  assert.equal(svg.getAttribute('role'), 'img');
  assert.equal(svg.getAttribute('aria-label'), '未来平台');
  assert.equal(unknown.querySelector('img'), null, 'no invented brand file is used');
});

test('turn directory opens at the current turn and preserves keyboard jumps and latest controls', async t => {
  const jumps = []; let latest = 0;
  const nodes = [
    { messageIndex: 0, number: 1, label: '第一轮' },
    { messageIndex: 3, number: 2, label: '第二轮' },
    { messageIndex: 6, number: 3, label: '第三轮' },
  ];
  const container = await mount(t, turnUrl, {
    nodes, current: 1, following: false,
    onJump: index => jumps.push(index), onLatest: () => latest++,
  });
  const trigger = container.querySelector('.chat-turn-nav-trigger');
  const open = async () => act(async () => trigger.click());
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(container.querySelector('.chat-turn-popover'), null);
  await open();
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, container.querySelector('ol button[aria-current]'));
  assert.equal(container.querySelector('[aria-label="跳转上一轮对话"]').disabled, false);
  assert.equal(container.querySelector('[aria-label="跳转下一轮对话"]').disabled, false);
  await act(async () => container.querySelector('[aria-label="跳转上一轮对话"]').click());
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, trigger);
  await open();
  await act(async () => container.querySelector('[aria-label="回到底部并跟随最新回复"]').click());
  assert.deepEqual(jumps, [0]);
  assert.equal(latest, 1);
  assert.ok(container.textContent.includes('2 / 3'), 'counter reflects current index');

  // Keyboard navigation remains open for browsing successive turns.
  await open();
  const list = [...container.querySelectorAll('ol button')];
  await act(async () => { list[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
  assert.equal(jumps.at(-1), 1, 'ArrowDown on node 0 jumps to node 1');
  assert.equal(document.activeElement, list[1]);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  for (const [key, target] of [['End', 2], ['Home', 0], ['ArrowUp', 0]]) {
    await act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true })));
    assert.equal(jumps.at(-1), target);
    assert.equal(document.activeElement, list[target]);
  }
});

test('turn directory dismisses with Escape or outside pointer and keeps outside focus intact', async t => {
  const container = await mount(t, turnUrl, {
    nodes: [{ messageIndex: 0, number: 1, label: '唯一轮次' }], current: 0, following: true,
    onJump() {}, onLatest() {},
  });
  const trigger = container.querySelector('.chat-turn-nav-trigger');
  await act(async () => trigger.click());
  assert.equal(container.querySelector('[aria-label="跳转上一轮对话"]').disabled, true);
  assert.equal(container.querySelector('[aria-label="跳转下一轮对话"]').disabled, true);
  await act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, trigger);

  await act(async () => trigger.click());
  const outside = document.createElement('input'); document.body.append(outside);
  t.after(() => outside.remove());
  await act(async () => {
    outside.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
    outside.focus(); // Browsers focus the clicked control after pointerdown.
  });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, outside);
});

test('choosing a turn closes the directory without stealing destination focus', async t => {
  const destination = document.createElement('div'); destination.tabIndex = -1; document.body.append(destination);
  t.after(() => destination.remove());
  let jumped;
  const container = await mount(t, turnUrl, {
    nodes: [{ messageIndex: 0, number: 1, label: '目标轮次' }], current: 0, following: false,
    onJump(index) { jumped = index; destination.focus(); }, onLatest() {},
  });
  const trigger = container.querySelector('.chat-turn-nav-trigger');
  await act(async () => trigger.click());
  await act(async () => container.querySelector('ol button').click());
  assert.equal(jumped, 0);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, destination);
});
