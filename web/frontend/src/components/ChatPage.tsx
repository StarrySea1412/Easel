import {historicalGatewayAuthError} from '../lib/chatErrors';
import ChatTurnNavigation from './ChatTurnNavigation';
import { chatTurnNodes,activeTurnFromOffsets,isChatAtBottom,shouldFollowChatScroll } from '../lib/chatNavigation';
import '../styles/chat-navigation.css';
import { Fragment, useRef, useEffect, useLayoutEffect, useMemo, useState, useCallback } from 'react';
import ChatSkillEvidence from './ChatSkillEvidence';
import { useChatSkillAudits } from '../hooks/useChatSkillAudits';
import MessageBubble from './MessageBubble';
import ChatArtifacts from './ChatArtifacts';
import ChatGoalPanel from './ChatGoalPanel';
import { type TaskSnapshot, type TaskGoal } from '../lib/tasks';
import { taskRequest } from '../lib/tasks';
import { showToast } from '../lib/toast';
import { useChatArtifacts } from '../hooks/useChatArtifacts';
import ChatExecutionPanel from './ChatExecutionPanel';
import CodexRunPanel from './CodexRunPanel';
import QuestionCards from './QuestionCards';
import ChatComposer from './ChatComposer';
import ChatQuoteToolbar from './ChatQuoteToolbar';
import '../styles/chat-workspace.css';
import { getChatDraft, setChatDraftText, removeChatDraftQuote, subscribeChatDraft } from '../lib/chatDrafts';
import { readLocalValue, writeLocalValue } from '../lib/localPersistence';
import '../styles/chat-side-panel.css';
import { readSelectedSkills, readSkillRequirements } from '../lib/selectedSkills';
import type { SkillRequirements } from '../lib/selectedSkills';
import type { ChatSession, ChatMessage, StreamState } from '../lib/store';
import type { UploadedFile, ThinkingLevel } from '../lib/api';
import { loadComposerModel } from '../lib/composerModel';
import { loadThinkingLevel, resolveThinkingPreference } from '../lib/thinkingLevel';
import { fetchOfficeTaskModels } from '../lib/officeControls';

