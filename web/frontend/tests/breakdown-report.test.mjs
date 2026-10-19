import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// 《内容拆解报告》契约：提示词固定章节与四要素、保留表现数据边界；
// 输入面板：材料识别、示例标注、文本文件导入；页面把有效报告与失败文案分开
// （错误可重试、不可保存）。真实模型输出质量不在本套件范围（见总方案的评测计划）。
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage });
globalThis.FileReader = window.FileReader;
globalThis.File = globalThis.File ?? window.File;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { default: BreakdownPage } = await loadTsModule('../src/components/BreakdownPage.tsx', import.meta.url);
const reportLib = await loadTsModule('../src/lib/breakdownReport.ts', import.meta.url);

const CHAPTERS = [
  '报告摘要', '1. 研究对象与材料范围', '2. 内容定位与价值承诺', '3. 标题与开头的具体写法',
  '4. 全文结构与关键转折', '5. 关键发现与替代解释', '6. 表达方式与可信度',
  '7. 可迁移方法与创作方案', '8. 验证计划',
];

test('report prompt carries the fixed chapters, the four finding fields and the no-data boundary', () => {
  const prompt = reportLib.buildBreakdownReportPrompt('桌面越收越乱？我把桌子划成三个区。', '画号A');
  for (const chapter of CHAPTERS) assert.ok(prompt.includes(chapter), `chapter present: ${chapter}`);
  for (const field of ['原文依据', '分析过程', '可能作用', '适用边界']) {
    assert.ok(prompt.includes(field), `finding field present: ${field}`);
  }
  assert.ok(prompt.includes('没有表现数据，不能判断它为什么火'));
  assert.ok(prompt.includes('桌面越收越乱？我把桌子划成三个区。'));
  assert.ok(prompt.includes('画像「画号A」'));
  assert.ok(prompt.includes('多篇'), 'multi-work guard stays in the contract');
  assert.ok(prompt.includes('已读取链接内容'), 'link-read disclosure stays in the contract');
  assert.ok(prompt.includes('不要用代码块'), 'whole-report code fences stay forbidden');

  const withoutPersona = reportLib.buildBreakdownReportPrompt('一段正文');
  assert.ok(withoutPersona.includes('未做个人化'));
  assert.ok(!withoutPersona.includes('画像「'), 'no persona name is invented');
});

test('scope note and saved title follow the report, not the raw input', () => {
  assert.equal(reportLib.isUrlOnlyInput('https://www.xiaohongshu.com/explore/abc123'), true);
  assert.equal(reportLib.isUrlOnlyInput('正文 https://example.com/a'), false);
  assert.equal(reportLib.isUrlOnlyInput(''), false);
  assert.ok(reportLib.reportScopeNote('https://example.com/a').includes('链接'));
  assert.ok(reportLib.reportScopeNote('一段正文').includes('缺少表现数据'));
  assert.equal(reportLib.BREAKDOWN_REPORT_TITLE, '内容拆解报告');
  assert.equal(reportLib.ideaTitleFromReport('# 内容拆解报告：桌面为什么越收越乱\n\n## 报告摘要'),
    '内容拆解报告：桌面为什么越收越乱');
  assert.equal(reportLib.ideaTitleFromReport('没有标题的返回'), '内容拆解报告');
  assert.equal(reportLib.looksLikeAgentFailure('❌ 模型服务不可用'), true);
  assert.equal(reportLib.looksLikeAgentFailure('⏱️ 任务超时'), true);
  assert.equal(reportLib.looksLikeAgentFailure('# 内容拆解报告：x'), false);
});

test('material recognition stays honest about links, share copy and file types', () => {
  const empty = reportLib.summarizeMaterial('   ');
  assert.equal(empty.kind, 'empty');
  assert.ok(reportLib.materialLine(empty).includes('还没有材料'));

  const linkOnly = reportLib.summarizeMaterial('https://www.xiaohongshu.com/explore/abc');
  assert.equal(linkOnly.kind, 'link-only');
  assert.equal(linkOnly.links, 1);
  const linkLine = reportLib.materialLine(linkOnly);
  assert.ok(linkLine.includes('链接'));
  assert.ok(linkLine.includes('实际结果'));
  assert.ok(linkLine.includes('正文'));

  const mixed = reportLib.summarizeMaterial(
    '分享给你，快看\n\n这段正文有两个段落。\n\n第二段。\n\nhttps://v.douyin.com/xyz');
  assert.equal(mixed.kind, 'text-with-link');
  assert.equal(mixed.links, 1);
  assert.equal(mixed.paragraphs, 3);
  assert.equal(mixed.shareCopy, true);
  assert.ok(mixed.chars > 10);
  const line = reportLib.materialLine(mixed);
  assert.ok(line.includes('链接'));
  assert.ok(line.includes('分享口令'));

  assert.equal(reportLib.textFileProblem({ name: 'notes.txt', size: 1000 }), null);
  assert.equal(reportLib.textFileProblem({ name: 'a.MD', size: 1000 }), null);
  assert.equal(reportLib.textFileProblem({ name: 'subtitle.srt', size: 1000 }), null);
  assert.ok(reportLib.textFileProblem({ name: 'shot.png', size: 1000 }).includes('后续版本'));
  assert.ok(reportLib.textFileProblem({ name: 'big.txt', size: 900000 }).includes('512KB'));
  assert.ok(reportLib.EXAMPLE_MATERIAL.length > 80, 'example material is a usable sample');
});

