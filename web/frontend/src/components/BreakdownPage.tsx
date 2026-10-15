import { useState } from 'react';
import { runAgent, createIdea } from '../lib/api';
import { renderMarkdown } from '../lib/sanitize';
import {
  BREAKDOWN_REPORT_TITLE, buildBreakdownReportPrompt, ideaTitleFromReport,
  looksLikeAgentFailure, reportScopeNote,
} from '../lib/breakdownReport';
import { IconCopy, IconFire, IconIdea, IconSkills } from './icons';

interface BreakdownPageProps {
  persona: string;
}

export default function BreakdownPage({ persona }: BreakdownPageProps) {
  const [input, setInput] = useState('');
  const [analyzed, setAnalyzed] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean }>();

  const notify = (text: string, ok: boolean) => {
    setToast({ text, ok });
    setTimeout(() => setToast(undefined), 2200);
  };

  const run = async () => {
    if (!input.trim()) return;
    setLoading(true); setResult(''); setError('');
    setAnalyzed(input);
    try {
      const res = await runAgent(buildBreakdownReportPrompt(input, persona), persona);
      const text = (res.response || '').trim();
      // 后端失败文案（❌/⏱️/⏳ 前缀）不是报告：报告与错误分开显示，错误不可保存。
      if (!text || looksLikeAgentFailure(text)) setError(text || '本次没有生成有效报告，请重试。');
      else setResult(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : '拆解失败，请重试');
    } finally { setLoading(false); }
  };

  const saveToIdeas = async () => {
    if (!result || saving) return;
    setSaving(true);
    try {
      await createIdea({ title: ideaTitleFromReport(result), note: result, source: '爆款拆解', status: 'pending' });
      notify('已存入选题库', true);
    } catch (e) {
      notify(e instanceof Error ? e.message : '保存失败，请重试', false);
    } finally { setSaving(false); }
  };

  const copyReport = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      notify('已复制报告', true);
    } catch {
      notify('复制失败，请手动选择报告文本', false);
    }
  };

  return (
    <div className="page-scroll breakdown-page">
      <div className="page-head">
        <div>
          <h1 className="page-title"><IconFire size={21} /> 爆款拆解</h1>
          <p className="page-subtitle">放入你想研究的正文、分享文案或作品链接：先看清原作怎么写，再提炼适合你的模板与选题。</p>
        </div>
      </div>

      <div className="breakdown-body">
        <textarea className="field" style={{ minHeight: 160 }} value={input}
          placeholder="把想拆解的正文 / 分享文案粘贴进来；也可以贴作品链接（能否读取以实际结果为准）…"
          onChange={(e) => setInput(e.target.value)} />
        <p className="breakdown-hint">生成的是完整《内容拆解报告》：摘要、逐段分析、创作方案和验证计划；缺少表现数据时不会判断“为什么火”。</p>
        <div className="breakdown-actions">
          <button className="btn btn-primary" disabled={loading || !input.trim()} onClick={run}>
            <IconSkills size={15} /> {loading ? '正在生成报告…' : '开始拆解'}
          </button>
          {result && <button className="btn" disabled={saving} onClick={saveToIdeas}>
            <IconIdea size={14} /> {saving ? '保存中…' : '存入选题库'}
          </button>}
          {result && <button className="btn" onClick={copyReport}><IconCopy size={14} /> 复制报告</button>}
          {(result || error) && <button className="btn btn-ghost"
            onClick={() => { setResult(''); setError(''); setInput(''); }}>清空</button>}
        </div>

        {loading && <div className="loading" style={{ padding: 40 }}><div className="spinner" />正在生成内容拆解报告…</div>}
        {error && !loading && <div className="notice-error" role="alert">{error}</div>}
        {result && !loading && (
          <div className="panel" style={{ marginTop: 18 }}>
            <div className="panel-title"><IconFire size={14} /> {BREAKDOWN_REPORT_TITLE}</div>
            <p className="breakdown-report-note">{reportScopeNote(analyzed)}</p>
            <div className="skill-body-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(result) }} />
          </div>
        )}
      </div>

      {toast && <div className={`toast${toast.ok ? ' ok' : ' err'}`}>
        <span className="toast-icon">{toast.ok ? '✓' : '✕'}</span>{toast.text}
      </div>}
    </div>
  );
}
