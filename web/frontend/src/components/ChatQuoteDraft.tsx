import { useRef } from 'react';
import { removeChatDraftQuote } from '../lib/chatDrafts';
import InlineInfo from './InlineInfo';

export default function ChatQuoteDraft({ sessionId, quotes, comment }: { sessionId: string; quotes: string[]; comment: string }) {
  const panel = useRef<HTMLDetailsElement>(null);
  if (!quotes.length) return null;
  return <div className="composer-quote-row"><details ref={panel} className="composer-quote-details"><summary aria-label={`查看 ${quotes.length} 条引用`}>▤ {quotes.length} 条引用</summary>
    <div className="composer-quote-panel" role="region" aria-label="引用内容与评论">
      {quotes.map((text, index) => <section key={index}><div className="composer-quote-heading"><span>{index + 1} · 所选文本</span><button type="button" aria-label={`移除引用 ${index + 1}`} onClick={() => removeChatDraftQuote(sessionId, index)}>×</button></div><blockquote>{text}</blockquote></section>)}
      {comment.trim() && <div className="composer-quote-comment"><span>你的评论</span><p>{comment}</p></div>}
    </div>
  </details><InlineInfo label="引用使用说明" hover onShow={() => { if (panel.current) panel.current.open = false; }}>在主输入框补充评论。发送时会携带引用原文与评论；添加引用不会自动发送。</InlineInfo></div>;
}
