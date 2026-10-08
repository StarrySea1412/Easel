import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// Actual page interactions with controlled HTTP. Layout is checked separately
// in a real browser; this suite does not assert CSS strings or geometry.
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: CalendarPage } = await loadTsModule('../src/components/CalendarPage.tsx', import.meta.url);
const { default: IdeasPage } = await loadTsModule('../src/components/IdeasPage.tsx', import.meta.url);

async function mount(t, Page, { schedule = [], ideas = [], props = {} } = {}) {
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const path = new URL(String(input), window.location.href).pathname;
    if (options.method && options.method !== 'GET') {
      writes.push({ path, method: options.method, body: JSON.parse(options.body || '{}') });
      return new Response(JSON.stringify({ id: path.split('/').at(-1), ...writes.at(-1).body }));
    }
    const data = path === '/api/schedule/context' ? {} : path === '/api/schedule' ? schedule : path === '/api/ideas' ? ideas : null;
    assert.notEqual(data, null, `unexpected request: ${path}`);
    return new Response(JSON.stringify(data));
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Page, props)));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const click = async button => {
    assert.ok(button, 'the control is present');
    await act(async () => { button.focus(); button.click(); });
  };
  const key = async (key, shiftKey = false) => act(async () => {
    document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  });
  const fill = async (input, value) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  return { container, writes, click, key, fill };
}

test('calendar date control opens the right day and keeps keyboard focus inside its form', async t => {
  const view = await mount(t, CalendarPage);
  const originalMonth = view.container.querySelector('.cal-month').textContent;
  await view.click(view.container.querySelector('[aria-label="下个月"]'));
  assert.notEqual(view.container.querySelector('.cal-month').textContent, originalMonth);
  await view.click(view.container.querySelector('[aria-label="上个月"]'));
  assert.equal(view.container.querySelector('.cal-month').textContent, originalMonth);

  const day = view.container.querySelector('button.cal-daynum');
  const date = day.getAttribute('aria-label').slice(0, 10);
  await view.click(day);
  const dialog = view.container.querySelector('[role="dialog"]');
  assert.equal(dialog.querySelector('input[type="date"]').value, date);
  assert.equal(document.activeElement, dialog.querySelector('[data-modal-autofocus]'));
  const controls = [...dialog.querySelectorAll('button:not(:disabled), input, textarea')];
  controls.at(-1).focus();
  await view.key('Tab');
  assert.equal(document.activeElement, controls[0]);
  await view.key('Tab', true);
  assert.equal(document.activeElement, controls.at(-1));
  await view.key('Escape');
  assert.equal(view.container.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, day);
  assert.equal(view.writes.length, 0);
});

test('calendar day summary exposes every item and event controls edit only the chosen record', async t => {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-15`;
  const schedule = Array.from({ length: 5 }, (_, index) => ({
    id: `schedule-${index}`, title: `安排 ${index}`, date, platform: '小红书', time: '10:00',
    status: 'scheduled', note: `备注 ${index}`, kind: index === 0 ? 'event' : 'content',
  }));
  const view = await mount(t, CalendarPage, { schedule });
  const day = [...view.container.querySelectorAll('button.cal-daynum')].find(button => button.getAttribute('aria-label').startsWith(date));
  assert.match(day.getAttribute('aria-label'), /5 项安排/);
  await view.click(day);
  const daily = view.container.querySelector('[role="dialog"]');
  assert.equal(daily.querySelectorAll('button.cal-event').length, 5, 'items beyond the desktop three-item preview remain reachable');
  await view.click(daily.querySelectorAll('button.cal-event')[3]);
  const form = view.container.querySelector('[role="dialog"]');
  assert.equal(view.container.querySelectorAll('[role="dialog"]').length, 1);
  assert.equal(form.querySelector('[data-modal-autofocus]').value, '安排 3');
  assert.equal(form.querySelector('textarea').value, '备注 3');
  await view.fill(form.querySelector('[data-modal-autofocus]'), '安排 3 已修改');
  await view.click([...form.querySelectorAll('button')].find(button => button.textContent === '保存'));
  assert.equal(view.writes.length, 1);
  assert.equal(view.writes[0].path, '/api/schedule/schedule-3');
  assert.equal(view.writes[0].method, 'PUT');
  assert.equal(view.writes[0].body.title, '安排 3 已修改');
  assert.equal(view.writes[0].body.date, date);
});

test('idea edit controls open the selected card, restore focus on cancel and preserve its identity on save', async t => {
  const ideas = [
    { id: 'first', title: '第一个选题', note: '笔记一', source: '热点', status: 'pending', created: 1 },
    { id: 'second', title: '第二个选题', note: '笔记二', source: '手动', status: 'doing', created: 2 },
  ];
  const view = await mount(t, IdeasPage, { ideas, props: { onUseTopic() {} } });
  const edit = view.container.querySelector('[aria-label="编辑选题：第二个选题"]');
  await view.click(edit);
  let form = view.container.querySelector('[role="dialog"]');
  assert.equal(form.querySelector('[data-modal-autofocus]').value, '第二个选题');
  await view.key('Escape');
  assert.equal(view.container.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, edit);
  assert.equal(view.writes.length, 0);
  await view.click(edit);
  form = view.container.querySelector('[role="dialog"]');
  await view.fill(form.querySelector('[data-modal-autofocus]'), '第二个选题已修改');
  await view.click([...form.querySelectorAll('button')].find(button => button.textContent === '保存'));
  assert.deepEqual(view.writes, [{ path: '/api/ideas/second', method: 'PUT', body: {
    title: '第二个选题已修改', note: '笔记二', source: '手动', status: 'doing',
  } }]);
});
