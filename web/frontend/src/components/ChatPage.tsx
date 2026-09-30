import { Fragment, useRef, useEffect } from 'react';
import ChatSkillEvidence from './ChatSkillEvidence';
import { useChatSkillAudits } from '../hooks/useChatSkillAudits';
import MessageBubble from './MessageBubble';
import QuestionCards from './QuestionCards';
import ChatComposer from './ChatComposer';
import { readSelectedSkills } from '../lib/selectedSkills';
import type { ChatSession, ChatMessage, StreamState } from '../lib/store';
import type { UploadedFile } from '../lib/api';

interface ChatPageProps {
  session: ChatSession;
  stream?: StreamState;          // 进行中的流式态（来自 App，切页也不丢）
  onSend: (displayText: string, attachments?: UploadedFile[], selectedSkills?: string[]) => void;
  onStop: () => void;
  onResend: (
    userIndex: number,
    displayText: string,
    attachments?: UploadedFile[],
    legacyAgentText?: string,
  ) => void; // 重试：仅对最后一轮
  onOpenAudit?: (turnId:string)=>void;
  onQuestionAnswered?: (questionId: string) => void;   // 某道问答题提交成功（App 记录答过，重放不再出现）
}

// 空态推荐（贴合 Easel 社媒创作场景）
const SUGGESTIONS = [
  { icon: '🔥', title: '蹭个热点', prompt: '看看现在微博和抖音有什么热搜，挑几个适合我做二创的选题' },
  { icon: '✍️', title: '写小红书文案', prompt: '帮我写一条小红书种草文案，主题先问我' },
  { icon: '🎴', title: '做金句卡片', prompt: '把一句走心的话做成一张适合发朋友圈的金句卡片' },
  { icon: '🎬', title: '口播脚本', prompt: '帮我写一条 60 秒的口播短视频脚本，主题先问我' },
];

function greeting(): string {
  const h = new Date().getHours();
  const g = h < 6 ? '夜深了' : h < 12 ? '上午好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  return `${g}，想创作点什么？`;
}

export default function ChatPage({ session, stream, onSend, onStop, onResend, onQuestionAnswered, onOpenAudit }: ChatPageProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isStreaming = !!stream;
  const skillAudits=useChatSkillAudits(session.id,isStreaming,session.messages.length);
  const isEmpty = session.messages.length === 0 && !isStreaming;

  useEffect(() => {
    if (!isEmpty) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.messages, stream?.content, stream?.thinking, stream?.activity, stream?.stillWorking, isEmpty]);

  // ---- 空态：居中欢迎页 ----
  if (isEmpty) {
    return (
      <div className="chat-page chat-welcome-page">
        <div className="chat-hero">
          <div className="chat-hero-brand">
            <img src="./static/easel-icon-transparent.png" alt="" />
            <span>Easel</span>
          </div>
          <h1 className="chat-hero-title">{greeting()}</h1>
          <p className="chat-hero-sub">从选题到发布，一站式帮你把想法做成能发的内容。</p>
          <ChatComposer key={session.id} sessionId={session.id} hero isStreaming={isStreaming} onSend={onSend} onStop={onStop} />
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s.title} className="card card-hover suggestion-card"
                onClick={() => { if (!isStreaming) onSend(s.prompt, undefined, readSelectedSkills(session.id)); }}>
                <span className="suggestion-icon">{s.icon}</span>
                <span className="suggestion-body">
                  <span className="suggestion-title">{s.title}</span>
                  <span className="suggestion-text">{s.prompt}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ---- 对话态 ----
  const displayMessages: ChatMessage[] = [...session.messages];
  if (isStreaming) displayMessages.push({ role: 'assistant', content: stream!.content || '' });

  return (
    <div className="chat-page chat-conversation-page">
      <div className="chat-messages">
        <div className="chat-thread">
          {displayMessages.map((msg, i) => {
            const isLast = i === displayMessages.length - 1;
            const live = isStreaming && isLast && msg.role === 'assistant';
            const isFinal = !live && i < session.messages.length;
            let actions;
            if (isFinal) {
              const copy = () => navigator.clipboard?.writeText(msg.content);
              // 只允许对「最后一轮」重试，契合 OpenClaw append-only 模型（不改写历史）；已移除编辑
              const isLastFinal = i === session.messages.length - 1;
              if (msg.role === 'user') {
                actions = {
                  onCopy: copy,
                  onRetry: isLastFinal
                    ? () => onResend(i, msg.content, msg.attachments, msg.agentContent)
                    : undefined,
                  canModify: !isStreaming,
                };
              } else {
                const pi = i - 1;
                const prevUser = pi >= 0 && session.messages[pi]?.role === 'user' ? session.messages[pi] : null;
                actions = {
                  onCopy: copy,
                  onRetry: (isLastFinal && prevUser)
                    ? () => onResend(pi, prevUser.content, prevUser.attachments, prevUser.agentContent)
                    : undefined,
                  canModify: !isStreaming,
                };
              }
            }
            const auditTurn=live?session.pendingTurnId:msg.turnId;
            const auditRecord=auditTurn?skillAudits.records.find(record=>record.turnId===auditTurn):undefined;
            const selectedSkills=i>0&&displayMessages[i-1].role==='user'?displayMessages[i-1].selectedSkills||[]:[];
            return (
              <Fragment key={`${i}-${msg.role}`}><MessageBubble
                key={`${i}-${msg.role}`}
                message={msg}
                isStreaming={live}
                thinking={live ? stream!.thinking : ''}
                activity={live ? stream!.activity : ''}
                stillWorking={live ? stream!.stillWorking : ''}
                actions={actions}
              />{msg.role==='assistant'&&(auditTurn||auditRecord)&&<ChatSkillEvidence key={auditTurn} sessionId={session.id} turnId={auditTurn!} record={auditRecord} selectedSkills={selectedSkills} streaming={live} error={live?skillAudits.error:undefined} onOpen={auditTurn&&onOpenAudit?()=>onOpenAudit(auditTurn):undefined}/>}</Fragment>
            );
          })}
          {isStreaming && (stream!.questions?.length ?? 0) > 0 && (
            <QuestionCards questions={stream!.questions || []} onDone={(qid) => onQuestionAnswered?.(qid)} />
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="chat-input-area">
        <div className="chat-input-inner"><ChatComposer key={session.id} sessionId={session.id} isStreaming={isStreaming} onSend={onSend} onStop={onStop} /></div>
      </div>
    </div>
  );
}
