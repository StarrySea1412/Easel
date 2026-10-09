import type {ChatCompaction} from '../lib/chatCompaction';
import '../styles/chat-compaction.css';
export default function ChatCompactionIndicator({event}:{event?:ChatCompaction}) {
 if(!event)return null;
 const active=event.phase==='start';
 const label=active?'正在压缩上下文':event.outcome==='completed'?'上下文已压缩':event.outcome==='failed'?'上下文压缩失败':event.outcome==='aborted'?'上下文压缩已中断':'本次未执行压缩';
 return <div className={`chat-compaction${active?' is-active':''}${event.outcome==='failed'?' is-error':''}`} role="status" aria-live="polite" title="网关上报的上下文压缩状态；完整对话记录仍保留在本地。">
   <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><path d="M6 3H4v14h2M14 3h2v14h-2"/><path className="compact-line top" d="M8 6h4"/><path d="M7 10h6"/><path className="compact-line bottom" d="M8 14h4"/></svg>
   <span>{label}</span>
 </div>;
}