interface ChatPageProps {
  taskState?:TaskSnapshot;
  onTaskChange?:()=>void;
  onEngineChange?: (engine:'openclaw'|'codex') => void;
  session: ChatSession;
  stream?: StreamState;          // 进行中的流式态（来自 App，切页也不丢）
  stopping?: boolean;
  stopError?: string;
  onSend: (displayText: string, attachments?: UploadedFile[], selectedSkills?: string[], skillRequirements?: SkillRequirements, thinkingLevel?: ThinkingLevel, modelRef?: string) => boolean;
  onStop: () => void;
  onEdit?: (userIndex: number, text: string, signal: AbortSignal) => Promise<boolean>;
  onOpenSource?: (sessionId: string) => void;
  onSteer?: (id: string) => Promise<boolean>;
  onResend: (
    userIndex: number,
    displayText: string,
    attachments?: UploadedFile[],
    legacyAgentText?: string,
  ) => void; // 重试：仅对最后一轮
  onOpenAudit?: (turnId:string)=>void;
  onNewChat?: () => void;
  onOpenModels?: (modelRef?: string) => void;
  onQuestionAnswered?: (questionId: string) => void;   // 某道问答题提交成功（App 记录答过，重放不再出现）
  onScheduleDraft?: (text: string) => void;            // 对话内提交定时任务草稿（App 切到定时任务页）
  sideSession?: ChatSession;                            // 辅助对话（父会话的子会话），只在侧边面板里展示
  onSideChat?: () => void;                              // 打开侧边面板并确保子会话存在
  onSideSend?: (text: string) => void;                  // 发消息到辅助对话
  onSideStop?: () => void;                              // 停止辅助对话的生成
  onQuoteFromMain?: () => void;                         // 主对话上一轮 → 辅助对话草稿引用
  onQuoteToMain?: () => void;                           // 辅助对话最后答复 → 主对话草稿引用
  onShare?: () => void;                                 // 把当前对话的完整快照发布为分享
  onLoadShare?: () => void;                             // 把接管回传内容合并进当前对话
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

export default function ChatPage({ session, stream, stopping = false, stopError, onEngineChange, onSend, onStop, onEdit, onOpenSource, onSteer, onResend, onQuestionAnswered, onOpenAudit, onNewChat, onOpenModels, taskState,onTaskChange,onScheduleDraft, sideSession, onSideChat, onSideSend, onSideStop, onQuoteFromMain, onQuoteToMain, onShare, onLoadShare }: ChatPageProps) {
  const sessionGoals=taskState?.goals.filter(g=>g.sessionId===session.id)||[];
  const goal=sessionGoals.find(g=>!['completed','cancelled'].includes(g.status))||sessionGoals[0];
  const taskRuns=taskState?.runs.filter(r=>r.goalId===goal?.id)||[];
  const taskLive=taskRuns.some(r=>['queued','running','unconfirmed'].includes(r.state));
  const taskBusy=goal?.status==='active'||taskLive;
  const goalActive=goal?.status==='active';
  const [panelOpen,setPanelOpen]=useState(true);
  const [goalEditor,setGoalEditor]=useState<{seed?:string;modelRef?:string;onConfigured?:()=>void;goal?:TaskGoal;welcome?:boolean}|null>(null);
  const [panelTab,setPanelTab]=useState<'goal'|'side'>('goal');
  const PANEL_WIDTH_KEY='easel:chat-panel-width';
  const [panelWidth,setPanelWidth]=useState(()=>{const {ok,value}=readLocalValue(PANEL_WIDTH_KEY);const n=value?Number(value):NaN;return ok&&Number.isFinite(n)&&n>=280&&n<=560?n:340;});
  const panelWidthRef=useRef(panelWidth);panelWidthRef.current=panelWidth;
  const startPanelResize=(event:React.PointerEvent)=>{event.preventDefault();const startX=event.clientX,startW=panelWidthRef.current;
    const move=(moveEvent:PointerEvent)=>setPanelWidth(Math.max(280,Math.min(560,startW-(moveEvent.clientX-startX))));
    const finish=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);writeLocalValue(PANEL_WIDTH_KEY,String(Math.round(panelWidthRef.current)));};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);};
  const openSidePanel=()=>{setPanelTab('side');setPanelOpen(true);onSideChat?.();};
  useEffect(()=>{setPanelOpen(true);setGoalEditor(null);},[session.id]);
  const openGoal=(seed?:string,modelRef?:string,onConfigured?:()=>void)=>{
    setPanelOpen(true);setPanelTab('goal');
    if(taskLive){setGoalEditor(null);return;}
    if(!goal||seed||['completed','cancelled'].includes(goal.status))setGoalEditor({seed,modelRef,onConfigured,goal:goal&&!['completed','cancelled'].includes(goal.status)?goal:undefined,welcome:isEmpty});
  };
  /** Codex-style /goal with no text: view the current goal, otherwise start setup. */
  const viewGoal=()=>{
    if(goal&&!['completed','cancelled'].includes(goal.status)){setPanelOpen(true);setPanelTab('goal');setGoalEditor(null);}
    else openGoal();
  };
  /** Local lifecycle actions from /goal pause|resume|clear and the command menu. */
  const runGoalAction=async(action:'pause'|'resume'|'clear')=>{
    if(!goal){showToast('当前对话还没有目标；输入 /goal 描述目标后再操作。','info');return;}
    if(action==='pause'&&!goalActive){showToast('目标当前不在推进中。','info');return;}
    if(action==='resume'&&goalActive){showToast('目标已在推进中。','info');return;}
    try{
      // pause reuses the panel's stop path so a live round is interrupted too.
      const mapped=action==='pause'?'stop':action==='resume'?(goal.status==='draft'?'start':'resume'):'cancel';
      await taskRequest(`/goals/${goal.id}/action`,{action:mapped});
      onTaskChange?.();
      showToast(action==='pause'?'目标已暂停；继续时输入 /goal resume。':action==='resume'?'目标已继续，将从当前记录恢复。':'目标已清除，历史与产物记录保留。','success');
    }catch(e){showToast(e instanceof Error?e.message:'目标操作失败，请重试。','error');}
  };
  const closeGoalEditor=()=>{setGoalEditor(null);requestAnimationFrame(()=>document.querySelector<HTMLTextAreaElement>('.chat-page textarea.chat-input')?.focus());};
  const panelVisible=panelOpen&&!goalEditor&&!session.importedFromBackup;
  const withGoal=(content:React.ReactNode)=><div className={`chat-goal-workspace${panelVisible&&panelTab==='goal'&&goal?' has-goal-panel':''}${panelVisible&&panelTab==='side'&&sideSession?' has-side-panel':''}`}>
    {content}
    {panelVisible&&(goal||sideSession)&&<aside className="chat-side-panel" style={{width:panelWidth}} aria-label="对话侧边面板">
      <header className="chat-side-panel-head">
        <div className="chat-side-panel-tabs" role="tablist" aria-label="侧边面板">
          <button type="button" role="tab" aria-selected={panelTab==='side'} className={panelTab==='side'?'is-on':''} onClick={()=>{setPanelTab('side');onSideChat?.();}}>辅助对话</button>
          {goal&&<button type="button" role="tab" aria-selected={panelTab==='goal'} className={panelTab==='goal'?'is-on':''} onClick={()=>setPanelTab('goal')}>目标</button>}
        </div>
        <button type="button" className="chat-side-panel-close" aria-label="收起侧边面板" title="收起" onClick={()=>setPanelOpen(false)}>×</button>
      </header>
      {panelTab==='goal'&&goal
        ? <ChatGoalPanel key={goal.id} goal={goal} runs={taskRuns} onChanged={()=>onTaskChange?.()} onClose={()=>setPanelOpen(false)} onEdit={()=>setGoalEditor({goal:!['completed','cancelled'].includes(goal.status)?goal:undefined,welcome:isEmpty})}/>
        : sideSession?<SideChatThread session={sideSession} onSend={onSideSend} onStop={onSideStop} onQuoteFromMain={onQuoteFromMain} onQuoteToMain={onQuoteToMain}/>:<p className="chat-side-panel-empty">正在准备辅助对话…</p>}
      <div className="chat-side-panel-resize" role="separator" aria-orientation="vertical" aria-label="调整侧边面板宽度" onPointerDown={startPanelResize}/>
    </aside>}
  </div>;
  const deliveries = useChatArtifacts(session.id, !session.importedFromBackup, Boolean(stream));
  const [suggestionError, setSuggestionError] = useState('');
  const suggestionContext = useRef({ sessionId: session.id, blocked: Boolean(stream || stopping || session.importedFromBackup) });
  suggestionContext.current = { sessionId: session.id, blocked: Boolean(stream || stopping || session.importedFromBackup) };
  const suggestionPending = useRef(false);
  const suggestionMounted = useRef(true);
  useEffect(() => { suggestionMounted.current = true; return () => { suggestionMounted.current = false; }; }, []);
  const sendSuggestion = async (prompt: string) => {
    if (stream || stopping || taskBusy || session.importedFromBackup || suggestionPending.current) return;
    if (session.engine === 'codex') { onSend(prompt); return; }
    const skills = readSelectedSkills(session.id), requirements = readSkillRequirements(session.id, skills);
    const modelRef = loadComposerModel();
    suggestionPending.current = true;
    try {
      const capability = await fetchOfficeTaskModels(session.id, new AbortController().signal);
      if (!suggestionMounted.current || suggestionContext.current.sessionId !== session.id || suggestionContext.current.blocked) return;
      const effective = capability.options.find(option => option.id === (modelRef || capability.currentModelRef || capability.defaultModelRef) && option.configured);
      if (!capability.available || (modelRef && !effective)) { setSuggestionError('所选模型当前不可用，请在输入框刷新模型或改用会话配置。'); return; }
      setSuggestionError(''); onSend(prompt, undefined, skills, requirements, resolveThinkingPreference(loadThinkingLevel(), effective?.thinkingLevels), modelRef || undefined);
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
  const skillAudits=useChatSkillAudits(session.id,isStreaming,session.messages.length,isImported || session.engine === 'codex');
  // Keep the setup mounted when polling adds the goal-created message, so a failed
  // start can retry its saved ID rather than creating the goal a second time.
  const isEmpty = goalEditor?.welcome ?? (session.messages.length === 0 && !isStreaming && !deliveries.items.length && !deliveries.jobs.length && !deliveries.messages.length);
  const header = <header className="chat-header">
    <div className="chat-header-context"><span>对话</span><span aria-hidden="true">/</span><h2 title={session.title}>{isEmpty ? '新对话' : session.title}</h2></div>
    <div className="chat-header-actions">
      {!isImported&&onShare&&<button type="button" className="chat-new-button chat-share-trigger" onClick={onShare} title="把完整对话分享给外部模型接管（本地 token）">分享</button>}
      {!isImported&&session.share&&onLoadShare&&<button type="button" className="chat-new-button chat-share-load" onClick={onLoadShare} title={`分享 token：${session.share.token}`}>加载接管内容</button>}
      {!isImported&&!goalEditor&&<button type="button" className="chat-new-button chat-side-trigger" onClick={openSidePanel} aria-expanded={panelVisible&&panelTab==='side'}><span aria-hidden="true">◫</span> 辅助对话</button>}
      {!isImported&&goal&&!goalEditor&&<button type="button" className="chat-new-button chat-goal-trigger" aria-label="查看当前目标" aria-expanded={panelOpen} onClick={()=>setPanelOpen(v=>!v)}><span aria-hidden="true">◎</span> 目标{goal?.steps?.length?` ${goal.steps.filter(s=>s.status==='completed').length}/${goal.steps.length}`:''}</button>}
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
    return withGoal(
      <div className="chat-page chat-welcome-page">
        {header}
        <div className="chat-hero">
          <h1 className="chat-hero-title">{greeting()}</h1>
          <p className="chat-hero-sub">从一个想法开始，一起把内容做好。</p>
          <ChatComposer key={session.id} usageRefreshKey={session.messages.length} sessionId={session.id} engine={session.engine} engineLocked={Boolean(session.messages.length || session.pendingTurnId || deliveries.items.length || deliveries.messages.length || deliveries.jobs.length)} onEngineChange={onEngineChange} compaction={session.importedFromBackup ? undefined : stream?.compaction} onGoal={openGoal} goalEditor={goalEditor} onGoalClose={closeGoalEditor} onGoalChanged={()=>onTaskChange?.()} goalBusy={taskLive} goalActive={goalActive} goalStatus={goal?.status} onGoalAction={runGoalAction} onGoalView={viewGoal} onScheduleDraft={onScheduleDraft} onSideChat={openSidePanel} hero isStreaming={isStreaming} stopping={stopping} onSend={onSend} onStop={onStop} onOpenModels={onOpenModels} />
          {!goalEditor&&<div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s.title} className="suggestion-card" title={s.prompt}
                onClick={() => void sendSuggestion(s.prompt)}>
                <span className="suggestion-icon" aria-hidden="true"><s.Icon size={18} /></span>
                <span className="suggestion-body">
                  <span className="suggestion-title">{s.title}</span>
                </span>
              </button>
            ))}
          </div>}
          {suggestionError && <p role="alert" className="composer-upload-error">{suggestionError}</p>}
        </div>
      </div>
    );
  }

  // ---- 对话态 ----
  const displayMessages: ChatMessage[] = [...session.messages];
  for (const message of deliveries.messages) {
    if (!displayMessages.some(item => item.role === 'assistant' && (item.turnId === message.turnId || item.content === message.content))) displayMessages.push({ role: 'assistant', content: message.content, turnId: message.turnId, externalSource: 'gateway-injected' });
  }
  const knownTurns = new Set(displayMessages.filter(m => m.role === 'assistant').map(m => m.turnId));
  for (const turnId of new Set([...deliveries.items, ...deliveries.jobs].map(item => item.turnId))) {
    if (!knownTurns.has(turnId) && turnId !== session.pendingTurnId) displayMessages.push({ role: 'assistant', content: '', turnId });
  }
  if (isStreaming) displayMessages.push({ role: 'assistant', content: stream!.content || '', startedAt: stream!.startedAt, elapsedMs: stream!.elapsedMs });

  return withGoal(
    <div className="chat-page chat-conversation-page">
      {header}
      {session.editBranch && !isImported && <div className="chat-edit-branch-notice"><span>编辑分支 · 已带入此前可见消息，原对话保留</span>{onOpenSource && <button type="button" className="btn btn-sm" onClick={() => onOpenSource(session.editBranch!.sourceSessionId)}>查看原对话</button>}</div>}
      {isImported && <section className="chat-backup-notice" aria-label="导入记录说明">
        <div>
          <strong>备份导入的只读记录</strong>
          <p>这是本地备份副本，不会恢复后台上下文、未完成任务或 Skill 核验。你可以复制内容，在新对话中继续。</p>
          <p>图片和附件文件不在备份中，媒体不会自动载入；活动文字仅来自备份，未经本机核验。</p>
          {session.backupIncomplete && <p className="chat-backup-incomplete">备份时对话尚未结束，以下内容可能不完整；不会自动续传或恢复执行。</p>}
        </div>
        {onNewChat && <button type="button" className="btn" onClick={onNewChat}>新建对话继续</button>}
      </section>}
      {!isImported && <ChatQuoteToolbar key={session.id} sessionId={session.id} root={scrollRef}/>}<div className="chat-conversation-body"><div className="chat-messages" ref={scrollRef} onScroll={syncPosition}
        onWheel={event=>{if(event.deltaY)navigationTarget.current=null;if(event.deltaY<0){followLatest.current=false;setFollowing(false);}}}
        onTouchMove={()=>{navigationTarget.current=null;}}
        onPointerDown={event=>{if(event.target===event.currentTarget)navigationTarget.current=null;}}
        onKeyDown={event=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)&&!(event.target as HTMLElement).closest('button,input,textarea,select,a,[contenteditable="true"]'))navigationTarget.current=null;}}>
        <div className="chat-thread">
          {deliveries.note && <p role="status">{deliveries.note} <button type="button" className="link-btn" onClick={deliveries.retry}>重新读取产物</button></p>}
          {isImported && isEmpty && <p className="chat-backup-empty">这份备份没有可显示的消息。</p>}
          {displayMessages.map((msg, i) => {
            const isLast = i === displayMessages.length - 1;
            const live = isStreaming && isLast && msg.role === 'assistant';
            const isFinal = !live && i < session.messages.length;
            let actions;
            if (isFinal) {
              const copy = () => {if(!navigator.clipboard?.writeText)throw new Error('剪贴板不可用');const historical=msg.role==='assistant'&&!msg.error?historicalGatewayAuthError(msg.content):undefined;return navigator.clipboard.writeText(historical?['历史失败记录',historical.message,historical.code].join('\n\n'):msg.error?[msg.content,msg.error.message,msg.error.code].filter(Boolean).join('\n\n'):msg.content);};
              // Retry appends to the same runtime; editing creates a fresh branch.
              const isLastFinal = i === session.messages.length - 1;
              if (msg.role === 'user') {
                actions = {
                  onCopy: copy,
                  onEdit: !isImported && onEdit ? (text: string, signal: AbortSignal) => onEdit(i, text, signal) : undefined,
                  onRetry: !isImported && isLastFinal
                    ? () => onResend(i, msg.content, msg.attachments, msg.agentContent)
                    : undefined,
                  canModify: !isImported && !taskBusy && !isStreaming && !stopping && !session.pendingTurnId,
                };
              } else {
                const pi = i - 1;
                const prevUser = pi >= 0 && session.messages[pi]?.role === 'user' ? session.messages[pi] : null;
                actions = {
                  onCopy: copy,
                  onRetry: (!isImported && isLastFinal && prevUser)
                    ? () => onResend(pi, prevUser.content, prevUser.attachments, prevUser.agentContent)
                    : undefined,
                  canModify: !isImported && !taskBusy && !isStreaming && !stopping,
                };
              }
            }
            const auditTurn=live?session.pendingTurnId:msg.turnId;
            const auditRecord=auditTurn?skillAudits.records.find(record=>record.turnId===auditTurn):undefined;
            const selectedSkills=i>0&&displayMessages[i-1].role==='user'?displayMessages[i-1].selectedSkills||[]:[];
            return (
              <Fragment key={`${i}-${msg.role}`}>{msg.taskRunId&&<div className="task-message-label">目标执行 · 第 {taskState?.runs.find(r=>r.id===msg.taskRunId)?.iteration||'—'} 轮</div>}{msg.taskGoalId&&<div className="task-message-label">目标记录</div>}{msg.shareAppend&&<div className="task-message-label share-append-label">来自分享接管 · {msg.shareAppend.source?.model||msg.shareAppend.source?.harness||'外部模型'} · {new Date(msg.shareAppend.at*1000).toLocaleString('zh-CN',{hour12:false})}</div>}{msg.role==='user'&&<div className="chat-turn-anchor" tabIndex={-1} aria-label={`第 ${nodes.find(node=>node.messageIndex===i)?.number||1} 轮对话`} ref={element=>{if(element)turnRefs.current.set(i,element);else turnRefs.current.delete(i);}}/>}<MessageBubble
                key={`${i}-${msg.role}`}
                message={msg}
                artifacts={msg.role === 'assistant' && auditTurn ? <ChatArtifacts artifacts={deliveries.items.filter(item => item.turnId === auditTurn)} onUpdated={deliveries.updated} jobs={deliveries.jobs.filter(item => item.turnId === auditTurn)} onJobsChanged={deliveries.retry} /> : undefined}
                reportMaterial={msg.role === 'assistant' && i > 0 && displayMessages[i - 1].role === 'user' && displayMessages[i - 1].kind === 'breakdown' ? displayMessages[i - 1].content : undefined}
                reportIncomplete={isImported && session.backupIncomplete && isLast}
                sessionId={session.id}
                backupSnapshot={isImported}
                isStreaming={live}
                thinking={live ? stream!.thinking : ''}
                activity={live ? stream!.activity : ''}
                activitySteps={live ? stream!.activitySteps : undefined}
                stillWorking={live ? stream!.stillWorking : ''}
                actions={actions}
                executionScope={`${session.id}:${auditTurn||''}`}
                execution={!msg.externalSource && !isImported && msg.role === 'assistant' && auditTurn ? onProgressOwnership => session.engine === 'codex' ? <CodexRunPanel key={auditTurn} sessionId={session.id} turnId={auditTurn} streaming={live} onProgressOwnership={onProgressOwnership}/> : <ChatExecutionPanel key={auditTurn} sessionId={session.id} turnId={auditTurn} streaming={live} onProgressOwnership={onProgressOwnership} onOpen={onOpenAudit ? () => onOpenAudit(auditTurn) : undefined} /> : undefined}
                status={!msg.externalSource && session.engine !== 'codex'&&!isImported&&msg.role==='assistant'&&(auditTurn||auditRecord)?<ChatSkillEvidence key={auditTurn} sessionId={session.id} turnId={auditTurn!} record={auditRecord} selectedSkills={selectedSkills} streaming={live} error={live?skillAudits.error:undefined} onOpen={auditTurn&&onOpenAudit?()=>onOpenAudit(auditTurn):undefined}/>:undefined}
              /></Fragment>
            );
          })}
          {isStreaming && (stream!.questions?.length ?? 0) > 0 && (
            <QuestionCards questions={stream!.questions || []} onDone={(qid) => onQuestionAnswered?.(qid)} />
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>{nodes.length>3&&<ChatTurnNavigation key={session.id} nodes={nodes} current={currentTurn} following={following} onJump={jumpTo} onLatest={goLatest}/>}</div>

      {(!isImported || !following) && <div className="chat-input-area">{!following&&<button type="button" className={`chat-return-latest${isStreaming ? ' is-running' : ''}`} aria-label={isStreaming?'返回最新进度':'回到最新一轮'} onClick={goLatest}>{isStreaming && <span className="chat-latest-dots" aria-hidden="true"><i/><i/><i/></span>}<svg className="chat-latest-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 4v16m-6-6 6 6 6-6"/></svg></button>}
        {!isImported && <div className="chat-input-inner">
          {(stopping || stopError) && <div className="chat-stop-notice" role={stopError ? 'alert' : 'status'}>
            <p>{stopping ? '正在请求停止，等待后端确认…' : stopError}</p>
            <div>{stopError && isStreaming && <button type="button" className="btn btn-sm" disabled={stopping} onClick={onStop}>重试停止</button>}
              {onNewChat && <button type="button" className="btn btn-sm" onClick={onNewChat}>保留记录并新建对话</button>}</div>
          </div>}
          <ChatComposer key={session.id} usageRefreshKey={session.messages.length} sessionId={session.id} engine={session.engine} engineLocked={Boolean(session.messages.length || session.pendingTurnId || deliveries.items.length || deliveries.messages.length || deliveries.jobs.length)} onEngineChange={onEngineChange} compaction={session.importedFromBackup ? undefined : stream?.compaction} isStreaming={isStreaming} stopping={stopping} onSend={onSend} onStop={onStop} onSteer={onSteer} onOpenModels={onOpenModels} onGoal={openGoal} goalEditor={goalEditor} onGoalClose={closeGoalEditor} onGoalChanged={()=>onTaskChange?.()} goalBusy={taskLive} goalActive={goalActive} goalStatus={goal?.status} onGoalAction={runGoalAction} onGoalView={viewGoal} onScheduleDraft={onScheduleDraft} onSideChat={openSidePanel} />
        </div>}
      </div>}
    </div>
  );
}