test('quote verification checks only 原文依据 quotes against the material', () => {
  const report = [
    '## 5. 关键发现',
    '### 发现1：x',
    '- **原文依据**：“我都会把桌子收得很空” 出自第一段',
    '- **分析过程**：推断……',
    '### 发现2：y',
    '- **原文依据**：',
    '  「周三，充电线又堆满」',
  ].join('\n');
  const material = '每到周日，我都会把桌子收得很空。到了周三，充电线又堆满。';
  const check = reportLib.verifyQuotes(report, material);
  assert.equal(check.total, 2);
  assert.equal(check.missing.length, 0);

  const bad = reportLib.verifyQuotes(report, '桌面越收越乱。');
  assert.equal(bad.total, 2);
  assert.equal(bad.missing.length, 2);

  assert.equal(reportLib.verifyQuotes('- **原文依据**：没有引号的句子', material).total, 0,
    'quotes without quote marks are not invented');
});

test('ellipsis-stitched quotes list fragments-in-material separately from missing ones', () => {
  const material = '巴黎普通人穿着zara开着破破烂烂的雪铁龙，看着全世界的有钱人在巴黎挥金如土。现在马克龙只有三个选择：派出军队或者谈判。';
  const stitchedReport = '- **原文依据**：“巴黎普通人穿着zara…挥金如土…马克龙只有三个选择”';
  const stitched = reportLib.verifyQuotes(stitchedReport, material);
  assert.equal(stitched.total, 1);
  assert.equal(stitched.stitched, 1, 'all fragments present counts as stitched, not verbatim');
  assert.equal(stitched.found, 0);
  assert.equal(stitched.missing.length, 0);

  const absent = reportLib.verifyQuotes('- **原文依据**：“完全不存在的句子甲…完全不存在的句子乙”', material);
  assert.equal(absent.stitched, 0);
  assert.equal(absent.missing.length, 1, 'absent fragments still count as missing');

  const partial = reportLib.verifyQuotes('- **原文依据**：“挥金如土…完全不存在的句子乙”', material);
  assert.equal(partial.stitched, 0, 'a missing fragment downgrades the whole quote');
  assert.equal(partial.missing.length, 1);
});

test('structure verification flags missing chapters and incomplete findings', () => {
  const full = [
    '## 报告摘要', '## 1. 研究对象与材料范围', '## 2. 内容定位与价值承诺', '## 3. 标题与开头的具体写法',
    '## 4. 全文结构与关键转折', '## 5. 关键发现与替代解释',
    '### 发现1：x', '- **原文依据**：“a”', '- **分析过程**：b', '- **可能作用**：c', '- **适用边界**：d',
    '## 6. 表达方式与可信度', '## 7. 可迁移方法与创作方案', '## 8. 验证计划',
  ].join('\n');
  const ok = reportLib.verifyStructure(full);
  assert.deepEqual(ok.missingSections, []);
  assert.equal(ok.findings, 1);
  assert.equal(ok.incompleteFindings, 0);
  assert.ok(reportLib.structureLine(ok).includes('章节齐全'));
  assert.ok(reportLib.structureLine(ok).includes('都带四要素'));

  const bad = reportLib.verifyStructure('## 报告摘要\n### 发现1：x\n- **原文依据**：“a”\n');
  assert.ok(bad.missingSections.includes('验证计划'));
  assert.equal(bad.incompleteFindings, 1);
  assert.ok(reportLib.structureLine(bad).includes('四要素不全'));
});

test('text file reading returns local content without touching the server', async () => {
  const file = new window.File(['一段从文件导入的正文'], 'note.txt', { type: 'text/plain' });
  assert.equal(await reportLib.readTextFile(file), '一段从文件导入的正文');
});

// 与工作台同源的执行控件：模型/思考强度来自能力接口与本地偏好（默认“自适应最高”）。
const CAPABILITY = {
  available: true, scope: 'next_turn', currentModelRef: 'relay/kimi-k3', defaultModelRef: 'relay/kimi-k3',
  options: [{ id: 'relay/kimi-k3', provider: 'relay', model: 'kimi-k3', configured: true, channelName: '测试渠道', thinkingLevels: ['off'] }],
};
const HEALTH = { results: [], schedules: [], limit: { requests: 0, windowSeconds: 0, automaticModelsPerProvider: 0 }, staleAfterSeconds: 900, serverTime: 0 };
const CONNECTION = { modelRef: 'relay/kimi-k3', state: 'unverified', channelName: '测试渠道', detail: '未验证' };

