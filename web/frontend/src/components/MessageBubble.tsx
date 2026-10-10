import type { ChatErrorDetail } from '../lib/chatErrors';
import { chatErrorDetail, chatErrorTitle, historicalGatewayAuthError } from '../lib/chatErrors';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChatMessage } from '../lib/store';
import { renderMarkdown } from '../lib/sanitize';
import { IconCopy, IconCheck, IconRetry } from './icons';
import './message-model-selection.css';

export interface BubbleActions {
  onCopy: () => void | Promise<void>;
  onRetry?: () => void;    // 仅最后一轮可用（append-only：不改写历史）
  canModify: boolean;      // 流式中禁用 retry
}

interface MessageBubbleProps {
  message: ChatMessage;
  sessionId?: string;
  isStreaming?: boolean;
  thinking?: string;
  activity?: string;
  stillWorking?: string;   // 防呆心跳提示（未卡住）；仅流式时的独立提示，不替代思考/活动
  actions?: BubbleActions;
  status?: ReactNode;
  execution?: ReactNode;
  backupSnapshot?: boolean;
}

function DisclosureChevron({ expanded = false }: { expanded?: boolean }) {
  return <svg className={`model-thinking-chevron ${expanded ? 'is-open' : ''}`} width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m7 5 5 5-5 5" /></svg>;
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
      <span>模型思考</span><span className="model-thinking-state">{backupSnapshot ? '来自备份' : streaming ? '接收中' : '已保留'}</span>
      <span className="model-thinking-count" title="按可见思考文字估算，非服务商返回或计费用量。">≈ {estimatedTokens.toLocaleString()} tokens</span>
    </button>
    {expanded && <div className="model-thinking-body"><p className="model-thinking-note">{backupSnapshot ? '备份保留的思考文字，未经本机后台核验' : '模型服务实际返回的思考内容或摘要'}</p><div className="model-thinking-text">{text}</div></div>}
  </section>;
}

function ActionBar({ actions, status }: { actions?: BubbleActions; status?: ReactNode }) {
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
      {actions?.onRetry && actions.canModify && (
        <button type="button" className="msg-action" onClick={actions.onRetry} title="重新生成"><IconRetry size={14} /><span>重试</span></button>
      )}
      {status}
    </div>
  );
}

export default function MessageBubble({ message, sessionId, isStreaming, thinking, activity, stillWorking, actions, status, execution, backupSnapshot }: MessageBubbleProps) {
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
  const html = useMemo(() => {
    if (message.role === 'user') return '';
    return renderMarkdown(displayedContent, { allowMedia: !backupSnapshot });
  }, [displayedContent, message.role, backupSnapshot]);

  // ---- 用户消息 ----
  if (message.role === 'user') {
    // Attachment-only turns are intentionally invisible; the structured refs
    // remain in session state for retry but never leak paths into the chat UI.
    if (!message.content.trim()) return null;
    return (
      <div className="message-row user">
        <div className="msg-col user">
          <div className="message-bubble user">{message.content}</div>
          {!backupSnapshot && message.requestedModelRef && <p className="message-model-selection">本轮指定：{message.requestedModelRef}</p>}
          {actions && <ActionBar actions={actions} />}
        </div>
      </div>
    );
  }

  // ---- 助手消息 ----
  // 思考 / 活动：流式时用实时值；结束后用消息里持久化的值 —— 一直保留，不隐藏
  const effThinking = isStreaming ? (thinking || '') : (message.thinking || '');
  const liveActivity = isStreaming ? (activity || '') : '';
  const liveHint = isStreaming ? (stillWorking || '') : '';   // 防呆「未卡住」提示，附着显示、不顶掉真实状态
  const doneSteps = !isStreaming ? (message.activity || '') : '';

  const livePanel = (effThinking || liveActivity || liveHint || doneSteps) ? (
    <div className="live-panel">
      {liveActivity ? (
        <div className="live-activity">
          <span className="live-pulse" />{liveActivity}
          {liveHint && <span className="live-still"> · {liveHint}</span>}
        </div>
      ) : liveHint ? (
        <div className="live-activity"><span className="live-pulse" />{liveHint}</div>
      ) : null}
      {doneSteps && (
        <details className="thinking-block">
          <summary className="message-disclosure-toggle"><DisclosureChevron /><span>{backupSnapshot ? '备份活动文字' : '活动摘要'}</span></summary>
          {backupSnapshot && <p className="model-thinking-note">以下文字来自备份，未经本机后台核验。</p>}
          <div className="thinking-text">{doneSteps}</div>
        </details>
      )}
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
          <div className="typing-indicator">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </div>
          <span className="model-thinking-wait">等待模型响应…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="message-row assistant">
      <div className="msg-col assistant">
        <div className="message-bubble assistant">
          {livePanel}
          {execution}
          {displayedContent && <div dangerouslySetInnerHTML={{ __html: html }} />}
          {displayedError&&<section className="chat-response-error" role="alert"><strong>{chatErrorTitle(displayedError)}</strong><p>{displayedError.message}</p>{displayedError.stage && <p className="chat-response-error-hint">失败阶段：{displayedError.stage==='model_response'?'模型响应':displayedError.stage==='agent_execution'?'Agent 执行':displayedError.stage}</p>}{(displayedError.channel || displayedError.modelRef) && <p className="chat-response-error-hint">渠道：{displayedError.channel || '未上报'}{displayedError.channelEndpoint ? ` · ${displayedError.channelEndpoint}` : ''} · 模型：{displayedError.modelRef || '未上报'}</p>}{displayedError.detail && <details className="chat-error-details"><summary>服务返回详情</summary><pre>{displayedError.detail}</pre></details>}{displayedError.code&&<small>错误代码：{displayedError.code}</small>}{backupSnapshot ? <p className="chat-response-error-hint">这是备份中的失败记录，仅供查阅；需要继续时请新建对话。</p> : <>{displayedError.historical&&<p className="chat-response-error-hint">这是一条历史失败记录。修复认证配置后，可以重新发送或重试。</p>}{!displayedError.historical&&displayedError.category==='authentication'&&<p className="chat-response-error-hint">请先检查服务凭据与授权，再重新发送。</p>}</>}</section>}
          {isStreaming && <span className="streaming-cursor" />}
        </div>
        {(actions || status) && <ActionBar actions={isStreaming ? undefined : actions} status={status} />}
      </div>
    </div>
  );
}
