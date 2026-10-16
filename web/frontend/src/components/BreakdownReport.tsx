import { useMemo, useState } from 'react';
import { createIdea } from '../lib/api';
import { renderMarkdown } from '../lib/sanitize';
import { BREAKDOWN_REPORT_TITLE, ideaTitleFromReport, reportScopeNote, structureLine, verifyQuotes, verifyStructure } from '../lib/breakdownReport';
import { IconCopy, IconFire, IconIdea } from './icons';

/** The same report reader for chat turns and reports saved before chat integration. */
export default function BreakdownReport({ material, report, complete = true, inert = false }: {
  material: string; report: string; complete?: boolean; inert?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const quotes = useMemo(() => complete ? verifyQuotes(report, material) : null, [complete, report, material]);
  const structure = useMemo(() => complete ? verifyStructure(report) : null, [complete, report]);
  const html = useMemo(() => renderMarkdown(report), [report]);
  const save = async () => {
    if (saving || !complete || inert) return;
    setSaving(true);
    try {
      await createIdea({ title: ideaTitleFromReport(report), note: report, source: '爆款拆解', status: 'pending' });
      setNotice('已存入选题库');
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : '保存失败，请重试'); }
    finally { setSaving(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(report); setNotice('已复制报告'); }
    catch { setNotice('复制失败，请手动选择报告文本'); }
  };
  return <section className="panel breakdown-report" aria-label={BREAKDOWN_REPORT_TITLE}>
    <div className="panel-title"><IconFire size={14} /> {BREAKDOWN_REPORT_TITLE}{!complete && <span className="breakdown-stream-note">部分内容</span>}</div>
    <p className="breakdown-report-note">{reportScopeNote(material)}</p>
    {quotes && <>
      <p className={`breakdown-quote-check${quotes.missing.length ? ' warn' : ''}`}>
        {quotes.total === 0 ? '引文检查：报告里没有标注可核对的原文引用。' : quotes.missing.length === 0
          ? `引文检查：${quotes.total} 处原文引用都能在你给的材料里逐字找到（只证明文字一致，不代表解释成立）。`
          : `引文检查：${quotes.total} 处引用里，${quotes.missing.length} 处没能在材料中逐字找到（可能被概括或改写，请以原文为准）。`}
      </p>
      {quotes.missing.length > 0 && <details className="breakdown-quote-details"><summary>查看未找到的引用</summary><ul>{quotes.missing.map((quote, i) => <li key={i}>{quote}</li>)}</ul></details>}
    </>}
    {structure && <p className={`breakdown-structure-check${structure.missingSections.length || structure.incompleteFindings || structure.findings === 0 ? ' warn' : ''}`}>{structureLine(structure)}</p>}
    <div className="skill-body-md" dangerouslySetInnerHTML={{ __html: html }} />
    {complete && <div className="breakdown-actions">
      {!inert && <button type="button" className="btn" disabled={saving} onClick={save}><IconIdea size={14} /> {saving ? '保存中…' : '存入选题库'}</button>}
      <button type="button" className="btn" onClick={copy}><IconCopy size={14} /> 复制报告</button>
    </div>}
    {notice && <p className="breakdown-report-note" role="status">{notice}</p>}
  </section>;
}
