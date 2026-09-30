import { chatErrorTitle, historicalGatewayAuthError } from '../lib/chatErrors';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '../lib/store';
import { renderMarkdown } from '../lib/sanitize';
import { IconCopy, IconCheck, IconRetry } from './icons';

export interface BubbleActions {
  onCopy: () => void | Promise<void>;
  onRetry?: () => void;    // 仅最后一轮可用（append-only：不改写历史）
  canModify: boolean;      // 流式中禁用 retry
}

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
  thinking?: string;
  activity?: string;
  stillWorking?: string;   // 防呆心跳提示（未卡住）；仅流式时的独立提示，不替代思考/活动
  actions?: BubbleActions;
}

function ThinkingPanel({ text, streaming }: { text: string; streaming: boolean }) {
  // Preserve the user's expanded/collapsed choice as new chunks and the final
  // answer arrive; binding `open` to answer emptiness used to override it.
  const [expanded, setExpanded] = useState(streaming);
  return <section className="model-thinking" aria-label="模型返回的思考内容">
    <button type="button" className="model-thinking-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span className={`model-thinking-chevron ${expanded ? 'is-open' : ''}`} aria-hidden="true">›</span>
      <span>模型思考</span><span className="model-thinking-state">{streaming ? '接收中' : '已保留'}</span>
      <span className="model-thinking-count">{text.length.toLocaleString()} 字符</span>
    </button>
    {expanded && <div className="model-thinking-body"><p className="model-thinking-note">模型服务实际返回的思考内容或摘要</p><div className="model-thinking-text">{text}</div></div>}
  </section>;
}

function ActionBar({ actions }: { actions: BubbleActions }) {
  const [copyStatus, setCopyStatus] = useState<'idle'|'copying'|'copied'|'failed'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  const copy = async () => {
    clearTimeout(resetTimer.current);
    setCopyStatus('copying');
    try {
      await actions.onCopy();
      setCopyStatus('copied');
      resetTimer.current = setTimeout(() => setCopyStatus('idle'), 1200);
    } catch {
      setCopyStatus('failed');
    }
  };
  return (
    <div className="msg-actions">
      <button type="button" className="msg-action" onClick={copy} disabled={copyStatus==='copying'} title="复制">
        {copyStatus==='copied' ? <IconCheck size={14} /> : <IconCopy size={14} />}<span>{copyStatus==='copied' ? '已复制' : copyStatus==='copying' ? '复制中…' : '复制'}</span>
      </button>
      {copyStatus==='failed'&&<span className="msg-copy-error" role="status">复制失败，请允许剪贴板访问后重试。</span>}
      {actions.onRetry && actions.canModify && (
        <button type="button" className="msg-action" onClick={actions.onRetry} title="重新生成"><IconRetry size={14} /><span>重试</span></button>
      )}
    </div>
  );
}

export default function MessageBubble({ message, isStreaming, thinking, activity, stillWorking, actions }: MessageBubbleProps) {
  const historicalError=message.role==='assistant'&&!message.error?historicalGatewayAuthError(message.content):undefined;
  const displayedError=message.error||historicalError;
  const displayedContent=historicalError?'':message.content;
  const html = useMemo(() => {
    if (message.role === 'user') return '';
    return renderMarkdown(displayedContent);
  }, [displayedContent, message.role]);

  // ---- 用户消息 ----
  if (message.role === 'user') {
    // Attachment-only turns are intentionally invisible; the structured refs
    // remain in session state for retry but never leak paths into the chat UI.
    if (!message.content.trim()) return null;
    return (
      <div className="message-row user">
        <div className="msg-col user">
          <div className="message-bubble user">{message.content}</div>
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
          <summary>执行记录（{doneSteps.split('\n').length} 步）</summary>
          <div className="thinking-text">{doneSteps}</div>
        </details>
      )}
      {effThinking && (
        <ThinkingPanel text={effThinking} streaming={Boolean(isStreaming)} />
      )}
    </div>
  ) : null;

  // 等待回复中（还没有正文、思考、活动）
  if (isStreaming && !message.content && !effThinking && !liveActivity && !liveHint) {
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
          {displayedContent && <div dangerouslySetInnerHTML={{ __html: html }} />}
          {displayedError&&<section className="chat-response-error" role="alert"><strong>{chatErrorTitle(displayedError)}</strong><p>{displayedError.message}</p>{displayedError.code&&<small>错误代码：{displayedError.code}</small>}{displayedError.historical&&<p className="chat-response-error-hint">这是一条历史失败记录。修复认证配置后，可以重新发送或重试。</p>}{!displayedError.historical&&displayedError.category==='authentication'&&<p className="chat-response-error-hint">请先检查服务凭据与授权，再重新发送。</p>}</section>}
          {isStreaming && <span className="streaming-cursor" />}
        </div>
        {actions && !isStreaming && <ActionBar actions={actions} />}
      </div>
    </div>
  );
}
