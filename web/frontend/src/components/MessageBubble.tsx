import type { ChatErrorDetail } from '../lib/chatErrors';
import { chatErrorDetail, chatErrorTitle, historicalGatewayAuthError } from '../lib/chatErrors';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChatMessage } from '../lib/store';
import OutputMessageContent from './OutputMessageContent';
import BreakdownReport from './BreakdownReport';
import { IconCopy, IconCheck, IconRetry, IconEdit } from './icons';
import ChatMessageEditor from './ChatMessageEditor';
import '../styles/chat-editing.css';
import './message-model-selection.css';
import { formatChatElapsed } from '../lib/chatTiming';
import './message-timing.css';

export interface BubbleActions {
  onEdit?: (text: string, signal: AbortSignal) => Promise<boolean>;
  onCopy: () => void | Promise<void>;
  onRetry?: () => void;    // 仅最后一轮可用（append-only：不改写历史）
  canModify: boolean;      // 流式中禁用 retry
}

interface MessageBubbleProps {
  reportMaterial?: string;
  reportIncomplete?: boolean;
  message: ChatMessage;
  sessionId?: string;
  isStreaming?: boolean;
  thinking?: string;
  activity?: string;
  activitySteps?: string[];
  stillWorking?: string;   // 防呆心跳提示（未卡住）；仅流式时的独立提示，不替代思考/活动
  actions?: BubbleActions;
  status?: ReactNode;
  execution?: ReactNode | ((onProgressOwnership:(owned:boolean)=>void)=>ReactNode);
  executionScope?: string;
  backupSnapshot?: boolean;
}

function DisclosureChevron({ expanded = false }: { expanded?: boolean }) {
  return <svg className={`model-thinking-chevron ${expanded ? 'is-open' : ''}`} width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m7 5 5 5-5 5" /></svg>;
}

function TurnElapsed({ startedAt, elapsedMs, running }: { startedAt?: number; elapsedMs?: number; running: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || startedAt === undefined || elapsedMs !== undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt, elapsedMs]);
  const elapsed = elapsedMs ?? (running && startedAt !== undefined ? Math.max(0, now - startedAt) : undefined);
  if (elapsed === undefined || !Number.isFinite(elapsed) || elapsed < 0) return null;
  return <span className="message-turn-elapsed" aria-label={`本轮${running ? '已用时' : '耗时'}：${formatChatElapsed(elapsed)}`}
    title="从本轮开始到返回结果、失败或停止，包含等待与执行时间。">{running ? '已用时' : '耗时'} {formatChatElapsed(elapsed)}</span>;
}

function ThinkingPanel({ text, streaming, backupSnapshot }: { text: string; streaming: boolean; backupSnapshot?: boolean }) {
  // Preserve the user's expanded/collapsed choice as new chunks and the final
  // answer arrive; binding `open` to answer emptiness used to override it.
  const [expanded, setExpanded] = useState(streaming);
  // The stream carries reasoning text, without a provider reasoning-token count.
  // Present a bounded text estimate rather than relabeling characters as usage.
  const estimatedTokens = Math.max(1, (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[^\p{L}\p{N}\s]|[\p{L}\p{N}]+/gu) || [])
    .reduce((sum, token) => sum + (/^[\x00-\x7F]+$/.test(token) ? Math.ceil(token.length / 4) : [...token].length), 0));
  return <section className="model-thinking" aria-label="模型返回的思考内容">
    <button type="button" className="model-thinking-toggle message-disclosure-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <DisclosureChevron expanded={expanded} />
      <span>思考摘要</span><span className="model-thinking-state">{backupSnapshot ? '来自备份' : streaming ? '接收中' : '已保留'}</span>
      <span className="model-thinking-count" title="按可见思考文字估算，非服务商返回或计费用量。">≈ {estimatedTokens.toLocaleString()} tokens</span>
    </button>
    {expanded && <div className="model-thinking-body"><p className="model-thinking-note">{backupSnapshot ? '备份保留的思考文字，未经本机后台核验' : '模型服务实际返回的思考内容或摘要'}</p><div className="model-thinking-text">{text}</div></div>}
  </section>;
}

type WorkProgressProps = {
  steps: string[];
  streaming: boolean;
  heartbeat?: string;
  error?: boolean;
  stopped?: boolean;
  backupSnapshot?: boolean;
};

