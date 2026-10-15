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

function sse(frames, { keepOpen = false } = {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (!keepOpen) controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const sseToken = (id, text) => `id: ${id}\nevent: token\ndata: ${JSON.stringify(text)}\n\n`;
const sseDone = (id) => `id: ${id}\nevent: done\ndata: {}\n\n`;
const sseError = (id, message) => `id: ${id}\nevent: error\ndata: ${JSON.stringify({ message })}\n\n`;

async function mount(t, respond, { keepStorage = false } = {}) {
  const writes = [];
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
  await act(async () => root.render(createElement(BreakdownPage, { persona: '画号A' })));
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
  return { container, writes, buttons, click, fill, flush, unmount };
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

test('breakdown page runs through the streaming task api with the workspace controls', async t => {
  const report = '# 内容拆解报告：桌面为什么越收越乱\n\n## 报告摘要\n\n三句话摘要。\n\n## 8. 验证计划\n\n| 待验证问题 | 需要的材料或行动 | 结果能支持到什么程度 |';
  const view = await mount(t, async (path) => (path === '/api/chat/stream'
    ? sse([sseToken(1, report), sseDone(2)]) : { id: 'idea-1' }));
  await view.fill('桌面越收越乱？我把桌子划成三个区。');

  const tools = view.container.querySelector('.dash-composer-tools');
  assert.ok(tools && tools.querySelector('[aria-label^="思考强度"]'), 'thinking control sits in the composer tools');
  assert.ok(tools.querySelector('.composer-model-health-label'), 'model control sits in the composer tools');

  await view.click('开始拆解');
  const chat = view.writes.find(w => w.path === '/api/chat/stream');
  assert.ok(chat, 'runs through the streaming task endpoint (same as the workspace composer)');
  assert.ok(chat.body.message.includes('## 4. 全文结构与关键转折'));
  assert.ok(chat.body.message.includes('没有表现数据，不能判断它为什么火'));
  assert.ok(chat.body.message.includes('桌面越收越乱？我把桌子划成三个区。'));
  assert.equal(chat.body.persona, '画号A');
  assert.equal(chat.body.thinkingLevel, 'off', 'resolved thinking level follows the model capability');
  assert.equal(chat.body.modelRef, undefined, 'default keeps the shared model');
  assert.ok(String(chat.body.sessionId).startsWith('breakdown-'), 'breakdown run keeps its own session key');

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
  assert.equal(window.localStorage.getItem('easel_breakdown_active_run'), '', 'finished runs leave no active-run record');
});

test('stream failures are an error with a retry, never a savable report', async t => {
  const view = await mount(t, async (path) => (path === '/api/chat/stream'
    ? sse([sseError(1, '模型服务不可用，请检查配置')]) : { id: 'idea-1' }));
  await view.fill('一段正文');
  await view.click('开始拆解');

  assert.equal(view.container.querySelector('.panel'), null, 'no report panel for failures');
  const alert = view.container.querySelector('.notice-error');
  assert.ok(alert && alert.textContent.includes('模型服务不可用'));
  assert.equal(view.buttons().some(b => b.textContent.includes('存入选题库')), false);
  assert.equal(view.writes.filter(w => w.path === '/api/ideas').length, 0, 'failure is not written anywhere');
  assert.equal(view.container.querySelector('textarea').value, '一段正文', 'material is kept for retry');

  await view.click('重试');
  assert.equal(view.writes.filter(w => w.path === '/api/chat/stream').length, 2, 'retry re-runs the request');
});

test('a running report shows progress and can be stopped for real', async t => {
  const view = await mount(t, async (path) => {
    if (path === '/api/chat/stream') return sse([sseToken(1, '# 内容拆解报告：正在写')], { keepOpen: true });
    return { stopped: true };
  });
  await view.fill('一段正文');
  await view.click('开始拆解');

  assert.ok(view.container.querySelector('.breakdown-stream'), 'live progress panel shows while running');
  assert.ok(view.container.querySelector('.breakdown-stream').textContent.includes('正在写'), 'tokens appear as they arrive');

  await view.click('停止');
  const stop = view.writes.find(w => w.path === '/api/chat/stop');
  assert.ok(stop && String(stop.body.sessionId).startsWith('breakdown-'), 'stop reaches the backend run');
  assert.ok(view.container.querySelector('.notice-error').textContent.includes('已停止'));
  assert.equal(view.container.querySelector('.panel'), null, 'no report panel after stop');
  assert.equal(view.container.querySelector('textarea').value, '一段正文', 'material survives the stop');
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

test('finished reports land in history and can be reopened or deleted', async t => {
  const report = '# 内容拆解报告：桌面为什么越收越乱\n\n## 报告摘要\n\n一。\n\n- **原文依据**：“桌面越来越乱”';
  const view = await mount(t, async (path) => (path === '/api/chat/stream' ? sse([sseToken(1, report), sseDone(2)]) : { id: 'idea-1' }));
  await view.fill('桌面越来越乱，我决定换个办法。');
  await view.click('开始拆解');

  const toggle = view.container.querySelector('.breakdown-history-toggle');
  assert.ok(toggle && toggle.textContent.includes('历史拆解 1 篇'), 'finished report is stored in history');
  await view.click('历史拆解');
  assert.ok(view.container.querySelector('.breakdown-history-item').textContent.includes('内容拆解报告：桌面为什么越收越乱'));

  await view.click('内容拆解报告：桌面为什么越收越乱');
  assert.ok(view.container.querySelector('.skill-body-md').textContent.includes('报告摘要'), 'history reopens the report');
  assert.equal(view.container.querySelector('textarea').value, '桌面越来越乱，我决定换个办法。', 'history restores the material');
  assert.equal(view.container.querySelector('.breakdown-history-list'), null, 'history list collapses after opening');

  await view.click('历史拆解');
  await view.click('删除');
  assert.equal(view.container.querySelector('.breakdown-history-toggle'), null, 'deleting the last record hides history');
});

test('report quotes are verified against the submitted material', async t => {
  const report = [
    '# 内容拆解报告：测试', '',
    '## 5. 关键发现与替代解释', '',
    '- **原文依据**：“桌面越来越乱” — 出自开头', '',
    '- **原文依据**：“材料里没有的句子” — 出处不明', '',
    '正文。',
  ].join('\n');
  const view = await mount(t, async (path) => (path === '/api/chat/stream' ? sse([sseToken(1, report), sseDone(2)]) : {}));
  await view.fill('桌面越来越乱，我决定换个办法。');
  await view.click('开始拆解');

  const check = view.container.querySelector('.breakdown-quote-check');
  assert.ok(check, 'quote check line renders with the report');
  assert.ok(check.textContent.includes('2 处引用里，1 处没能在材料中逐字找到'));
  assert.ok(check.className.includes('warn'));
  const details = view.container.querySelector('.breakdown-quote-details');
  assert.ok(details && details.textContent.includes('材料里没有的句子'), 'missing quote is listed for review');

  const structure = view.container.querySelector('.breakdown-structure-check');
  assert.ok(structure, 'structure check line renders with the report');
  assert.ok(structure.textContent.includes('缺章节'), 'missing chapters are named');
  assert.ok(structure.textContent.includes('没有识别到'), 'missing findings section is named');
  assert.ok(structure.className.includes('warn'));
});

test('link-only failures offer pasting the text instead', async t => {
  const view = await mount(t, async (path) => (path === '/api/chat/stream' ? sse([sseError(1, '读取失败')]) : {}));
  await view.fill('https://www.xiaohongshu.com/explore/abc');
  await view.click('开始拆解');

  const alert = view.container.querySelector('.notice-error');
  assert.ok(alert.textContent.includes('把正文粘贴进来再试'), 'link-only failure explains the fix');
  await view.click('补正文');
  assert.equal(document.activeElement, view.container.querySelector('textarea'), '补正文 focuses the composer');
});

test('an unfinished run is recovered after leaving the page and coming back', async t => {
  window.localStorage.clear();
  window.localStorage.setItem('easel_breakdown_active_run', JSON.stringify({
    sessionId: 'breakdown-old', turnId: 'breakdown-old-1', material: '上次的材料：桌面越收越乱。', startedAt: Date.now(),
  }));
  const report = '# 内容拆解报告：取回\n\n## 报告摘要\n\n取回成功。';
  const view = await mount(t, async (path) => (path === '/api/chat/jobs/breakdown-old-1/stream'
    ? sse([sseToken(1, report), sseDone(2)]) : {}), { keepStorage: true });

  assert.ok(view.writes.some(w => w.path === '/api/chat/jobs/breakdown-old-1/stream'), 'resume reads the job stream');
  const body = view.container.querySelector('.skill-body-md');
  assert.ok(body && body.textContent.includes('取回成功'), 'recovered report renders');
  assert.equal(window.localStorage.getItem('easel_breakdown_active_run'), '', 'active run is cleared after recovery');
  assert.ok(view.container.querySelector('.breakdown-history-toggle').textContent.includes('历史拆解 1 篇'),
    'recovered report lands in history');
  assert.equal(view.container.querySelector('textarea').value, '上次的材料：桌面越收越乱。',
    'material restores when the draft is empty');
});

test('recovery falls back to the last-turn snapshot when the job stream is gone', async t => {
  window.localStorage.clear();
  window.localStorage.setItem('easel_breakdown_active_run', JSON.stringify({
    sessionId: 'breakdown-gone', turnId: 'breakdown-gone-1', material: '材料', startedAt: Date.now(),
  }));
  const view = await mount(t, async (path) => {
    if (path === '/api/chat/jobs/breakdown-gone-1/stream') return new Response('', { status: 404 });
    if (path === '/api/chat/last/breakdown-gone') {
      return { status: 'done', text: '# 内容拆解报告：快照\n\n## 报告摘要\n\n从快照取回。', turn_id: 'breakdown-gone-1' };
    }
    return {};
  }, { keepStorage: true });

  await view.flush();
  await view.flush();
  const body = view.container.querySelector('.skill-body-md');
  assert.ok(body && body.textContent.includes('从快照取回'), 'snapshot fallback renders');
  assert.equal(window.localStorage.getItem('easel_breakdown_active_run'), '', 'record cleared after fallback');
});

test('a stale active run is dropped instead of resurrected', async t => {
  window.localStorage.clear();
  window.localStorage.setItem('easel_breakdown_active_run', JSON.stringify({
    sessionId: 'breakdown-stale', turnId: 'breakdown-stale-1', material: 'x',
    startedAt: Date.now() - 48 * 60 * 60 * 1000,
  }));
  const view = await mount(t, async () => ({}), { keepStorage: true });
  await view.flush();

  assert.equal(window.localStorage.getItem('easel_breakdown_active_run'), '', 'stale record cleared');
  assert.equal(view.writes.filter(w => w.path.includes('/api/chat/')).length, 0, 'no recovery request for stale runs');
  assert.equal(view.container.querySelector('.notice-error'), null);
});
