import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act } from 'react';
import { loadTsModule } from './load-ts.mjs';
globalThis.window = new Window({ url: 'https://easel.test' }); globalThis.document = window.document; globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { confirmModal } = await loadTsModule('../src/components/ui/ConfirmModal.tsx', import.meta.url);
test('shared confirmation waits for an explicit choice, focuses cancel, and restores focus', async () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus(); let pending, settled = false;
  await act(async () => { pending = confirmModal('确定替换？'); pending.then(() => settled = true); });
  assert.equal(settled, false); assert.equal(document.activeElement.textContent, '取消');
  await act(async () => [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent === '确定').click());
  assert.equal(await pending, true); assert.equal(document.activeElement, opener); assert.equal(document.querySelector('[role=dialog]'), null); opener.remove();
});
test('Escape and backdrop cancel; concurrent confirmations stay sequential', async () => {
  let first, second;
  await act(async () => { first = confirmModal('第一个'); second = confirmModal('第二个'); });
  assert.equal(document.querySelectorAll('[role=dialog]').length, 1); assert.match(document.body.textContent, /第一个/);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); assert.equal(await first, false);
  assert.match(document.body.textContent, /第二个/);
  await act(async () => document.querySelector('.overlay').dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))); assert.equal(await second, false);
});