async function mount(t, respond, { keepStorage = false, onStart = () => true, onOpenRun = () => true } = {}) {
  const writes = [];
  const starts = []; const opened = [];
  if (!keepStorage) { try { window.localStorage.clear(); } catch { /* optional storage */ } }
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const path = new URL(String(input), window.location.href).pathname;
    writes.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(String(options.body)) : {} });
    if (path === '/api/agent-office/models') return new Response(JSON.stringify(CAPABILITY));
    if (path === '/api/settings/models/health') return new Response(JSON.stringify(HEALTH));
    if (path === '/api/settings/models/connection') return new Response(JSON.stringify(CONNECTION));
    const result = await respond(path);
    return result instanceof Response ? result : new Response(JSON.stringify(result));
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(BreakdownPage, { persona: '画号A', onStart: (...args) => { starts.push(args); return onStart(...args); }, onOpenRun: run => { opened.push(run); return onOpenRun(run); } })));
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await act(async () => root.unmount());
    container.remove();
  };
  t.after(unmount);
  const buttons = () => [...container.querySelectorAll('button')];
  const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const click = async (label) => {
    const btn = buttons().find(b => b.textContent.includes(label));
    assert.ok(btn, `button present: ${label}`);
    await act(async () => { btn.focus(); btn.click(); });
    await flush();
  };
  const fill = async (value) => act(async () => {
    const area = container.querySelector('textarea');
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(area, value);
    area.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  return { container, writes, starts, opened, buttons, click, fill, flush, unmount };
}

test('input panel offers a marked example when empty and recognizes material while typing', async t => {
  const view = await mount(t, async () => ({ response: '# 内容拆解报告：x' }));
  assert.equal(view.container.querySelector('.breakdown-material'), null, 'no material line before input');

  // 空状态：示例入口可见，点击后填入虚构示例并明确标注
  await view.click('看看示例');
  const chip = view.container.querySelector('.breakdown-chip');
  assert.ok(chip && chip.textContent.includes('虚构'), 'example is clearly marked as fictional');
  assert.ok(view.container.querySelector('textarea').value.includes('桌面越收越乱'));
  assert.equal(view.container.querySelector('.breakdown-example-link'), null, 'example entry hides once material exists');

  // 有材料：识别行随输入更新，可被读屏宣读
  await view.fill('桌面越收越乱？我把桌子划成三个区。');
  const card = view.container.querySelector('.breakdown-material');
  assert.ok(card, 'material line appears with input');
  assert.ok(card.textContent.includes('正文约'));
  assert.equal(card.getAttribute('role'), 'status');

  // 清空回到空状态：示例入口恢复
  await view.click('清空');
  assert.equal(view.container.querySelector('textarea').value, '');
  assert.equal(view.container.querySelector('.breakdown-chip'), null);
  assert.ok(view.container.querySelector('.breakdown-example-link'), 'example entry returns when empty');
});

test('material and model controls hand off once to the shared chat lifecycle, without a second request', async t => {
  const view = await mount(t, async () => ({}));
  await view.fill('桌面越收越乱？我把桌子划成三个区。');
  assert.ok(view.container.querySelector('[aria-label^="思考强度"]'));
  assert.ok(view.container.querySelector('.composer-model-health-label'));
  await view.click('开始拆解');
  assert.equal(view.starts.length, 1);
  assert.equal(view.starts[0][0], '桌面越收越乱？我把桌子划成三个区。');
  assert.equal(view.starts[0][1], undefined);
  assert.equal(view.starts[0][2], 'off');
  assert.equal(view.writes.some(item => item.path.startsWith('/api/chat/')), false);
});

test('a rejected handoff keeps the material and offers a retry without a savable fake report', async t => {
  const view = await mount(t, async () => ({}), { onStart: () => false });
  await view.fill('一段正文'); await view.click('开始拆解');
  assert.match(view.container.querySelector('[role="alert"]').textContent, /材料已保留/);
  assert.equal(view.container.querySelector('textarea').value, '一段正文');
  assert.equal(view.container.querySelector('.breakdown-report'), null);
  await view.click('重试');
  assert.equal(view.starts.length, 2);
});

test('draft survives leaving the page and coming back', async t => {
  window.localStorage.clear();
  const first = await mount(t, async () => ({ id: 'x' }), { keepStorage: true });
  await first.fill('这一段是没写完的草稿。');
  await first.unmount();

  const second = await mount(t, async () => ({ id: 'x' }), { keepStorage: true });
  assert.equal(second.container.querySelector('textarea').value, '这一段是没写完的草稿。', 'draft is restored');
  assert.ok(second.container.querySelector('.breakdown-material').textContent.includes('正文约'), 'material line follows the draft');
});

test('existing history reopens in the shared reader, preserves evidence checks and saves the real report', async t => {
  window.localStorage.clear();
  const report = '# 内容拆解报告：桌面为什么越收越乱\n\n## 5. 关键发现与替代解释\n\n- **原文依据**：“桌面越来越乱”\n- **原文依据**：“不存在的句子”';
  window.localStorage.setItem('easel_breakdown_history', JSON.stringify([{ id: 'old', title: '桌面报告', material: '桌面越来越乱，我决定换个办法。', report, at: 1 }]));
  const view = await mount(t, async () => ({ id: 'idea-1' }), { keepStorage: true });
  await view.click('历史拆解'); await view.click('桌面报告');
  assert.equal(view.container.querySelector('textarea').value, '桌面越来越乱，我决定换个办法。');
  assert.match(view.container.querySelector('.breakdown-quote-check').textContent, /2 处引用里，1 处/);
  assert.match(view.container.querySelector('.breakdown-quote-details').textContent, /不存在的句子/);
  assert.match(view.container.querySelector('.breakdown-structure-check').textContent, /缺章节/);
  await view.click('存入选题库');
  assert.equal(view.writes.find(item => item.path === '/api/ideas').body.note, report);
  await view.click('历史拆解'); await view.click('删除');
  assert.equal(view.container.querySelector('.breakdown-history-toggle'), null);
});

test('a whole-report code fence is unwrapped before rendering and saving', () => {
  const fenced = '```markdown\n# 内容拆解报告：桌面\n\n## 报告摘要\n正文。\n```';
  assert.equal(reportLib.unwrapReportFence(fenced), '# 内容拆解报告：桌面\n\n## 报告摘要\n正文。');
  assert.equal(reportLib.unwrapReportFence('```\n# 内容拆解报告：桌面\n```'), '# 内容拆解报告：桌面');
  assert.equal(reportLib.unwrapReportFence('```markdown\n# 内容拆解报告：桌面\n正文漏了闭合栅栏'),
    '# 内容拆解报告：桌面\n正文漏了闭合栅栏');
  const plain = '# 内容拆解报告：桌面\n\n## 报告摘要\n正文。';
  assert.equal(reportLib.unwrapReportFence(plain), plain, '普通报告原样返回');
  const inner = '# 内容拆解报告：桌面\n\n示例：\n```js\nconsole.log(1)\n```\n结束。';
  assert.equal(reportLib.unwrapReportFence(inner), inner, '内文代码块保持原样');
});

test('a fenced stored report renders as markdown and saves the unwrapped body', async t => {
  window.localStorage.clear();
  const inner = '# 内容拆解报告：桌面为什么越收越乱\n\n## 报告摘要\n正文。\n\n## 5. 关键发现与替代解释\n\n- **原文依据**：“桌面越来越乱”';
  window.localStorage.setItem('easel_breakdown_history', JSON.stringify([{ id: 'fenced', title: '桌面报告', material: '桌面越来越乱，我决定换个办法。', report: '```markdown\n' + inner + '\n```', at: 1 }]));
  const view = await mount(t, async () => ({ id: 'idea-1' }), { keepStorage: true });
  await view.click('历史拆解'); await view.click('桌面报告');
  const report = view.container.querySelector('.breakdown-report');
  assert.ok(report.querySelector('h2'), '标题按 Markdown 渲染而不是代码');
  assert.equal(report.querySelector('code'), null, '整篇不再落入代码块');
  assert.ok(report.textContent.includes('报告摘要'));
  assert.ok(!report.textContent.includes('##'), '不再展示 Markdown 源码');
  await view.click('存入选题库');
  assert.equal(view.writes.find(item => item.path === '/api/ideas').body.note, inner);
});

test('legacy unfinished work opens the same identity in chat and is never silently restarted or discarded for age', async t => {
  window.localStorage.clear();
  const run = { sessionId: 'breakdown-old', turnId: 'breakdown-old-1', material: '上次材料', startedAt: Date.now() - 48 * 3600000 };
  window.localStorage.setItem('easel_breakdown_active_run', JSON.stringify(run));
  const view = await mount(t, async () => ({}), { keepStorage: true });
  assert.equal(view.writes.some(item => item.path.startsWith('/api/chat/')), false);
  await view.click('在对话中查看上次拆解');
  assert.deepEqual(view.opened, [run]);
  assert.deepEqual(JSON.parse(window.localStorage.getItem('easel_breakdown_active_run')), run);
  assert.equal(view.starts.length, 0);
});