function normalizeProgressSteps(activity: string | undefined, activitySteps: string[] | undefined): string[] {
  const activityValue: unknown = activity;
  const fallback = Array.isArray(activityValue)
    ? activityValue
    : String(activity || '').split(/\r?\n/);
  const source = activitySteps?.length ? activitySteps : fallback;
  const result: string[] = [];
  for (const value of source) {
    let text = String(value || '').trim();
    for (const prefix of ['⏳', '🛠️', '🧠', '✅', '⚠️']) {
      while (text.startsWith(prefix)) text = text.slice(prefix.length).trimStart();
    }
    if (!text || result[result.length - 1] === text) continue;
    result.push(text);
  }
  return result;
}

function progressLabel(text: string): string {
  if (/已收到.*唤醒|唤醒\s*agent|请求已接收|已接收请求/i.test(text)) return '已接收请求';
  if (/等待模型响应|等待模型服务返回/.test(text)) return '等待模型服务返回';
  if (/工具返回后继续生成/.test(text)) return text.replace(/…+$/, '').trim();
  if (/正在思考/.test(text)) return '服务已上报思考状态';
  return text.replace(/…+$/, '').trim();
}

function WorkProgress({ steps, streaming, heartbeat, error, stopped, backupSnapshot }: WorkProgressProps) {
  const status = error ? '失败' : stopped ? '已停止' : streaming ? '进行中' : '已完成';
  const body = (
    <>
      {backupSnapshot && <p className="model-thinking-note work-progress-note">以下文字来自备份，未经本机后台核验。</p>}
      <ol className="work-progress-list">
        {steps.map((step, index) => {
          const current = streaming && index === steps.length - 1;
          return <li key={`${step}-${index}`} className={`work-progress-step${current ? ' is-current' : ' is-recorded'}`}>
            <span className="work-progress-marker" aria-hidden="true">{current ? '·' : '✓'}</span>
            <span className="work-progress-copy"><span className="work-progress-step-title">{progressLabel(step)}</span><small>{current ? '最新事件 · 实时' : backupSnapshot ? '备份记录 · 未核验' : '服务事件 · 已记录'}</small></span>
          </li>;
        })}
        {!steps.length && <li className="work-progress-step is-empty">
          <span className="work-progress-marker" aria-hidden="true">·</span>
          <span className="work-progress-copy"><span className="work-progress-step-title">{streaming ? '等待首个服务事件' : '没有可展示的进度事件'}</span><small>{streaming ? '后台尚未返回可展示的进度' : '本轮未保存活动记录'}</small></span>
        </li>}
        {!streaming && (error || stopped) && <li className={`work-progress-step is-terminal${error ? ' is-error' : ''}`}>
          <span className="work-progress-marker" aria-hidden="true">{error ? '!' : 'Ⅱ'}</span>
          <span className="work-progress-copy"><span className="work-progress-step-title">{error ? '本轮失败' : '本轮已停止'}</span><small>终态已保存</small></span>
        </li>}
      </ol>
      {streaming && !steps.length && <div className="typing-indicator" aria-hidden="true"><span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" /></div>}
      {heartbeat && <p className="work-progress-heartbeat"><span>连接保持中</span>{heartbeat.replace(/^连接保持中\s*[·•]?\s*/, '')} <small>心跳提示，不代表新的工作步骤</small></p>}
    </>
  );
  if (streaming) return <section className="work-progress" aria-label="工作进度">
    <header className="work-progress-heading"><div><span className="work-progress-title">工作进度</span><span>仅展示服务实际上报的事件{!steps.length ? ' · 等待模型响应' : ''}</span></div><b className="work-progress-status is-running">{status}</b></header>{body}
  </section>;
  return <details className="thinking-block work-progress work-progress-history">
    <summary className="message-disclosure-toggle"><DisclosureChevron /><span>{backupSnapshot ? '备份活动文字' : '工作进度'}</span><small>{steps.length ? `${steps.length} 条服务事件` : '无活动记录'}</small><b className={`work-progress-status${error ? ' is-error' : stopped ? ' is-stopped' : ''}`}>{status}</b></summary>{body}
  </details>;
}

function ActionBar({ actions, status, onEdit }: { actions?: BubbleActions; status?: ReactNode; onEdit?: () => void }) {
  const [copyStatus, setCopyStatus] = useState<'idle'|'copying'|'copied'|'failed'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  const copy = async () => {
    clearTimeout(resetTimer.current);
    setCopyStatus('copying');
    try {
      await actions?.onCopy();
      setCopyStatus('copied');
      resetTimer.current = setTimeout(() => setCopyStatus('idle'), 1200);
    } catch {
      setCopyStatus('failed');
    }
  };
  return (
    <div className="msg-actions">
      {actions && <button type="button" className="msg-action" onClick={copy} disabled={copyStatus==='copying'} title="复制">
        {copyStatus==='copied' ? <IconCheck size={14} /> : <IconCopy size={14} />}<span>{copyStatus==='copied' ? '已复制' : copyStatus==='copying' ? '复制中…' : '复制'}</span>
      </button>}
      {copyStatus==='failed'&&<span className="msg-copy-error" role="status">复制失败，请允许剪贴板访问后重试。</span>}
      {actions?.onEdit && <button type="button" className="msg-action" aria-label="重新编辑消息" disabled={!actions.canModify} onClick={onEdit} title={actions.canModify ? '重新编辑消息' : '请等待当前生成或停止处理结束'}><IconEdit size={14} /><span>编辑</span></button>}
      {actions?.onRetry && actions.canModify && (
        <button type="button" className="msg-action" onClick={actions.onRetry} title="重新生成"><IconRetry size={14} /><span>重试</span></button>
      )}
      {status}
    </div>
  );
}

export default function MessageBubble({ message, reportMaterial, reportIncomplete, sessionId, isStreaming, thinking, activity, activitySteps, stillWorking, actions, status, execution, executionScope, backupSnapshot }: MessageBubbleProps) {
  const [editing, setEditing] = useState(false);
  const userRow = useRef<HTMLDivElement>(null);
  const cancelEdit = () => { setEditing(false); requestAnimationFrame(() => userRow.current?.querySelector<HTMLButtonElement>('[aria-label="重新编辑消息"]')?.focus()); };
  const scope=executionScope||`${sessionId||''}:${message.turnId||''}`;
  const [progressOwner,setProgressOwner]=useState<{scope:string;owned:boolean}|null>(null);
  const onProgressOwnership=useCallback((owned:boolean)=>setProgressOwner(old=>old?.scope===scope&&old.owned===owned?old:{scope,owned}),[scope]);
  const ownsProgress=progressOwner?.scope===scope&&progressOwner.owned;
  const executionView=typeof execution==='function'?execution(onProgressOwnership):execution;
  const historicalError=message.role==='assistant'&&!message.error?historicalGatewayAuthError(message.content):undefined;
  const sourceError=message.error||historicalError;
  const shouldRecover=Boolean(sourceError && chatErrorDetail(sourceError).code==='agent_request_aborted');
  const [recoveredError,setRecoveredError]=useState<{key:string;error:ChatErrorDetail}|null>(null);
  const failureKey=JSON.stringify([sessionId,message.turnId,sourceError?.code,sourceError?.message]);
  useEffect(()=>{
    if(backupSnapshot || !sessionId || !message.turnId || !shouldRecover)return;
    const controller=new AbortController();
    const base=window.location.pathname.replace(/\/index\.html$/,'').replace(/\/$/,'');
    void fetch(`${base}/api/chat/last/${encodeURIComponent(sessionId)}?turn_id=${encodeURIComponent(message.turnId)}`,{signal:controller.signal,cache:'no-store'})
      .then(async response=>{if(!response.ok)return null;return response.json();})
      .then(result=>{if(!controller.signal.aborted && result?.turn_id===message.turnId && result?.error)setRecoveredError({key:failureKey,error:chatErrorDetail(result.error)});})
      .catch(()=>{});
    return ()=>controller.abort();
  },[backupSnapshot,sessionId,message.turnId,failureKey,shouldRecover]);
  const displayedError=recoveredError?.key===failureKey?recoveredError.error:sourceError ? chatErrorDetail(sourceError) : undefined;
  const displayedContent=historicalError?'':message.content;

  // ---- 用户消息 ----
  if (message.role === 'user') {
    // Attachment-only turns are intentionally invisible; the structured refs
    // remain in session state for retry but never leak paths into the chat UI.
    if (!message.content.trim()) return null;
    return (
      <div className={`message-row user${editing ? ' is-editing' : ''}`} ref={userRow}>
        <div className="msg-col user">
          {editing && actions?.onEdit ? <ChatMessageEditor key={`${sessionId}:${message.content}`} text={message.content} disabled={!actions.canModify} onCancel={cancelEdit} onSend={actions.onEdit} /> : <div className="message-bubble user">{message.content}</div>}
          {!backupSnapshot && message.requestedModelRef && <p className="message-model-selection">本轮指定：{message.requestedModelRef}</p>}
          {actions && !editing && <ActionBar actions={actions} onEdit={() => setEditing(true)} />}
        </div>
      </div>
    );
  }

  // ---- 助手消息 ----
  // 思考 / 活动：流式时用实时值；结束后用消息里持久化的值 —— 一直保留，不隐藏
  const effThinking = isStreaming ? (thinking || '') : (message.thinking || '');
  const liveActivity = isStreaming && !ownsProgress ? (activity || '') : '';
  const liveHint = isStreaming ? (stillWorking || '') : '';   // 防呆「未卡住」提示，附着显示、不顶掉真实状态
  const progressSteps = normalizeProgressSteps(isStreaming ? activity : message.activity, isStreaming ? activitySteps : undefined);

  const livePanel = (effThinking || liveActivity || liveHint || progressSteps.length || isStreaming) ? (
    <div className="live-panel">
      <WorkProgress steps={progressSteps} streaming={Boolean(isStreaming)} heartbeat={liveHint} error={Boolean(message.error)} stopped={message.stopped} backupSnapshot={backupSnapshot} />
      {effThinking && (
        <ThinkingPanel text={effThinking} streaming={Boolean(isStreaming)} backupSnapshot={backupSnapshot} />
      )}
    </div>
  ) : null;

  // 等待回复中（还没有正文、思考、活动）
  if (isStreaming && !message.content && !effThinking && !liveActivity && !liveHint && !execution) {
    return (
      <div className="message-row assistant">
        <div className="message-bubble assistant">
          <WorkProgress steps={progressSteps} streaming heartbeat={liveHint} error={Boolean(message.error)} stopped={message.stopped} backupSnapshot={backupSnapshot} />
          <TurnElapsed startedAt={message.startedAt} elapsedMs={message.elapsedMs} running />
        </div>
      </div>
    );
  }

  return (
    <div className="message-row assistant">
      <div className="msg-col assistant">
        <div className="message-bubble assistant">
          {livePanel}
          {executionView}
          {displayedContent && (reportMaterial !== undefined
            ? <BreakdownReport material={reportMaterial} report={displayedContent} complete={!isStreaming && !displayedError && !message.stopped && !reportIncomplete} inert={backupSnapshot} />
            : <OutputMessageContent content={displayedContent} inert={backupSnapshot} streaming={isStreaming} />)}
          {displayedError&&<section className="chat-response-error" role="alert"><strong>{chatErrorTitle(displayedError)}</strong><p>{displayedError.message}</p>{displayedError.stage && <p className="chat-response-error-hint">失败阶段：{displayedError.stage==='model_response'?'模型响应':displayedError.stage==='agent_execution'?'Agent 执行':displayedError.stage}</p>}{(displayedError.channel || displayedError.modelRef) && <p className="chat-response-error-hint">渠道：{displayedError.channel || '未上报'}{displayedError.channelEndpoint ? ` · ${displayedError.channelEndpoint}` : ''} · 模型：{displayedError.modelRef || '未上报'}</p>}{displayedError.detail && <details className="chat-error-details"><summary>服务返回详情</summary><pre>{displayedError.detail}</pre></details>}{displayedError.code&&<small>错误代码：{displayedError.code}</small>}{backupSnapshot ? <p className="chat-response-error-hint">这是备份中的失败记录，仅供查阅；需要继续时请新建对话。</p> : <>{displayedError.historical&&<p className="chat-response-error-hint">这是一条历史失败记录。修复认证配置后，可以重新发送或重试。</p>}{!displayedError.historical&&displayedError.category==='authentication'&&<p className="chat-response-error-hint">请先检查服务凭据与授权，再重新发送。</p>}</>}</section>}
          {isStreaming && <span className="streaming-cursor" />}
        </div>
        <TurnElapsed startedAt={message.startedAt} elapsedMs={message.elapsedMs} running={Boolean(isStreaming)} />
        {(actions || status) && <ActionBar actions={isStreaming ? undefined : actions} status={status} />}
      </div>
    </div>
  );
}
