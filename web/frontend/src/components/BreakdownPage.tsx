import { useEffect, useMemo, useRef, useState } from 'react';
import { createIdea, stopChat, streamChat } from '../lib/api';
import { renderMarkdown } from '../lib/sanitize';
import {
  BREAKDOWN_REPORT_TITLE, EXAMPLE_MATERIAL, buildBreakdownReportPrompt, ideaTitleFromReport,
  materialLine, readTextFile, reportScopeNote, summarizeMaterial, textFileProblem, verifyQuotes,
} from '../lib/breakdownReport';
import {
  addBreakdownRecord, loadBreakdownDraft, loadBreakdownHistory, newBreakdownRecord,
  removeBreakdownRecord, saveBreakdownDraft, type BreakdownRecord,
} from '../lib/breakdownStore';
import { useComposerModels } from '../hooks/useComposerModels';
import { useCompatibleThinking } from '../hooks/useCompatibleThinking';
import { loadThinkingLevel, saveThinkingLevel, THINKING_LABELS } from '../lib/thinkingLevel';
import type { ThinkingPreference } from '../lib/thinkingLevel';
import ComposerModelPicker from './ComposerModelPicker';
import { ThinkingLevelPicker } from './ChatComposer';
import { IconCopy, IconFile, IconFire, IconIdea, IconInfo, IconRetry, IconStop } from './icons';

interface BreakdownPageProps {
  persona: string;
}

