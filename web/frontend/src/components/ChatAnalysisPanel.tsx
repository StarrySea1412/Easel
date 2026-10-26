import { useEffect, useRef, useState } from 'react';
import { saveAnalysisChatResult, type AnalysisBinding } from '../lib/analysisConversations';
import type { ChatSession } from '../lib/store';
import { analysisRequest } from '../lib/contentAnalysis';
import { addChatDraftQuote } from '../lib/chatDrafts';
import { showToast } from '../lib/toast';
import { watchWorkbenchChange } from '../lib/workbenchEvents';
import OutputMessageContent from './OutputMessageContent';
import AnalysisResultReport from './AnalysisResultReport';
import PublishSpinner from './PublishSpinner';
import { proposeMemory } from '../lib/profileMemory';
import AnalysisEvidenceOverview from './AnalysisEvidenceOverview';
import PlatformIcon from './PlatformIcon';
import { IconChart, IconCopy, IconChevron, IconChat, IconImport } from './icons';
import '../styles/analysis-visuals.css';

export default function ChatAnalysisPanel({ session, onOpenAnalysis, onWriteFromAnalysis }: { session: ChatSession; onOpenAnalysis?: () => void; onWriteFromAnalysis?: () => Promise<void> }) {
  const context = session.analysisContext;
  const [saved, setSaved] = useState<AnalysisBinding | null>(null);
  const [quote, setQuote] = useState('');
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState('');
  const [preparingWriting, setPreparingWriting] = useState(false);
  const [writingError, setWritingError] = useState('');
  const material = useRef<HTMLDivElement>(null);
  const resultMaterial=useRef<HTMLDivElement>(null);
  const [candidate,setCandidate]=useState(''),[savingMemory,setSavingMemory]=useState(false),[memoryError,setMemoryError]=useState('');
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
  const extractMemory=()=>{
    const selection=window.getSelection();
    const selected=selection&&resultMaterial.current?.contains(selection.anchorNode)&&resultMaterial.current.contains(selection.focusNode)?selection.toString().trim():'';
    if(!selected){setMemoryError('先在已保存的分析结果中选取一段结论，或在下方填写其中的原文片段。');setCandidate('');return;}
    setMemoryError('');setCandidate(selected);
  };
  const saveMemory=async()=>{
    if(!session.persona||!saved?.result||savingMemory)return;
    setSavingMemory(true);setMemoryError('');
    try{await proposeMemory(session.persona,candidate,{kind:'account',platform:context.platform,accountId:context.accountId},{type:'analysis',bindingId:context.id});setCandidate('');showToast('候选已保存，在画像「经验沉淀」确认后生效','success');}
    catch(reason){setMemoryError(reason instanceof Error?reason.message:'保存候选失败');}
    finally{setSavingMemory(false);}
  };
  return <section className="chat-panel-home chat-analysis-panel" aria-label="分析辅助面板">
    <header className="analysis-panel-heading"><span className="analysis-panel-heading-icon"><IconChart size={18}/></span><div><h2>{context.kind === 'content-analysis' ? '作品分析' : '账号分析'} · {context.accountName}</h2><div className="analysis-panel-source"><PlatformIcon platform={context.platform} name={context.platform}/><span>{context.contentIds.length} 篇</span><time dateTime={context.createdAt}>{new Date(context.createdAt).toLocaleString('zh-CN')}</time></div></div></header>
    <div className="analysis-panel-actions"><button className="btn btn-sm" title="提取选中内容；未选中时提取全部材料" onMouseDown={event=>event.preventDefault()} onClick={extract}><IconCopy size={14}/>提取材料</button>{onOpenAnalysis && <button className="btn btn-sm" onClick={onOpenAnalysis}><IconChart size={14}/>查看分析结果<IconChevron size={12}/></button>}{latest && <button className="btn btn-sm" disabled={writing || Boolean(session.pendingTurnId) || saved?.stale} onClick={() => void writeback()}>{writing ? <PublishSpinner/> : <IconImport size={14}/>}<span>回填最新答复</span></button>}</div>
    {writeError && <p className="ca-error" role="alert">{writeError}</p>}
    {quote && <div className="ca-material-quote"><label>发送前编辑引用<textarea rows={9} value={quote} onChange={event => setQuote(event.target.value)} /></label><button className="btn btn-sm" onClick={() => { addChatDraftQuote(session.id, quote); setQuote(''); showToast('材料已加入当前分析对话草稿', 'success'); }}><IconChat size={14}/>引用到分析对话</button></div>}
    {session.pendingTurnId && <span role="status" aria-label="分析执行中"><PublishSpinner /></span>}
    {saved?.stale && <p className="ca-caption">来源材料已更新，本对话保留历史快照；重新提取后可生成新分析。</p>}
    {saved?.result && <>{onWriteFromAnalysis && <div className="analysis-writing-action"><button className="btn btn-sm" disabled={preparingWriting || saved.stale || Boolean(session.pendingTurnId) || session.importedFromBackup} onClick={async () => {setPreparingWriting(true); setWritingError(''); try {await onWriteFromAnalysis();} catch (reason) {setWritingError(reason instanceof Error ? reason.message : '准备写作失败');} finally {setPreparingWriting(false);}}}>{preparingWriting ? <PublishSpinner/> : <IconChat size={14}/>}据此写一篇</button>{writingError && <p role="alert" className="ca-error">{writingError}</p>}</div>}<div ref={resultMaterial}><AnalysisResultReport result={saved.result}/></div><details className="analysis-memory-candidate"><summary>保存画像经验</summary><div className="ca-material-quote"><button className="btn btn-sm" disabled={saved.stale||!session.persona||savingMemory} onMouseDown={event=>event.preventDefault()} onClick={extractMemory}>选取结论加入画像</button><p>{session.persona?`保存到「${session.persona}」的待确认经验，仅适用于原平台账号。`:'先为当前对话选择画像，再保存经验。'}</p><label>候选结论（已保存结果的原文片段）<textarea rows={3} value={candidate} onChange={event=>setCandidate(event.target.value)}/></label><button className="btn btn-sm" disabled={!candidate.trim()||!session.persona||saved.stale||savingMemory} onClick={()=>void saveMemory()}>{savingMemory&&<PublishSpinner/>}保存候选</button>{memoryError&&<p role="alert" className="ca-error">{memoryError}</p>}</div></details></>}
    <div ref={material}><AnalysisEvidenceOverview context={context}/>
    <details><summary>原始 Markdown / JSON 材料</summary><OutputMessageContent inert content={context.markdown}/></details></div>
  </section>;
}
