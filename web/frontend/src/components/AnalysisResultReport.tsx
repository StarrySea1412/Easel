import { useMemo } from 'react';
import { analysisReportView } from '../lib/analysisReportView';
import type { AnalysisBinding } from '../lib/analysisBinding';
import OutputMessageContent from './OutputMessageContent';
import { IconFile } from './icons';
import '../styles/analysis-result-report.css';

export default function AnalysisResultReport({ result }: { result: NonNullable<AnalysisBinding['result']> }) {
  const sections = useMemo(() => analysisReportView(result.markdown), [result.markdown]);
  const timestamp = new Date(result.at);
  return <article className="analysis-result-report" aria-label="已回填的分析报告">
    <header className="analysis-report-heading"><IconFile size={18}/><div><h3>分析报告</h3>{Number.isFinite(timestamp.getTime()) && <time dateTime={result.at}>{timestamp.toLocaleString('zh-CN')}</time>}</div></header>
    <div className="analysis-report-sections">{sections.map((section, index) => <section className="analysis-report-section" key={index}>
      {section.title && <h4>{section.title}</h4>}<div className="analysis-report-prose" dangerouslySetInnerHTML={{ __html: section.html }}/>
    </section>)}</div>
    <details className="analysis-report-original"><summary>完整原文与执行记录</summary><div className="analysis-report-prose"><OutputMessageContent inert content={result.markdown}/></div></details>
  </article>;
}
