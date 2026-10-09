import {historicalGatewayAuthError} from '../lib/chatErrors';
import ChatTurnNavigation from './ChatTurnNavigation';
import { chatTurnNodes,activeTurnFromOffsets,isChatAtBottom,shouldFollowChatScroll } from '../lib/chatNavigation';
import '../styles/chat-navigation.css';
import { Fragment, useRef, useEffect, useLayoutEffect, useMemo, useState, useCallback } from 'react';
import ChatSkillEvidence from './ChatSkillEvidence';
import { useChatSkillAudits } from '../hooks/useChatSkillAudits';
import MessageBubble from './MessageBubble';
import ChatExecutionPanel from './ChatExecutionPanel';
import QuestionCards from './QuestionCards';
import ChatComposer from './ChatComposer';
import '../styles/chat-workspace.css';
import { readSelectedSkills, readSkillRequirements } from '../lib/selectedSkills';
import type { SkillRequirements } from '../lib/selectedSkills';
import type { ChatSession, ChatMessage, StreamState } from '../lib/store';
import type { UploadedFile, ThinkingLevel } from '../lib/api';
import { loadComposerModel } from '../lib/composerModel';
import { loadThinkingLevel } from '../lib/thinkingLevel';
import { fetchOfficeTaskModels } from '../lib/officeControls';

interface ChatPageProps {
  session: ChatSession;
  stream?: StreamState;          // 进行中的流式态（来自 App，切页也不丢）
  stopping?: boolean;
  stopError?: string;
  onSend: (displayText: string, attachments?: UploadedFile[], selectedSkills?: string[], skillRequirements?: SkillRequirements, thinkingLevel?: ThinkingLevel, modelRef?: string) => boolean;
  onStop: () => void;
  onResend: (
    userIndex: number,
    displayText: string,
    attachments?: UploadedFile[],
    legacyAgentText?: string,
  ) => void; // 重试：仅对最后一轮
  onOpenAudit?: (turnId:string)=>void;
  onNewChat?: () => void;
  onOpenModels?: () => void;
  onQuestionAnswered?: (questionId: string) => void;   // 某道问答题提交成功（App 记录答过，重放不再出现）
}

// 空态推荐（贴合 Easel 社媒创作场景）；线性图标与全局 icon 库同风格
import { IconFire, IconEdit, IconLayout, IconVideo, IconPlus } from './icons';
import type { ComponentType } from 'react';
type Suggestion = { Icon: ComponentType<{ size?: number }>; title: string; prompt: string };
const SUGGESTIONS: Suggestion[] = [
  { Icon: IconFire, title: '蹭个热点', prompt: '看看现在微博和抖音有什么热搜，挑几个适合我做二创的选题' },
  { Icon: IconEdit, title: '写小红书文案', prompt: '帮我写一条小红书种草文案，主题先问我' },
  { Icon: IconLayout, title: '做金句卡片', prompt: '把一句走心的话做成一张适合发朋友圈的金句卡片' },
  { Icon: IconVideo, title: '口播脚本', prompt: '帮我写一条 60 秒的口播短视频脚本，主题先问我' },
];

function greeting(): string {
  const h = new Date().getHours();
  const g = h < 6 ? '夜深了' : h < 12 ? '上午好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  return `${g}，想创作点什么？`;
}

