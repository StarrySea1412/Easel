import { useMemo, useRef, useState } from 'react';
import { runAgent, createIdea } from '../lib/api';
import { renderMarkdown } from '../lib/sanitize';
import {
  BREAKDOWN_REPORT_TITLE, EXAMPLE_MATERIAL, buildBreakdownReportPrompt, ideaTitleFromReport,
  looksLikeAgentFailure, materialLine, readTextFile, reportScopeNote, summarizeMaterial, textFileProblem,
} from '../lib/breakdownReport';
import { IconCopy, IconFile, IconFire, IconIdea, IconInfo, IconRetry, IconSkills } from './icons';

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
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean }>();
  const fileRef = useRef<HTMLInputElement>(null);

  const summary = useMemo(() => summarizeMaterial(input), [input]);
  const isExample = input === EXAMPLE_MATERIAL;

  const notify = (text: string, ok: boolean) => {
    setToast({ text, ok });
    setTimeout(() => setToast(undefined), 2600);
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

  const resetMaterial = () => { setResult(''); setError(''); setInput(''); setAnalyzed(''); };

  const loadExample = () => {
    setResult(''); setError(''); setAnalyzed(''); setInput(EXAMPLE_MATERIAL);
    notify('已填入示例素材（虚构）：可直接拆解，或替换成你的内容', true);
  };

  const importFile = async (file: File) => {
    const problem = textFileProblem(file);
    if (problem) { notify(problem, false); return; }
    try {
      const text = await readTextFile(file);
      if (!text.trim()) { notify('文件里没有可读取的文字', false); return; }
      setResult(''); setError(''); setAnalyzed(''); setInput(text);
      notify(`已导入 ${file.name}（仅文字内容）`, true);
    } catch (e) {
      notify(e instanceof Error ? e.message : '文件读取失败，请改为直接粘贴内容。', false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) void importFile(file);
    else notify('没有读到文件；也可以直接粘贴内容', false);
  };

  return (
    <div className="page-scroll breakdown-page">
      <div className="page-head">
        <div>
          <h1 className="page-title"><IconFire size={21} /> 爆款拆解</h1>
          <p className="page-subtitle">放一条你想参考的内容，看看哪些写法适合你——正文、分享文案或链接都可以。</p>
        </div>
      </div>

      <div className="breakdown-body">
        <div className={`breakdown-input${dragging ? ' drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}>
          <textarea className="field breakdown-textarea" value={input}
            placeholder="把想研究的内容贴在这里：一段正文、分享文案，或者作品链接；也可以直接把文件拖进来…"
            onChange={(e) => setInput(e.target.value)} />
          <div className="breakdown-tools">
            <button type="button" className="btn btn-ghost breakdown-tool" onClick={() => fileRef.current?.click()}>
              <IconFile size={13} /> 导入文本文件
            </button>
            {isExample && <span className="breakdown-chip">这是示例（虚构），可直接拆解或换成你的内容</span>}
          </div>
          <input ref={fileRef} type="file" className="breakdown-file" accept=".txt,.md,.markdown,.srt"
            aria-label="导入文本文件" tabIndex={-1}
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importFile(file); }} />
        </div>

        {input.trim() !== '' && (
          <div className="breakdown-material" role="status" aria-live="polite">
            <IconInfo size={13} /><span>{materialLine(summary)}</span>
          </div>
        )}

        <p className="breakdown-hint">会先给结论、再逐段讲怎么写、能学什么；缺表现数据时不会猜“为什么火”。</p>

        <div className="breakdown-actions">
          <button className="btn btn-primary" disabled={loading || !input.trim()} onClick={run}>
            <IconSkills size={15} /> {loading ? '正在生成报告…' : '开始拆解'}
          </button>
          {result && <button className="btn" disabled={saving} onClick={saveToIdeas}>
            <IconIdea size={14} /> {saving ? '保存中…' : '存入选题库'}
          </button>}
          {result && <button className="btn" onClick={copyReport}><IconCopy size={14} /> 复制报告</button>}
          {(input || result || error) && <button className="btn btn-ghost" onClick={resetMaterial}>清空</button>}
        </div>
        {!input.trim() && (
          <button type="button" className="breakdown-example-link" onClick={loadExample}>没有素材？看看示例</button>
        )}

        {loading && <div className="loading" style={{ padding: 40 }}><div className="spinner" />正在生成内容拆解报告…</div>}
        {error && !loading && (
          <div className="notice-error breakdown-error" role="alert">
            <span>{error}</span>
            <button className="btn btn-ghost breakdown-tool" onClick={run}><IconRetry size={13} /> 重试</button>
          </div>
        )}
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
