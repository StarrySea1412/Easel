import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThinkingLevel } from '../lib/api';
import { EXAMPLE_MATERIAL, materialLine, readTextFile, summarizeMaterial, textFileProblem } from '../lib/breakdownReport';
import { loadActiveRun, loadBreakdownDraft, loadBreakdownHistory, removeBreakdownRecord, saveBreakdownDraft, type ActiveRun, type BreakdownRecord } from '../lib/breakdownStore';
import { useComposerModels } from '../hooks/useComposerModels';
import { useCompatibleThinking } from '../hooks/useCompatibleThinking';
import { loadThinkingLevel, saveThinkingLevel, THINKING_LABELS } from '../lib/thinkingLevel';
import type { ThinkingPreference } from '../lib/thinkingLevel';
import ComposerModelPicker from './ComposerModelPicker';
import { ThinkingLevelPicker } from './ChatComposer';
import BreakdownReport from './BreakdownReport';
import { IconFile, IconFire, IconInfo, IconRetry } from './icons';

interface BreakdownPageProps {
  persona: string;
  onStart: (material: string, modelRef?: string, thinkingLevel?: ThinkingLevel) => boolean;
  onOpenRun: (run: ActiveRun) => boolean;
}

export default function BreakdownPage({ onStart, onOpenRun }: BreakdownPageProps) {
  const [input, setInput] = useState(loadBreakdownDraft);
  const [analyzed, setAnalyzed] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [history, setHistory] = useState<BreakdownRecord[]>(loadBreakdownHistory);
  const [activeRun] = useState(loadActiveRun);
  const [showHistory, setShowHistory] = useState(false);
  const [preferredThinking, setPreferredThinking] = useState<ThinkingPreference>(loadThinkingLevel);
  const [toast, setToast] = useState<{ text: string; ok: boolean }>();
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const models = useComposerModels(null);
  const effectiveModel = models.selected || models.options.find(option => option.id === (models.capability?.currentModelRef || models.capability?.defaultModelRef));
  const supportedThinking = effectiveModel?.thinkingLevels;
  const { level: thinkingLevel } = useCompatibleThinking(preferredThinking, supportedThinking, setPreferredThinking);
  const summary = useMemo(() => summarizeMaterial(input), [input]);
  const analyzedSummary = useMemo(() => summarizeMaterial(analyzed), [analyzed]);
  const isExample = input === EXAMPLE_MATERIAL;
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
    if (!input.trim()) return;
    const snapshot = models.getSnapshot();
    if (snapshot === null) { setError('所选模型暂时不可用于本轮：请刷新模型选项，或改回“沿用会话模型”。'); return; }
    setError('');
    if (!onStart(input, snapshot.modelRef, thinkingLevel)) setError('暂未创建拆解对话，请检查网关连接和浏览器存储后重试。材料已保留。');
  };

  const openRecord = (record: BreakdownRecord) => {
    setInput(record.material); setAnalyzed(record.material); setResult(record.report);
    setError(''); setShowHistory(false);
    notify('已载入历史报告（材料一并恢复，可重新拆解）', true);
  };

  const deleteRecord = (id: string) => {
    setHistory(items => removeBreakdownRecord(items, id));
  };

  const resetMaterial = () => {
    setResult(''); setError(''); setInput(''); setAnalyzed('');
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
                <ComposerModelPicker models={models}  />
                <ThinkingLevelPicker value={preferredThinking} onChange={changeThinking}
                  disabled={false} supportedLevels={supportedThinking} />
              </div>
              <button type="button" className="btn btn-primary dash-launch-btn"
                onClick={run} disabled={!input.trim()}>
                开始拆解 →
              </button>
            </div>
            {input.trim() !== '' && (
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

        {input.trim() === '' && (
          <button type="button" className="breakdown-example-link" onClick={loadExample}>没有素材？看看示例</button>
        )}

        <p className="breakdown-hint">开始后进入最近对话，进度、停止和后续追问都在同一对话中；报告保留完整阅读与检查。缺表现数据时不会猜“为什么火”。</p>

        {activeRun && <div className="panel breakdown-resume" role="status">
          <p>上次的拆解已可并入最近对话；继续查看同一任务的进度或结果。</p>
          <button type="button" className="btn" onClick={() => { if (!onOpenRun(activeRun)) setError('暂未能保存或打开上次的拆解对话，原任务记录仍保留。'); }}>在对话中查看上次拆解 →</button>
        </div>}
        {(result || input || error) && <div className="breakdown-actions"><button type="button" className="btn btn-ghost" onClick={resetMaterial}>清空</button></div>}
        {error && (
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
        {result && <BreakdownReport material={analyzed} report={result} />}

      </div>

      {toast && <div className={`toast${toast.ok ? ' ok' : ' err'}`}>
        <span className="toast-icon">{toast.ok ? '✓' : '✕'}</span>{toast.text}
      </div>}
    </div>
  );
}
