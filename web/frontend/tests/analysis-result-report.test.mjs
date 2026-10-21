import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsModule } from './load-ts.mjs';

const dom = new JSDOM('', { url:'https://easel.test/' });
globalThis.window=dom.window;globalThis.document=dom.window.document;
const { analysisReportView }=await loadTsModule('../src/lib/analysisReportView.ts',import.meta.url);
const { default:Report }=await loadTsModule('../src/components/AnalysisResultReport.tsx',import.meta.url);
const markdown='任务已全部完成，报告已通过 present_artifact.py 登记交付（status=ready）。\n\n## 摘要\n\n**账号实质**：城市摄影记录。\n\n**关键事实**：\n\n- 作品 `7205067243497999674` 播放 17166。\n- 缺少正文。\n\n**值得继续的方向**（均附证据与反例）：\n\n1. 拍摄城市对比。\n2. 检验新选题。\n\n**明确不下的结论**：无法判断限流。';

test('saved reports separate existing labels, keep evidence and fold receipts without changing the source',()=>{
 const html=renderToStaticMarkup(createElement(Report,{result:{markdown,at:'2026-10-21T04:00:00Z',turnId:'turn',notice:''}}));
 const root=document.createElement('div');root.innerHTML=html;
 assert.deepEqual([...root.querySelectorAll('.analysis-report-section>h4')].map(e=>e.textContent),['账号实质','关键事实','值得继续的方向','明确不下的结论']);
 assert.match(root.querySelector('.analysis-report-sections').textContent,/17166/);
 assert.doesNotMatch(root.querySelector('.analysis-report-sections').textContent,/present_artifact/);
 assert.equal(root.querySelector('.analysis-report-reference').textContent,'7205067243497999674');
 assert.equal(root.querySelector('.analysis-report-original').open,false);
 assert.match(root.querySelector('.analysis-report-original').textContent,/present_artifact/);
 assert.equal(root.querySelectorAll('.analysis-report-sections li').length,4);
 assert.equal(root.querySelectorAll('button').length,0);
});

test('unstructured conclusions and normal introductory text remain visible',()=>{
 const rows=analysisReportView('基于现有样本，需要补充正文。\n\n## 证据\n\n真实数据，非执行回执。');
 assert.equal(rows.length,2);assert.match(rows[0].html,/基于现有样本/);assert.equal(rows[1].title,'证据');
 assert.match(analysisReportView('任务已完成，但样本不足。')[0].html,/样本不足/);
});

test('tables scroll independently and unsafe content never reaches report HTML',()=>{
 const rows=analysisReportView('## 指标\n\n|作品|播放|\n|---|---|\n|A|0|\n\n<script>alert(1)</script>\n<img src="https://invalid.test/track" onerror="alert(1)">\n\n[危险链接](javascript:alert(1))');
 const html=rows.map(r=>r.html).join('');
 assert.match(html,/analysis-report-table/);assert.match(html,/<td>0<\/td>/);
 assert.doesNotMatch(html,/<script|<img|onerror|href="javascript:/);
});
test.after(()=>dom.window.close());
