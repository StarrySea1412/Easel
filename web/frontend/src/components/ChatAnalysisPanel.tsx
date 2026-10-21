import { useEffect, useRef, useState } from 'react';
import { saveAnalysisChatResult, type AnalysisBinding } from '../lib/analysisConversations';
import type { ChatSession } from '../lib/store';
import { analysisRequest } from '../lib/contentAnalysis';
import { addChatDraftQuote } from '../lib/chatDrafts';
import { showToast } from '../lib/toast';
import { watchWorkbenchChange } from '../lib/workbenchEvents';
import OutputMessageContent from './OutputMessageContent';
import PublishSpinner from './PublishSpinner';
import AnalysisEvidenceOverview from './AnalysisEvidenceOverview';
import PlatformIcon from './PlatformIcon';
import { IconChart, IconCopy, IconChevron, IconChat, IconImport } from './icons';
import '../styles/analysis-visuals.css';

export default function ChatAnalysisPanel({ session, onOpenAnalysis }: { session: ChatSession; onOpenAnalysis?: () => void }) {
  const context = session.analysisContext;
  const [saved, setSaved] = useState<AnalysisBinding | null>(null);
  const [quote, setQuote] = useState('');
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState('');
  const material = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!context) return;
    let alive = true;
    const read = () => { void analysisRequest<{conversations:AnalysisBinding[]}>(`/conversations?platform=${encodeURIComponent(context.platform)}&accountId=${encodeURIComponent(context.accountId)}`).then(value => { if (alive) setSaved(value.conversations.find(item => item.id === context.id) || null); }).catch(() => {}); };
    read();
    const unwatch = watchWorkbenchChange('analysis', change => { if ((!change.platform || change.platform === context.platform) && (!change.accountId || change.accountId === context.accountId)) read(); });
    return () => { alive = false; unwatch(); };
  }, [context]);
  if (!context) return <section className="chat-panel-home"><h2>分析材料</h2><p>从内容分析选择账号或作品，再打开专用分析对话。</p>{onOpenAnalysis && <button className="btn btn-sm" onClick={onOpenAnalysis}>打开内容分析</button>}</section>;
  const extract = () => {
    const selection = window.getSelection();
    const selected = selection && material.current?.contains(selection.anchorNode) && material.current.contains(selection.focusNode) ? selection.toString().trim() : '';
    setQuote([`## 辅助面板材料引用`, `平台：${context.platform}；账号：${context.accountId}；来源快照：${context.id}`, `作品：${context.contentIds.join('、')}`, '', selected || context.markdown].join('\n'));
  };
  const latest = [...session.messages].reverse().find(message => message.role === 'assistant' && !message.error && !message.stopped && message.turnId && message.content.trim());
  const writeback = async () => {
    if (!latest || writing) return;
    setWriting(true); setWriteError('');
    try { const result = await saveAnalysisChatResult(session, latest); if (result) { setSaved(result); showToast('分析结果已回填内容分析', 'success'); } }
    catch (reason) { setWriteError(reason instanceof Error ? reason.message : '回填失败，请重试'); }
    finally { setWriting(false); }
  };
  return <section className="chat-panel-home chat-analysis-panel" aria-label="分析辅助面板">
    <header className="analysis-panel-heading"><span className="analysis-panel-heading-icon"><IconChart size={18}/></span><div><h2>{context.kind === 'content-analysis' ? '作品分析' : '账号分析'} · {context.accountName}</h2><div className="analysis-panel-source"><PlatformIcon platform={context.platform} name={context.platform}/><span>{context.contentIds.length} 篇</span><time dateTime={context.createdAt}>{new Date(context.createdAt).toLocaleString('zh-CN')}</time></div></div></header>
    <div className="analysis-panel-actions"><button className="btn btn-sm" title="提取选中内容；未选中时提取全部材料" onMouseDown={event=>event.preventDefault()} onClick={extract}><IconCopy size={14}/>提取材料</button>{onOpenAnalysis && <button className="btn btn-sm" onClick={onOpenAnalysis}><IconChart size={14}/>查看分析结果<IconChevron size={12}/></button>}{latest && <button className="btn btn-sm" disabled={writing || Boolean(session.pendingTurnId) || saved?.stale} onClick={() => void writeback()}>{writing ? <PublishSpinner/> : <IconImport size={14}/>}<span>回填最新答复</span></button>}</div>
    {writeError && <p className="ca-error" role="alert">{writeError}</p>}
    {quote && <div className="ca-material-quote"><label>发送前编辑引用<textarea rows={9} value={quote} onChange={event => setQuote(event.target.value)} /></label><button className="btn btn-sm" onClick={() => { addChatDraftQuote(session.id, quote); setQuote(''); showToast('材料已加入当前分析对话草稿', 'success'); }}><IconChat size={14}/>引用到分析对话</button></div>}
    {session.pendingTurnId && <span role="status" aria-label="分析执行中"><PublishSpinner /></span>}
    {saved?.stale && <p className="ca-caption">来源材料已更新，本对话保留历史快照；重新提取后可生成新分析。</p>}
    {saved?.result && <details open><summary>已回填的分析结果</summary><OutputMessageContent inert content={saved.result.markdown}/></details>}
    <div ref={material}><AnalysisEvidenceOverview context={context}/>
    <details><summary>原始 Markdown / JSON 材料</summary><OutputMessageContent inert content={context.markdown}/></details></div>
  </section>;
}
