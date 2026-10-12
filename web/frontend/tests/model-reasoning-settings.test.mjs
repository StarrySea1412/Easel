import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: Settings } = await loadTsModule('../src/components/settings/ModelReasoningSettings.tsx', import.meta.url);

test('reasoning editor saves the exact model with snapshot guard and prevents duplicate submission', async t => {
  const calls = [], states = [], container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const config = { options: [{ id: 'fixture/unknown-model', label: '测试 · unknown-model', reasoning: null },
    { id: 'fixture/other-model', label: '测试 · other-model', reasoning: false }], fingerprint: 'a'.repeat(64) };
  let finishSave;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/settings/models/reasoning');
    if (!options?.body) return new Response(JSON.stringify(config));
    calls.push(JSON.parse(options.body));
    return new Promise(resolve => { finishSave = () => resolve(new Response(JSON.stringify({ ...config,
      options: [{ ...config.options[0], reasoning: true }, config.options[1]], note: '已保存' }))); });
  });
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(createElement(Settings, { disabled: false, revision: 1, onSaving: value => states.push(value) })));
  const click = async element => { assert.ok(element); await act(async () => element.click()); };
  await click(container.querySelector('[aria-label="推理能力模型"]'));
  await click([...document.querySelectorAll('[role=option]')].find(e => e.textContent.includes('unknown-model')));
  await click(container.querySelector('[aria-label="模型推理声明"]'));
  await click([...document.querySelectorAll('[role=option]')].find(e => e.textContent === '支持推理'));
  const save = [...container.querySelectorAll('button')].find(e => e.textContent === '保存推理声明');
  await act(async () => { save.click(); save.click(); });
  assert.deepEqual(calls, [{ modelRef: 'fixture/unknown-model', reasoning: true, fingerprint: 'a'.repeat(64) }]);
  assert.equal(container.querySelector('[aria-label="模型推理声明"]').disabled, true);
  await act(async () => finishSave());
  assert.deepEqual(states, [true, false]);
  assert.equal(save.disabled, true);
  assert.match(container.textContent, /已保存/);
});