/** 辅助对话线程：父会话的子会话，独立记录，不打断主对话。 */
function SideChatThread({ session, onSend, onStop, onQuoteFromMain, onQuoteToMain }: {
  session: ChatSession; onSend?: (text: string) => void; onStop?: () => void; onQuoteFromMain?: () => void; onQuoteToMain?: () => void;
}) {
  const [draft, setDraft] = useState(() => getChatDraft(session.id));
  useEffect(() => {
    const refresh = () => setDraft(getChatDraft(session.id));
    refresh();
    return subscribeChatDraft(session.id, refresh);
  }, [session.id]);
  const setText = (value: string) => { setChatDraftText(session.id, value); setDraft(getChatDraft(session.id)); };
  const busy = Boolean(session.pendingTurnId);
  const lastAssistant = [...session.messages].reverse().find(message => message.role === 'assistant' && (message.content || '').trim());
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.text.trim();
    if (!text || busy || !onSend) return;
    const quotes = draft.quotes || [];
    onSend(quotes.length ? ['引用：', ...quotes, '', text].join('\n') : text);
    setText('');
    quotes.forEach(() => removeChatDraftQuote(session.id, 0));
  };
  return <div className="side-chat">
    <p className="side-chat-note">向这里提问不会进入主对话；需要时把结论引用回主对话。</p>
    <div className="side-chat-thread" role="log" aria-label="辅助对话消息">
      {!session.messages.length && !busy && <p className="side-chat-empty">还没有消息。可以问一个旁支问题，或先把主对话的上一轮引用进来。</p>}
      {session.messages.map((message, index) => <MessageBubble key={message.turnId || `${index}-${message.role}`} message={message} />)}
      {busy && <p className="side-chat-running" role="status">正在生成…{onStop && <button type="button" className="link-btn" onClick={onStop}>停止</button>}</p>}
    </div>
    <div className="side-chat-actions">
      <button type="button" className="link-btn" disabled={!onQuoteFromMain} onClick={onQuoteFromMain}>引用主对话上一轮</button>
      <button type="button" className="link-btn" disabled={!lastAssistant || !onQuoteToMain} onClick={onQuoteToMain}>引用到主对话</button>
    </div>
    <form className="side-chat-composer" onSubmit={submit}>
      {(draft.quotes || []).length > 0 && <ul className="side-chat-quotes">{(draft.quotes || []).map((quote, index) => <li key={index}><span>{quote.length > 90 ? `${quote.slice(0, 90)}…` : quote}</span><button type="button" aria-label="移除引用" onClick={() => { removeChatDraftQuote(session.id, index); setDraft(getChatDraft(session.id)); }}>×</button></li>)}</ul>}
      <textarea value={draft.text} rows={2} maxLength={4000} placeholder="问一个旁支问题…（Enter 发送，Shift+Enter 换行）" aria-label="辅助对话输入"
        onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(event); } }}/>
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !draft.text.trim()}>发送</button>
    </form>
  </div>;
}