export default function ChatPage({ session, stream, stopping = false, stopError, onSend, onStop, onResend, onQuestionAnswered, onOpenAudit, onNewChat, onOpenModels }: ChatPageProps) {
  const [suggestionError, setSuggestionError] = useState('');
  const suggestionContext = useRef({ sessionId: session.id, blocked: Boolean(stream || stopping || session.importedFromBackup) });
  suggestionContext.current = { sessionId: session.id, blocked: Boolean(stream || stopping || session.importedFromBackup) };
  const suggestionPending = useRef(false);
  const suggestionMounted = useRef(true);
  useEffect(() => { suggestionMounted.current = true; return () => { suggestionMounted.current = false; }; }, []);
  const sendSuggestion = async (prompt: string) => {
    if (stream || stopping || session.importedFromBackup || suggestionPending.current) return;
    const skills = readSelectedSkills(session.id), requirements = readSkillRequirements(session.id, skills);
    const modelRef = loadComposerModel();
    if (!modelRef) { onSend(prompt, undefined, skills, requirements); return; }
    suggestionPending.current = true;
    try {
      const capability = await fetchOfficeTaskModels(session.id, new AbortController().signal);
      if (!suggestionMounted.current || suggestionContext.current.sessionId !== session.id || suggestionContext.current.blocked) return;
      if (!capability.available || !capability.options.some(option => option.id === modelRef && option.configured)) { setSuggestionError('所选模型当前不可用，请在输入框刷新模型或改用会话配置。'); return; }
      setSuggestionError(''); onSend(prompt, undefined, skills, requirements, loadThinkingLevel(), modelRef);
    } catch { if (suggestionMounted.current && suggestionContext.current.sessionId === session.id && !suggestionContext.current.blocked) setSuggestionError('模型选项暂不可核验，请在输入框刷新后重试。'); }
    finally { suggestionPending.current = false; }
  };
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef=useRef<HTMLDivElement>(null);
  const turnRefs=useRef(new Map<number,HTMLDivElement>());
  const followLatest=useRef(true);
  const navigationTarget=useRef<number|null>(null);
  const lastScrollTop=useRef(0);
  const [following,setFollowing]=useState(true);
  const [currentTurn,setCurrentTurn]=useState(0);
  const nodes=useMemo(()=>chatTurnNodes(session.messages, session.importedFromBackup ? '' : stream?.content),[session.messages,session.importedFromBackup,stream?.content]);
  const previousCount=useRef(nodes.length);
  const syncPosition=useCallback(()=>{
    const element=scrollRef.current;if(!element)return;
    const atBottom=isChatAtBottom(element.scrollTop,element.scrollHeight,element.clientHeight);
    followLatest.current=shouldFollowChatScroll(followLatest.current,lastScrollTop.current,element.scrollTop,element.scrollHeight,element.clientHeight,navigationTarget.current!==null);
    lastScrollTop.current=element.scrollTop;setFollowing(followLatest.current);
    if(navigationTarget.current!==null){setCurrentTurn(navigationTarget.current);return;}
    const origin=element.getBoundingClientRect().top;
    const offsets=nodes.map(node=>(turnRefs.current.get(node.messageIndex)?.getBoundingClientRect().top??origin)-origin+element.scrollTop);
    setCurrentTurn(Math.max(0,activeTurnFromOffsets(offsets,element.scrollTop,atBottom)));
  },[nodes]);
  const goLatest=()=>{navigationTarget.current=null;followLatest.current=true;setFollowing(true);const element=scrollRef.current;if(element){element.scrollTo({top:element.scrollHeight,behavior:'instant'});lastScrollTop.current=element.scrollTop;}setCurrentTurn(Math.max(0,nodes.length-1));};
  const jumpTo=(index:number)=>{
    if(index<0||index>=nodes.length)return;
    const element=scrollRef.current,anchor=turnRefs.current.get(nodes[index].messageIndex);if(!element||!anchor)return;
    navigationTarget.current=index;followLatest.current=false;setFollowing(false);setCurrentTurn(index);
    element.scrollTo({top:anchor.getBoundingClientRect().top-element.getBoundingClientRect().top+element.scrollTop-22,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    anchor.focus({preventScroll:true});
  };
  const isImported = session.importedFromBackup === true;
  const isStreaming = !isImported && !!stream;
  const skillAudits=useChatSkillAudits(session.id,isStreaming,session.messages.length,isImported);
  const isEmpty = session.messages.length === 0 && !isStreaming;
  const header = <header className="chat-header">
    <div className="chat-header-context"><span>对话</span><span aria-hidden="true">/</span><h2 title={session.title}>{isEmpty ? '新对话' : session.title}</h2></div>
    <div className="chat-header-actions">
      {isImported ? <span className="chat-header-status">只读备份</span> : isStreaming && <span className="chat-header-status" role="status">{stopping ? '正在停止' : '进行中'}</span>}
      {!isEmpty && onNewChat && <button type="button" className="chat-new-button" onClick={onNewChat} title="新建对话" aria-label="新建对话"><IconPlus size={16} /><span>新对话</span></button>}
    </div>
  </header>;

  useLayoutEffect(()=>{
    if(nodes.length>previousCount.current){navigationTarget.current=null;followLatest.current=true;}
    previousCount.current=nodes.length;
    if(!isEmpty&&followLatest.current){const element=scrollRef.current;if(element){element.scrollTop=element.scrollHeight;lastScrollTop.current=element.scrollTop;}setFollowing(true);setCurrentTurn(Math.max(0,nodes.length-1));}
  },[session.messages,stream?.content,stream?.thinking,stream?.activity,stream?.stillWorking,isEmpty,nodes.length]);
  useEffect(()=>{
    const thread=messagesEndRef.current?.parentElement,element=scrollRef.current;if(!thread||!element||typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(()=>{
      if(followLatest.current){element.scrollTop=element.scrollHeight;lastScrollTop.current=element.scrollTop;}
      else syncPosition();
    });
    observer.observe(thread);observer.observe(element);return()=>observer.disconnect();
  },[isEmpty,syncPosition]);

  // ---- 空态：居中欢迎页 ----
  if (isEmpty && !isImported) {
    return (
      <div className="chat-page chat-welcome-page">
        {header}
        <div className="chat-hero">
          <h1 className="chat-hero-title">{greeting()}</h1>
          <p className="chat-hero-sub">从一个想法开始，一起把内容做好。</p>
          <ChatComposer key={session.id} sessionId={session.id} hero isStreaming={isStreaming} stopping={stopping} onSend={onSend} onStop={onStop} onOpenModels={onOpenModels} />
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s.title} className="suggestion-card" title={s.prompt}
                onClick={() => void sendSuggestion(s.prompt)}>
                <span className="suggestion-icon" aria-hidden="true"><s.Icon size={18} /></span>
                <span className="suggestion-body">
                  <span className="suggestion-title">{s.title}</span>
                </span>
              </button>
            ))}
          </div>
          {suggestionError && <p role="alert" className="composer-upload-error">{suggestionError}</p>}
        </div>
      </div>
    );
  }

  // ---- 对话态 ----
  const displayMessages: ChatMessage[] = [...session.messages];
  if (isStreaming) displayMessages.push({ role: 'assistant', content: stream!.content || '' });

  return (
    <div className="chat-page chat-conversation-page">
      {header}
      {isImported && <section className="chat-backup-notice" aria-label="导入记录说明">
        <div>
          <strong>备份导入的只读记录</strong>
          <p>这是本地备份副本，不会恢复后台上下文、未完成任务或 Skill 核验。你可以复制内容，在新对话中继续。</p>
          <p>图片和附件文件不在备份中，媒体不会自动载入；活动文字仅来自备份，未经本机核验。</p>
          {session.backupIncomplete && <p className="chat-backup-incomplete">备份时对话尚未结束，以下内容可能不完整；不会自动续传或恢复执行。</p>}
        </div>
        {onNewChat && <button type="button" className="btn" onClick={onNewChat}>新建对话继续</button>}
      </section>}
      <div className="chat-conversation-body"><div className="chat-messages" ref={scrollRef} onScroll={syncPosition}
        onWheel={event=>{if(event.deltaY)navigationTarget.current=null;if(event.deltaY<0){followLatest.current=false;setFollowing(false);}}}
        onTouchMove={()=>{navigationTarget.current=null;}}
        onPointerDown={event=>{if(event.target===event.currentTarget)navigationTarget.current=null;}}
        onKeyDown={event=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)&&!(event.target as HTMLElement).closest('button,input,textarea,select,a,[contenteditable="true"]'))navigationTarget.current=null;}}>
        <div className="chat-thread">
          {isImported && isEmpty && <p className="chat-backup-empty">这份备份没有可显示的消息。</p>}
          {displayMessages.map((msg, i) => {
            const isLast = i === displayMessages.length - 1;
            const live = isStreaming && isLast && msg.role === 'assistant';
            const isFinal = !live && i < session.messages.length;
            let actions;
            if (isFinal) {
              const copy = () => {if(!navigator.clipboard?.writeText)throw new Error('剪贴板不可用');const historical=msg.role==='assistant'&&!msg.error?historicalGatewayAuthError(msg.content):undefined;return navigator.clipboard.writeText(historical?['历史失败记录',historical.message,historical.code].join('\n\n'):msg.error?[msg.content,msg.error.message,msg.error.code].filter(Boolean).join('\n\n'):msg.content);};
              // 只允许对「最后一轮」重试，契合 OpenClaw append-only 模型（不改写历史）；已移除编辑
              const isLastFinal = i === session.messages.length - 1;
              if (msg.role === 'user') {
                actions = {
                  onCopy: copy,
                  onRetry: !isImported && isLastFinal
                    ? () => onResend(i, msg.content, msg.attachments, msg.agentContent)
                    : undefined,
                  canModify: !isImported && !isStreaming && !stopping,
                };
              } else {
                const pi = i - 1;
                const prevUser = pi >= 0 && session.messages[pi]?.role === 'user' ? session.messages[pi] : null;
                actions = {
                  onCopy: copy,
                  onRetry: (!isImported && isLastFinal && prevUser)
                    ? () => onResend(pi, prevUser.content, prevUser.attachments, prevUser.agentContent)
                    : undefined,
                  canModify: !isImported && !isStreaming && !stopping,
                };
              }
            }
            const auditTurn=live?session.pendingTurnId:msg.turnId;
            const auditRecord=auditTurn?skillAudits.records.find(record=>record.turnId===auditTurn):undefined;
            const selectedSkills=i>0&&displayMessages[i-1].role==='user'?displayMessages[i-1].selectedSkills||[]:[];
            return (
              <Fragment key={`${i}-${msg.role}`}>{msg.role==='user'&&<div className="chat-turn-anchor" tabIndex={-1} aria-label={`第 ${nodes.find(node=>node.messageIndex===i)?.number||1} 轮对话`} ref={element=>{if(element)turnRefs.current.set(i,element);else turnRefs.current.delete(i);}}/>}<MessageBubble
                key={`${i}-${msg.role}`}
                message={msg}
                backupSnapshot={isImported}
                isStreaming={live}
                thinking={live ? stream!.thinking : ''}
                activity={live ? stream!.activity : ''}
                stillWorking={live ? stream!.stillWorking : ''}
                actions={actions}
                execution={!isImported && msg.role === 'assistant' && auditTurn ? <ChatExecutionPanel key={auditTurn} sessionId={session.id} turnId={auditTurn} streaming={live} onOpen={onOpenAudit ? () => onOpenAudit(auditTurn) : undefined} /> : undefined}
                status={!isImported&&msg.role==='assistant'&&(auditTurn||auditRecord)?<ChatSkillEvidence key={auditTurn} sessionId={session.id} turnId={auditTurn!} record={auditRecord} selectedSkills={selectedSkills} streaming={live} error={live?skillAudits.error:undefined} onOpen={auditTurn&&onOpenAudit?()=>onOpenAudit(auditTurn):undefined}/>:undefined}
              /></Fragment>
            );
          })}
          {isStreaming && (stream!.questions?.length ?? 0) > 0 && (
            <QuestionCards questions={stream!.questions || []} onDone={(qid) => onQuestionAnswered?.(qid)} />
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>{nodes.length>0&&<ChatTurnNavigation key={session.id} nodes={nodes} current={currentTurn} following={following} onJump={jumpTo} onLatest={goLatest}/>}</div>

      {(!isImported || !following) && <div className="chat-input-area">{!following&&<button type="button" className="chat-return-latest" onClick={goLatest}>{isStreaming?'返回最新进度 ↓':'回到最新一轮 ↓'}</button>}
        {!isImported && <div className="chat-input-inner">
          {stopping && <p className="composer-skills-note" role="status">正在请求停止，等待后端确认…</p>}
          {stopError && <div className="composer-upload-error" role="alert">{stopError}{isStreaming && <button type="button" className="btn btn-sm" disabled={stopping} onClick={onStop}>重试停止</button>}</div>}
          <ChatComposer key={session.id} sessionId={session.id} isStreaming={isStreaming} stopping={stopping} onSend={onSend} onStop={onStop} onOpenModels={onOpenModels} />
        </div>}
      </div>}
    </div>
  );
}
