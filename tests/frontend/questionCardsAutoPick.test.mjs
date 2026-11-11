import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const require = createRequire(new URL('../../web/frontend/package.json', import.meta.url));
const ts = require('typescript');
const { JSDOM } = require('jsdom');

const dom = new JSDOM(
  '<!doctype html><html><head><title>Easel 工作台</title></head><body><div id="root"></div></body></html>',
  { url: 'http://127.0.0.1/' },
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 22 的 globalThis.navigator 是只读 getter，必须用 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;

const source = readFileSync(new URL('../../web/frontend/src/components/QuestionCards.tsx', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
});

const calls = [];
const component = { exports: {} };
runInNewContext(outputText, {
  exports: component.exports,
  require: name => name === '../lib/api'
    ? {
        answerQuestion: async payload => {
          calls.push(payload);
          return { ok: true };
        },
      }
    : require(name),
  window: dom.window,
  document: dom.window.document,
});

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;

const waitFor = async (predicate, timeoutMs = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  return predicate();
};

const mount = async element => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return { container, root, unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
};

test('30 秒无操作自动选择推荐项并带上来源标记', async () => {
  calls.length = 0;
  const mounted = await mount(React.createElement(component.exports.default, {
    autoPickMs: 100,
    questions: [{
      id: 'q-auto',
      questions: [{
        questionId: 'scope',
        question: '要发布到哪个平台？',
        // 推荐项故意放在第二位，验证按 recommended 标记而非「首个选项」来选。
        options: [{ label: '小红书' }, { label: '知乎', recommended: true }],
      }],
    }],
  }));
  try {
    assert.ok(await waitFor(() => calls.length > 0), '超时后应当自动提交');
    // answers 由组件在 runInNewContext 的 realm 内构造，按 JSON 结构比较。
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].answers)), { scope: ['知乎'] });
    assert.equal(calls[0].resolvedBy, 'auto-timeout');
    assert.equal(calls[0].questionId, 'q-auto');
  } finally {
    await mounted.unmount();
  }
});

test('没有选项也没有填写时不自动提交，避免凭空编造答案', async () => {
  calls.length = 0;
  const mounted = await mount(React.createElement(component.exports.default, {
    autoPickMs: 100,
    questions: [{
      id: 'q-free',
      questions: [{ questionId: 'idea', question: '你想做什么内容？', options: [] }],
    }],
  }));
  try {
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal(calls.length, 0, '自由文本题没有推荐项，不能自动作答');
  } finally {
    await mounted.unmount();
  }
});

test('有未答问题时标签页标题带提醒，答完恢复', async () => {
  calls.length = 0;
  const baseTitle = dom.window.document.title;
  const mounted = await mount(React.createElement(component.exports.default, {
    autoPickMs: 60000,
    questions: [{
      id: 'q-tab',
      questions: [{ questionId: 'pick', question: '选一个', options: [{ label: 'A' }] }],
    }],
  }));
  try {
    assert.equal(dom.window.document.title, '● 1 个问题待回复 · Easel 工作台');
    assert.ok(mounted.container.innerHTML.includes('question-card__recommended'), '推荐项要有可见标识');
    assert.ok(mounted.container.innerHTML.includes('将自动选择推荐项并提交'), '要提示会自动选择');
  } finally {
    await mounted.unmount();
  }
  assert.equal(dom.window.document.title, baseTitle, '卸载后要还原标题');
});

test('resolveAnswers 只在允许时补推荐项，补不齐返回 null', () => {
  const items = [
    { questionId: 'a', question: 'A', options: [{ label: 'A1' }, { label: 'A2', recommended: true }] },
    { questionId: 'b', question: 'B', options: [] },
  ];
  // 返回值来自 runInNewContext 的独立 realm，原型不同，按 JSON 结构比较。
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.equal(component.exports.resolveAnswers(items, {}, {}, false), null);
  assert.deepEqual(
    plain(component.exports.resolveAnswers(items, { b: ['手写答案'] }, {}, true)),
    { a: ['A2'], b: ['手写答案'] },
  );
  assert.equal(component.exports.resolveAnswers(items, {}, {}, true), null);
});

test('recommendedLabel 优先显式标记，其次回退首个选项', () => {
  assert.equal(component.exports.recommendedLabel({ questionId: 'x', question: 'x', options: [{ label: '一' }, { label: '二', recommended: true }] }), '二');
  assert.equal(component.exports.recommendedLabel({ questionId: 'x', question: 'x', options: [{ label: '一' }, { label: '二' }] }), '一');
  assert.equal(component.exports.recommendedLabel({ questionId: 'x', question: 'x', options: [] }), null);
});