export default function BreakdownPage({ persona }: BreakdownPageProps) {
  const [input, setInput] = useState(loadBreakdownDraft);   // 切页/刷新后恢复草稿
  const [analyzed, setAnalyzed] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [statusNote, setStatusNote] = useState('');
  const [history, setHistory] = useState<BreakdownRecord[]>(loadBreakdownHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [preferredThinking, setPreferredThinking] = useState<ThinkingPreference>(loadThinkingLevel);
  const [toast, setToast] = useState<{ text: string; ok: boolean }>();
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const runRef = useRef<AbortController | null>(null);
  const runIdsRef = useRef<{ sessionId: string; turnId: string } | null>(null);

  // 与工作台/对话同源：模型列表与思考强度来自同一能力接口与同一偏好存储。
  const models = useComposerModels(null);
  const effectiveModel = models.selected || models.options.find(option => option.id === (models.capability?.currentModelRef || models.capability?.defaultModelRef));
  const supportedThinking = effectiveModel?.thinkingLevels;
  const { level: thinkingLevel } = useCompatibleThinking(preferredThinking, supportedThinking, setPreferredThinking);

  const summary = useMemo(() => summarizeMaterial(input), [input]);
  const analyzedSummary = useMemo(() => summarizeMaterial(analyzed), [analyzed]);
  const isExample = input === EXAMPLE_MATERIAL;
  const quoteCheck = useMemo(() => (result ? verifyQuotes(result, analyzed) : null), [result, analyzed]);

  useEffect(() => { saveBreakdownDraft(input); }, [input]);

  const notify = (text: string, ok: boolean) => {
    setToast({ text, ok });
    setTimeout(() => setToast(undefined), 2600);
  };

  const changeThinking = (value: ThinkingPreference) => {
    setPreferredThinking(value);
    const saved = saveThinkingLevel(value);
    notify(saved ? `已选择思考强度：${THINKING_LABELS[value]}，本次拆解生效` : '强度已在本页修改，但未能保存。', saved);
  };

  const run = () => {
    if (!input.trim() || loading) return;
    const snapshot = models.getSnapshot();
    if (snapshot === null) {
      setError('所选模型暂时不可用于本轮：请刷新模型选项，或改回“沿用会话模型”。');
      return;
    }
    const material = input;
    setLoading(true); setResult(''); setError(''); setStreamText(''); setStatusNote('');
    setAnalyzed(material);
    const sessionId = `breakdown-${Date.now().toString(36)}`;  // 独立会话：不出现在对话列表，断线可按同一 run 续接
    const turnId = `${sessionId}-1`;
    runIdsRef.current = { sessionId, turnId };
    let acc = '';
    runRef.current = streamChat(
      buildBreakdownReportPrompt(material, persona), persona, sessionId,
      (chunk) => { acc += chunk; setStreamText(acc); },
      () => {
        runRef.current = null; setLoading(false); setStreamText(''); setStatusNote('');
        const text = acc.trim();
        // 失败文案与有效报告分开：没有正文时不生成报告面板。
        if (!text) setError('本次没有生成有效报告，请重试。');
        else {
          setResult(text);
          setHistory(items => addBreakdownRecord(items, newBreakdownRecord(material, text, ideaTitleFromReport(text))));
        }
      },
      (err) => {
        runRef.current = null; setLoading(false); setStreamText(''); setStatusNote('');
        setError(err instanceof Error && err.message ? err.message : '拆解失败，请重试');
      },
      undefined,
      (status) => setStatusNote(status),
      () => setStatusNote('连接中断，正在自动续接…'),
      turnId, false, undefined, [], undefined, undefined, [], {},
      snapshot.modelRef, thinkingLevel,
    );
  };

  const stop = () => {
    // 与对话同款显式停止：通知后端终止本轮 agent，再断开前端流。
    const ids = runIdsRef.current;
    if (ids) void stopChat(ids.sessionId, ids.turnId).catch(() => { /* 后端可能已结束 */ });
    runRef.current?.abort();
    runRef.current = null;
    setLoading(false); setStreamText(''); setStatusNote('');
    setError('已停止本次生成；材料已保留，可重试或修改后重发。');
  };

  const openRecord = (record: BreakdownRecord) => {
    setInput(record.material); setAnalyzed(record.material); setResult(record.report);
    setError(''); setStreamText(''); setStatusNote(''); setShowHistory(false);
    notify('已载入历史报告（材料一并恢复，可重新拆解）', true);
  };

  const deleteRecord = (id: string) => {
    setHistory(items => removeBreakdownRecord(items, id));
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

  const resetMaterial = () => {
    setResult(''); setError(''); setInput(''); setAnalyzed(''); setStreamText(''); setStatusNote('');
  };

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
        {/* 与首页创作框同一张卡片与同一套执行控件：模型、思考强度都在卡内 */}
        <div className={`dash-composer breakdown-input${dragging ? ' drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}>
          <label className="dash-launch-label" htmlFor="breakdown-material">想拆解哪条内容？</label>
          <div className="dash-launch">
            <textarea id="breakdown-material" ref={textRef} className="dash-launch-input breakdown-textarea" value={input}
              placeholder="把正文、分享文案或链接贴在这里；也可以直接把文件拖进来…"
              onChange={(e) => setInput(e.target.value)} />
            <div className="dash-composer-bar">
              <div className="dash-composer-tools">
                <button type="button" className="btn btn-ghost breakdown-tool" onClick={() => fileRef.current?.click()}>
                  <IconFile size={13} /> 导入文本文件
                </button>
                {isExample && <span className="breakdown-chip">这是示例（虚构），可直接拆解或换成你的内容</span>}
                <ComposerModelPicker models={models} disabled={loading} />
                <ThinkingLevelPicker value={preferredThinking} onChange={changeThinking}
                  disabled={loading} supportedLevels={supportedThinking} />
              </div>
              <button type="button" className="btn btn-primary dash-launch-btn"
                onClick={loading ? stop : run} disabled={!loading && !input.trim()}>
                {loading ? <><IconStop size={13} /> 停止</> : '开始拆解 →'}
              </button>
            </div>
            {(input.trim() !== '' || loading) && (
              <div className="dash-composer-meta">
                <div className="dash-composer-status">
                  <span className="breakdown-material" role="status" aria-live="polite">
                    <IconInfo size={12} />{materialLine(summary)}
                  </span>
                </div>
              </div>
            )}
          </div>
          <input ref={fileRef} type="file" className="breakdown-file" accept=".txt,.md,.markdown,.srt"
            aria-label="导入文本文件" tabIndex={-1}
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importFile(file); }} />
        </div>

        {history.length > 0 && (
          <div className="breakdown-history">
            <button type="button" className="breakdown-history-toggle" aria-expanded={showHistory}
              onClick={() => setShowHistory(value => !value)}>
              历史拆解 {history.length} 篇 {showHistory ? '· 收起' : '· 展开'}
            </button>
            {showHistory && (
              <ul className="breakdown-history-list">
                {history.map(item => (
                  <li key={item.id}>
                    <button type="button" className="breakdown-history-item" onClick={() => openRecord(item)}>
                      <span className="breakdown-history-title">{item.title}</span>
                      <span className="breakdown-history-date">
                        {new Date(item.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </button>
                    <button type="button" className="breakdown-history-remove" aria-label={`删除历史：${item.title}`}
                      onClick={() => deleteRecord(item.id)}>删除</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {input.trim() === '' && !loading && (
          <button type="button" className="breakdown-example-link" onClick={loadExample}>没有素材？看看示例</button>
        )}

        <p className="breakdown-hint">会先给结论、再逐段讲怎么写、能学什么；缺表现数据时不会猜“为什么火”。</p>

        {(result || input || error) && !loading && (
          <div className="breakdown-actions">
            {result && <button className="btn" disabled={saving} onClick={saveToIdeas}>
              <IconIdea size={14} /> {saving ? '保存中…' : '存入选题库'}
            </button>}
            {result && <button className="btn" onClick={copyReport}><IconCopy size={14} /> 复制报告</button>}
            <button className="btn btn-ghost" onClick={resetMaterial}>清空</button>
          </div>
        )}

        {loading && (
          <div className="panel" style={{ marginTop: 18 }}>
            <div className="panel-title"><IconFire size={14} /> {BREAKDOWN_REPORT_TITLE}
              <span className="breakdown-stream-note">生成中…</span>
            </div>
            <p className="breakdown-report-note">{statusNote || '正在生成报告；输出会逐步出现，可随时点“停止”。'}</p>
            <div className="breakdown-stream">{streamText || '正在等待模型输出…'}</div>
          </div>
        )}
        {error && !loading && (
          <div className="notice-error breakdown-error" role="alert">
            <span>{error}{analyzedSummary.kind === 'link-only' ? '（你只提供了链接：如果链接没读到内容，请把正文粘贴进来再试。）' : ''}</span>
            <span className="breakdown-error-actions">
              {analyzedSummary.kind === 'link-only' && (
                <button className="btn btn-ghost breakdown-tool" onClick={() => textRef.current?.focus()}>补正文</button>
              )}
              <button className="btn btn-ghost breakdown-tool" onClick={run} disabled={!input.trim()}><IconRetry size={13} /> 重试</button>
            </span>
          </div>
        )}
        {result && !loading && (
          <div className="panel" style={{ marginTop: 18 }}>
            <div className="panel-title"><IconFire size={14} /> {BREAKDOWN_REPORT_TITLE}</div>
            <p className="breakdown-report-note">{reportScopeNote(analyzed)}</p>
            {quoteCheck && (
              <>
                <p className={`breakdown-quote-check${quoteCheck.missing.length ? ' warn' : ''}`}>
                  {quoteCheck.total === 0
                    ? '引文检查：报告里没有标注可核对的原文引用。'
                    : quoteCheck.missing.length === 0
                      ? `引文检查：${quoteCheck.total} 处原文引用都能在你给的材料里逐字找到（只证明文字一致，不代表解释成立）。`
                      : `引文检查：${quoteCheck.total} 处引用里，${quoteCheck.missing.length} 处没能在材料中逐字找到（可能被概括或改写，请以原文为准）。`}
                </p>
                {quoteCheck.missing.length > 0 && (
                  <details className="breakdown-quote-details">
                    <summary>查看未找到的引用</summary>
                    <ul>{quoteCheck.missing.map((quote, index) => <li key={index}>{quote}</li>)}</ul>
                  </details>
                )}
              </>
            )}
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
