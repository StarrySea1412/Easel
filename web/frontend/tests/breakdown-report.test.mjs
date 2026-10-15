import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { loadTsModule } from './load-ts.mjs';

// 《内容拆解报告》契约：提示词固定章节与四要素、保留表现数据边界；
// 页面把有效报告与失败文案分开（错误不可保存），标题取自报告而非输入首行。
// 真实模型输出质量不在本套件范围（见 docs/viral-breakdown-optimization-plan-2026-10-15.md 的评测计划）。
globalThis.window = new Window({ url: 'https://easel.test/' });
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
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

async function mount(t, respond) {
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const path = new URL(String(input), window.location.href).pathname;
    writes.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(String(options.body)) : {} });
    return new Response(JSON.stringify(await respond(path)));
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(BreakdownPage, { persona: '画号A' })));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const buttons = () => [...container.querySelectorAll('button')];
  const click = async (label) => {
    const btn = buttons().find(b => b.textContent.includes(label));
    assert.ok(btn, `button present: ${label}`);
    await act(async () => { btn.focus(); btn.click(); });
    await act(async () => {});
  };
  const fill = async (value) => act(async () => {
    const area = container.querySelector('textarea');
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(area, value);
    area.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  return { container, writes, buttons, click, fill };
}

test('breakdown page sends the report contract and renders the report as a report', async t => {
  const report = '# 内容拆解报告：桌面为什么越收越乱\n\n## 报告摘要\n\n三句话摘要。\n\n## 8. 验证计划\n\n| 待验证问题 | 需要的材料或行动 | 结果能支持到什么程度 |';
  const view = await mount(t, async (path) => (path === '/api/chat' ? { response: report } : { id: 'idea-1' }));
  await view.fill('桌面越收越乱？我把桌子划成三个区。');
  await view.click('开始拆解');

  assert.equal(view.writes[0].path, '/api/chat');
  assert.ok(view.writes[0].body.message.includes('## 4. 全文结构与关键转折'));
  assert.ok(view.writes[0].body.message.includes('没有表现数据，不能判断它为什么火'));
  assert.ok(view.writes[0].body.message.includes('桌面越收越乱？我把桌子划成三个区。'));
  assert.equal(view.writes[0].body.persona, '画号A');
  assert.ok(!view.writes[0].body.message.includes('4. **为什么会火**'), 'old six-point prompt is gone');

  const title = view.container.querySelector('.panel-title');
  assert.ok(title && title.textContent.includes('内容拆解报告'));
  assert.ok(view.container.querySelector('.breakdown-report-note').textContent.includes('缺少表现数据'));
  assert.ok(view.container.querySelector('.skill-body-md').textContent.includes('三句话摘要'));

  await view.click('存入选题库');
  const idea = view.writes.find(w => w.path === '/api/ideas');
  assert.equal(idea.body.title, '内容拆解报告：桌面为什么越收越乱');
  assert.ok(idea.body.note.includes('# 内容拆解报告：'));
  assert.equal(idea.body.source, '爆款拆解');
  assert.equal(view.buttons().some(b => b.textContent.includes('复制报告')), true);
});

test('agent failure text is shown as an error and cannot be saved as a report', async t => {
  const view = await mount(t, async () => ({ response: '❌ 模型服务不可用，请检查配置' }));
  await view.fill('一段正文');
  await view.click('开始拆解');

  assert.equal(view.container.querySelector('.panel'), null, 'no report panel for failures');
  const alert = view.container.querySelector('.notice-error');
  assert.ok(alert && alert.textContent.includes('模型服务不可用'));
  assert.equal(view.buttons().some(b => b.textContent.includes('存入选题库')), false);
  assert.equal(view.writes.length, 1, 'failure is not written anywhere');
});
