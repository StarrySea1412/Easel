import { ChatRunProvider } from './ChatRunContext';
import ChatProgressCapsule from './ChatProgressCapsule';
import ChatAgentActivity from './ChatAgentActivity';
import {historicalGatewayAuthError} from '../lib/chatErrors';
import ChatTurnNavigation from './ChatTurnNavigation';
import { chatTurnNodes,activeTurnFromOffsets,isChatAtBottom,shouldFollowChatScroll } from '../lib/chatNavigation';
import '../styles/chat-navigation.css';
import { Fragment, useRef, useEffect, useLayoutEffect, useMemo, useState, useCallback } from 'react';
import ChatSkillEvidence from './ChatSkillEvidence';
import { useChatSkillAudits } from '../hooks/useChatSkillAudits';
import MessageBubble, { type BubbleActions } from './MessageBubble';
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
import { addChatDraftQuote, setChatDraftText } from '../lib/chatDrafts';
import type { MessageSettingsActions } from './ChatMessageSettings';
import '../styles/chat-workspace.css';
import { readLocalValue, writeLocalValue } from '../lib/localPersistence';
import ChatPanelHome from './ChatPanelHome';
import ChatAnalysisPanel from './ChatAnalysisPanel';
import CreationWorkspaceSlot from './CreationWorkspaceSlot';
import { requestCreationPanel, takeCreationPanel } from '../lib/creationWorkspace';
import ChatBrowserPanel from './ChatBrowserPanel';
import ChatSourcesPanel from './ChatSourcesPanel';
import ChatPanelIcon from './ChatPanelIcon';
import SessionPurposeIcon from './SessionPurposeIcon';
import { sessionPurpose } from '../lib/sessionPurpose';
import { ChatPanelFiles, ChatPanelExecution } from './ChatPanelTools';
import PanelMaterialQuote from './PanelMaterialQuote';
import { loadPanelTools, savePanelTools, PANEL_LABELS, type PanelTool } from '../lib/chatPanels';
import '../styles/chat-side-panel.css';
import { readSelectedSkills, readSkillRequirements } from '../lib/selectedSkills';
import type { SkillRequirements } from '../lib/selectedSkills';
import type { ChatSession, ChatMessage, StreamState } from '../lib/store';
import type { UploadedFile, ThinkingLevel } from '../lib/api';
import { loadComposerModel } from '../lib/composerModel';
import { markSessionSeen } from '../lib/seenStatus';
import { computeSideOrder } from '../lib/sideChat';
import { loadThinkingLevel, resolveThinkingPreference } from '../lib/thinkingLevel';
import { fetchOfficeTaskModels } from '../lib/officeControls';

interface ChatPageProps {
  taskState?:TaskSnapshot;
  onTaskChange?:()=>void;
  onOpenTask?:(id:string)=>void;
  onEngineChange?: (engine:'openclaw'|'codex') => void;
  session: ChatSession;
  stream?: StreamState;          // 进行中的流式态（来自 App，切页也不丢）
  stopping?: boolean;
  stopError?: string;
  onSend: (displayText: string, attachments?: UploadedFile[], selectedSkills?: string[], skillRequirements?: SkillRequirements, thinkingLevel?: ThinkingLevel, modelRef?: string) => boolean;
  onStop: () => void;
  onEdit?: (userIndex: number, text: string, signal: AbortSignal) => Promise<boolean>;
  onOpenSource?: (sessionId: string) => void;
  onOpenAnalysis?: () => void;
  onWriteFromAnalysis?: () => Promise<void>;
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
  sideSessions?: ChatSession[];                         // 辅助对话（父会话的子会话，可有多个），只在侧边面板里展示
  closedSideSessions?: ChatSession[];
  onSideReopen?: (childId: string) => boolean;
  sideStreams?: Record<string, StreamState>;
  sideStoppingSessions?: Record<string, boolean>;
  sideStopErrors?: Record<string, string>;
  onSideQuestionAnswered?: (childId: string, questionId: string) => void;
  onSideSteer?: (childId: string, messageId: string) => Promise<boolean>;
  onSideChat?: (mode?: 'open' | 'create') => string | undefined; // 打开侧边面板：open=复用最近/没有则新建；create=总是新建。返回要激活的子会话 id
  onSideSend?: (childId: string, displayText: string, attachments?: UploadedFile[], selectedSkills?: string[], skillRequirements?: SkillRequirements, thinkingLevel?: ThinkingLevel, modelRef?: string) => boolean;
  onSideStop?: (childId: string) => void;               // 停止指定辅助对话的生成
  onQuoteFromMain?: (childId: string) => void;          // 主对话上一轮 → 该辅助对话草稿引用
  onQuoteToMain?: (childId: string) => void;            // 该辅助对话最后答复 → 主对话草稿引用
  onSideClose?: (childId: string) => void;              // 关闭标签并保留记录与后台任务
  onSideRename?: (childId: string, title: string) => void; // 重命名指定辅助对话的标签
  onSideReorder?: (orderedIds: string[]) => void;       // 拖拽/键盘调整后的辅助对话标签顺序
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

function ChatPageContent({ session, stream, stopping = false, stopError, onEngineChange, onSend, onStop, onEdit, onOpenSource, onOpenAnalysis, onWriteFromAnalysis, onSteer, onResend, onQuestionAnswered, onOpenAudit, onNewChat, onOpenModels, taskState,onTaskChange,onOpenTask,onScheduleDraft, sideSessions = [], closedSideSessions = [], onSideReopen, sideStreams = {}, sideStoppingSessions = {}, sideStopErrors = {}, onSideQuestionAnswered, onSideSteer, onSideChat, onSideSend, onSideStop, onQuoteFromMain, onQuoteToMain, onSideClose, onSideRename, onSideReorder, onShare, onLoadShare }: ChatPageProps) {
  const sessionGoals=taskState?.goals.filter(g=>g.sessionId===session.id)||[];
  const goal=sessionGoals.find(g=>!['completed','cancelled'].includes(g.status))||sessionGoals[0];
  const taskRuns=taskState?.runs.filter(r=>r.goalId===goal?.id)||[];
  const taskLive=taskRuns.some(r=>['queued','running','unconfirmed'].includes(r.state));
  const taskBusy=goal?.status==='active'||taskLive;
  const goalActive=goal?.status==='active';
  const [panelOpen,setPanelOpen]=useState(true);
  const [goalEditor,setGoalEditor]=useState<{seed?:string;modelRef?:string;onConfigured?:()=>void;goal?:TaskGoal;welcome?:boolean}|null>(null);
  const [panelTab,setPanelTab]=useState<'goal'|'side'|'new'|PanelTool>(session.analysisContext?'analysis':'goal');
  const [toolTabs,setToolTabs]=useState<Record<string,PanelTool[]>>({});
  const openedTools=useMemo(()=>toolTabs[session.id]||[...new Set([...loadPanelTools(session.id),...(session.analysisContext?['analysis' as const]:[])])],[toolTabs,session.id,session.analysisContext]);
  const [selectedFileId,setSelectedFileId]=useState<string|undefined>();
  const [browserIcon,setBrowserIcon]=useState<{sessionId:string;source:string}|null>(null);
  const onBrowserIcon=useCallback((source:string)=>setBrowserIcon(previous=>previous?.sessionId===session.id&&previous.source===source?previous:{sessionId:session.id,source}),[session.id]);
  const updateTools=(tools:PanelTool[])=>{setToolTabs(previous=>({...previous,[session.id]:tools}));savePanelTools(session.id,tools);};
  const openTool=(tool:PanelTool)=>{if(!openedTools.includes(tool))updateTools([...openedTools,tool]);setPanelTab(tool);setPanelOpen(true);};
  const closeTool=(tool:PanelTool)=>{updateTools(openedTools.filter(item=>item!==tool));if(panelTab===tool)setPanelTab('new');};
  const openNewPanel=()=>{setPanelTab('new');setPanelOpen(true);};
  // 辅助对话多实例：activeSideId=当前标签；未指定时回退到最近创建的一个。
  const [activeSideId,setActiveSideId]=useState<string|null>(null);
  const [sideRenameId,setSideRenameId]=useState<string|null>(null);
  const [dragSideId,setDragSideId]=useState<string|null>(null);
  const [sideDrop,setSideDrop]=useState<{id:string;after:boolean}|null>(null);
  // 拖拽/键盘平移标签：把某标签移到目标之前/之后，顺序交由调用方持久化。
  const applySideOrder=(draggedId:string,targetId:string,after:boolean)=>{
    const ids=sideSessions.map(item=>item.id);
    const next=computeSideOrder(ids,draggedId,targetId,after);
    if(next.join('|')!==ids.join('|'))onSideReorder?.(next);
  };
  const moveSideChat=(sideId:string,offset:number)=>{
    const ids=sideSessions.map(item=>item.id);
    const to=ids.indexOf(sideId)+offset;
    if(to<0||to>=ids.length)return;
    applySideOrder(sideId,ids[to],offset>0);
  };
  const activeSide=sideSessions.find(item=>item.id===activeSideId)||sideSessions.at(-1);
  useEffect(()=>{setPanelOpen(true);setPanelTab(session.analysisContext?'analysis':'goal');setActiveSideId(null);setSelectedFileId(undefined);setGoalEditor(null);},[session.id,session.analysisContext]);
  // 无目标时面板默认落在辅助对话标签上（有目标时保持“目标”优先的既有行为）。
  useEffect(()=>{
    if(panelTab==='goal'&&!goal){if(session.analysisContext)setPanelTab('analysis');else if(sideSessions.length)setPanelTab('side');else if(openedTools.length)setPanelTab('new');}
    if(panelTab==='side'&&!sideSessions.length)setPanelTab(openedTools[0] || 'new');
  },[panelTab,goal,sideSessions.length,openedTools.length,session.analysisContext]);
  const PANEL_WIDTH_KEY='easel:chat-panel-width';
  const [panelWidth,setPanelWidth]=useState(()=>{const {ok,value}=readLocalValue(PANEL_WIDTH_KEY);const n=value?Number(value):NaN;return ok&&Number.isFinite(n)&&n>=280&&n<=720?n:480;});
  const panelWidthRef=useRef(panelWidth);panelWidthRef.current=panelWidth;
  const startPanelResize=(event:React.PointerEvent)=>{event.preventDefault();const startX=event.clientX,startW=panelWidthRef.current;
    const move=(moveEvent:PointerEvent)=>setPanelWidth(Math.max(280,Math.min(720,startW-(moveEvent.clientX-startX))));
    const finish=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);writeLocalValue(PANEL_WIDTH_KEY,String(Math.round(panelWidthRef.current)));};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);};
  const openSidePanel=()=>{setPanelTab('side');setPanelOpen(true);const id=onSideChat?.();if(id)setActiveSideId(id);};
  // 正在查看＝已读：会话终态角标（失败/已停止/已完成）在看过后不再保留（见 lib/seenStatus）；
  // deps 含最后一条消息的 turnId，同长度的重试替换也能被计为已读。
  useEffect(()=>{
    if(!session.importedFromBackup) markSessionSeen(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[session.id,session.messages.length,session.messages.at(-1)?.turnId]);
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
  const editableGoal = goal && !['completed','cancelled'].includes(goal.status) ? goal : undefined;
  const messageSettings: MessageSettingsActions = {
    creation: (text, kind) => { requestCreationPanel(kind, session.id, text); openTool(kind); },
    targets: [...sideSessions.map(side => ({ value: side.id, label: `侧边对话 · ${side.title}` })), ...(onSideChat ? [{ value: 'new-side', label: '新建侧边对话' }] : [])],
    hasGoal: Boolean(editableGoal),
    goalBlocked: taskBusy || Boolean(stream || stopping || session.pendingTurnId) || session.engine === 'codex',
    quote: (text, target) => {
      const id = target === 'current' ? session.id : target === 'new-side' ? onSideChat?.('create') : sideSessions.find(side => side.id === target)?.id;
      if (!id) { showToast('目标对话不可用，请重新选择。', 'error'); return; }
      addChatDraftQuote(id, `来自「${session.title}」：\n${text}`);
      if (id !== session.id) { setPanelTab('side'); setPanelOpen(true); setActiveSideId(id); }
    },
    goal: (text, mode) => {
      if (taskBusy || stream || stopping || session.pendingTurnId) { showToast('请先暂停并等待当前执行结束。', 'info'); return; }
      const seed = mode === 'append' && editableGoal ? `${editableGoal.objective}\n\n${text}` : text;
      openGoal(seed);
    },
  };
  const panelVisible=panelOpen&&!goalEditor&&!session.importedFromBackup&&Boolean(goal||sideSessions.length||openedTools.length||panelTab==='new'||panelTab==='side');
  const withGoal=(content:React.ReactNode)=><div data-creation-session={session.id} className={`chat-goal-workspace${panelVisible&&panelTab==='goal'&&goal?' has-goal-panel':''}${panelVisible&&(panelTab==='new'||openedTools.includes(panelTab as PanelTool)||panelTab==='side'&&activeSide)?' has-side-panel':''}`}>
    {content}
    {panelVisible&&<aside className="chat-side-panel" style={{width:panelWidth}} aria-label="对话侧边面板">
      <header className="chat-side-panel-head">
        <div className="chat-side-panel-tabs" role="tablist" aria-label="侧边面板" onKeyDown={event=>{if(event.altKey||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const tabs=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];const index=tabs.indexOf(event.target as HTMLButtonElement);if(index<0)return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].focus();tabs[next].click();}}>
          {panelTab==='new'&&<button type="button" role="tab" aria-selected className="chat-panel-launcher-tab" onClick={openNewPanel}><ChatPanelIcon kind="new"/>新增面板</button>}
          {openedTools.map(tool=><span key={tool} className="chat-side-tab-wrap"><button type="button" role="tab" aria-selected={panelTab===tool} className={'chat-side-tab'+(panelTab===tool?' is-on':'')} onClick={()=>setPanelTab(tool)}><ChatPanelIcon kind={tool} source={tool==='browser'&&browserIcon?.sessionId===session.id?browserIcon.source:undefined}/>{PANEL_LABELS[tool]}</button><button type="button" className="chat-side-tab-close" aria-label={`关闭：${PANEL_LABELS[tool]}`} onClick={()=>closeTool(tool)}>×</button></span>)}
          {sideSessions.map(side=>{
            const on=panelTab==='side'&&activeSide?.id===side.id;
            const drop=sideDrop?.id===side.id?(sideDrop.after?' is-drop-after':' is-drop-before'):'';
            return <span key={side.id} className={'chat-side-tab-wrap'+(on?' is-on':'')+drop}
              onDragOver={event=>{ if(!dragSideId||dragSideId===side.id)return; event.preventDefault(); const rect=event.currentTarget.getBoundingClientRect(); setSideDrop({id:side.id,after:event.clientX>rect.left+rect.width/2}); }}
              onDragLeave={event=>{ if(sideDrop?.id===side.id&&!event.currentTarget.contains(event.relatedTarget as Node|null))setSideDrop(null); }}
              onDrop={event=>{ if(!dragSideId)return; event.preventDefault(); const rect=event.currentTarget.getBoundingClientRect(); const after=event.clientX>rect.left+rect.width/2; const dragged=dragSideId; setDragSideId(null); setSideDrop(null); applySideOrder(dragged,side.id,after); }}>
              {sideRenameId===side.id
                ? <input className="chat-side-tab-rename" defaultValue={side.title} autoFocus aria-label={'重命名：'+side.title}
                    onBlur={()=>setSideRenameId(null)}
                    onKeyDown={event=>{
                      if(event.key==='Enter'){event.preventDefault();const title=event.currentTarget.value.trim();setSideRenameId(null);if(title&&title!==side.title)onSideRename?.(side.id,title);}
                      if(event.key==='Escape'){event.preventDefault();setSideRenameId(null);}
                    }}/>
                : <button type="button" role="tab" aria-selected={on} className={'chat-side-tab'+(on?' is-on':'')+(dragSideId===side.id?' is-dragging':'')} title={`${side.title} · 双击重命名（F2）· 拖拽排序（Alt+←/→）`}
                    draggable
                    onDragStart={event=>{ setDragSideId(side.id); setSideDrop(null); event.dataTransfer.effectAllowed='move'; try{event.dataTransfer.setData('text/easel-side-tab',side.id);}catch{/* 受限环境允许空 dataTransfer */} }}
                    onDragEnd={()=>{ setDragSideId(null); setSideDrop(null); }}
                    onClick={()=>{setPanelTab('side');setActiveSideId(side.id);}}
                    onDoubleClick={()=>setSideRenameId(side.id)}
                    onKeyDown={event=>{
                      if(event.key==='F2'){event.preventDefault();setSideRenameId(side.id);}
                      if(event.altKey&&event.key==='ArrowLeft'){event.preventDefault();moveSideChat(side.id,-1);}
                      if(event.altKey&&event.key==='ArrowRight'){event.preventDefault();moveSideChat(side.id,1);}
                    }}><ChatPanelIcon kind="side"/>{side.title}</button>}
              {onSideClose&&<button type="button" className="chat-side-tab-close" aria-label={'关闭：'+side.title} title="关闭标签并保留记录（后台任务继续）" onClick={()=>onSideClose(side.id)}>×</button>}
            </span>;
          })}
          {goal&&<button type="button" role="tab" aria-selected={panelTab==='goal'} className={'chat-side-tab'+(panelTab==='goal'?' is-on':'')} onClick={()=>setPanelTab('goal')}><ChatPanelIcon kind="goal"/>目标</button>}
          <button type="button" className="chat-side-tab-add" aria-label="新增面板" title="新增面板" onClick={openNewPanel}>＋</button>
        </div>
        <button type="button" className="chat-side-panel-close" aria-label="收起侧边面板" title="收起" onClick={()=>setPanelOpen(false)}>×</button>
      </header>
      {panelTab==='new'?<ChatPanelHome onTool={openTool} onSideChat={()=>{const id=onSideChat?.('create');if(id){setPanelTab('side');setActiveSideId(id);}}} onGoal={viewGoal} hasGoal={Boolean(goal)} artifacts={deliveries.items} onFile={id=>{setSelectedFileId(id);openTool('files');}} closedSessions={closedSideSessions} onReopen={id=>{if(onSideReopen?.(id)){setPanelTab('side');setActiveSideId(id);}}}/>:panelTab==='goal'&&goal
        ? <ChatGoalPanel key={goal.id} goal={goal} runs={taskRuns} onChanged={()=>onTaskChange?.()} onClose={()=>setPanelOpen(false)} onEdit={()=>setGoalEditor({goal:!['completed','cancelled'].includes(goal.status)?goal:undefined,welcome:isEmpty})} onWorkspace={onOpenTask?()=>onOpenTask(goal.id):undefined}/>
        : panelTab==='side'&&activeSide?<SideChatThread key={activeSide.id} session={activeSide} stream={sideStreams[activeSide.id]} stopping={Boolean(sideStoppingSessions[activeSide.id])} stopError={sideStopErrors[activeSide.id]}
            onQuestionAnswered={qid=>onSideQuestionAnswered?.(activeSide.id,qid)} onSteer={onSideSteer?id=>onSideSteer(activeSide.id,id):undefined}
            onSend={(text,attachments,skills,requirements,thinking,model)=>onSideSend?.(activeSide.id,text,attachments,skills,requirements,thinking,model) ?? false}
            onStop={()=>onSideStop?.(activeSide.id)} onOpenModels={onOpenModels}
            messageSettings={{...messageSettings, targets:[{value:session.id,label:'主对话'}, ...messageSettings.targets.filter(target=>target.value!==activeSide.id)], quote:(text,target)=>{if(target==='current')addChatDraftQuote(activeSide.id, `来自「${activeSide.title}」：\n${text}`);else messageSettings.quote(`来自「${activeSide.title}」：\n${text}`,target===session.id?'current':target);}}}
            onQuoteFromMain={()=>onQuoteFromMain?.(activeSide.id)} onQuoteToMain={()=>onQuoteToMain?.(activeSide.id)}/>
        :panelTab==='side'?<div className="chat-side-panel-empty"><p>没有打开的辅助对话。</p><button type="button" className="btn btn-sm" onClick={()=>{const id=onSideChat?.('create');if(id)setActiveSideId(id);}}>新建辅助对话</button><button type="button" className="link-btn" onClick={openNewPanel}>新增其他面板</button></div>:null}
      {openedTools.map(tool=><PanelMaterialQuote key={`${session.id}:${tool}`} sessionId={session.id} tool={tool} hidden={panelTab!==tool}>{tool==='image'||tool==='publish'?<CreationWorkspaceSlot kind={tool} sessionId={session.id} compact active={panelVisible&&panelTab===tool}/>:tool==='analysis'?<ChatAnalysisPanel session={session} onOpenAnalysis={onOpenAnalysis} onWriteFromAnalysis={onWriteFromAnalysis}/>:tool==='browser'?<ChatBrowserPanel sessionId={session.id} active={panelTab==='browser'} onSiteIcon={onBrowserIcon}/>:tool==='sources'?<ChatSourcesPanel session={session} active={panelTab==='sources'} onLocate={turnId=>{
        const messageIndex=session.messages.findIndex(message=>message.turnId===turnId);
        const index=messageIndex>=0?nodes.findLastIndex(node=>node.messageIndex<=messageIndex):turnId===session.pendingTurnId?nodes.length-1:-1;
        if(index<0){showToast('这条来源对应的对话暂不在本地记录中。','info');return;}
        if(window.innerWidth<=900)setPanelOpen(false);
        requestAnimationFrame(()=>jumpTo(index));
      }}/>:tool==='files'?<ChatPanelFiles key={selectedFileId} sessionId={session.id} deliveries={deliveries} selectedId={selectedFileId}/>:<ChatPanelExecution session={session} kind={tool}/>}</PanelMaterialQuote>)}
      <div className="chat-side-panel-resize" role="separator" aria-orientation="vertical" aria-label="调整侧边面板宽度" onPointerDown={startPanelResize}/>
    </aside>}
  </div>;
  const deliveries = useChatArtifacts(session.id, !session.importedFromBackup, Boolean(stream));
  const preparedSignature = deliveries.creationDrafts.map(item=>item.id).join(',');
  const imageSignature = deliveries.jobs.map(item=>item.jobId).join(',');
  useEffect(()=>{
    const openRequested = () => {
      const tool = takeCreationPanel(session.id);
      if (tool) openTool(tool);
    };
    openRequested();
    window.addEventListener('easel:open-creation-panel',openRequested);
    return () => window.removeEventListener('easel:open-creation-panel',openRequested);
  // The listener follows the current tab list without discarding pending navigation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[session.id,openedTools]);
  useEffect(()=>{
    const fresh: ('image'|'publish')[] = [];
    for (const [tool,signature] of [['publish',preparedSignature],['image',imageSignature]] as const) {
      if (!signature) continue;
      const key='easel:creation-panel-seen:'+session.id+':'+tool;
      try { if(sessionStorage.getItem(key)===signature)continue;sessionStorage.setItem(key,signature); } catch { continue; }
      fresh.push(tool);
    }
    if(!fresh.length)return;
    updateTools([...new Set([...openedTools,...fresh])]);
    setPanelTab(fresh.at(-1)!);setPanelOpen(true);
  // Open once per new host task; ordinary poll responses must not steal the selected tab.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[session.id,preparedSignature,imageSignature]);
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
  const [atBottom,setAtBottom]=useState(true);
  const [currentTurn,setCurrentTurn]=useState(0);
  const nodes=useMemo(()=>chatTurnNodes(session.messages, session.importedFromBackup ? '' : stream?.content),[session.messages,session.importedFromBackup,stream?.content]);
  const previousCount=useRef(nodes.length);
  const syncPosition=useCallback(()=>{
    const element=scrollRef.current;if(!element)return;
    const atBottom=isChatAtBottom(element.scrollTop,element.scrollHeight,element.clientHeight);
    setAtBottom(atBottom);
    followLatest.current=shouldFollowChatScroll(followLatest.current,lastScrollTop.current,element.scrollTop,element.scrollHeight,element.clientHeight,navigationTarget.current!==null);
    lastScrollTop.current=element.scrollTop;setFollowing(followLatest.current);
    if(navigationTarget.current!==null){setCurrentTurn(navigationTarget.current);return;}
    const origin=element.getBoundingClientRect().top;
    const offsets=nodes.map(node=>(turnRefs.current.get(node.messageIndex)?.getBoundingClientRect().top??origin)-origin+element.scrollTop);
    setCurrentTurn(Math.max(0,activeTurnFromOffsets(offsets,element.scrollTop,atBottom)));
  },[nodes]);
  const goLatest=()=>{navigationTarget.current=null;followLatest.current=true;setFollowing(true);setAtBottom(true);const element=scrollRef.current;if(element){element.scrollTo({top:element.scrollHeight,behavior:'instant'});lastScrollTop.current=element.scrollTop;}setCurrentTurn(Math.max(0,nodes.length-1));};
  const jumpTo=(index:number)=>{
    if(index<0||index>=nodes.length)return;
    const element=scrollRef.current,anchor=turnRefs.current.get(nodes[index].messageIndex);if(!element||!anchor)return;
    navigationTarget.current=index;followLatest.current=false;setFollowing(false);setCurrentTurn(index);
    element.scrollTo({top:anchor.getBoundingClientRect().top-element.getBoundingClientRect().top+element.scrollTop-22,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    setAtBottom(isChatAtBottom(element.scrollTop,element.scrollHeight,element.clientHeight));
    anchor.focus({preventScroll:true});
  };
  const isImported = session.importedFromBackup === true;
  const isStreaming = !isImported && !!stream;
  const runInProgress = isStreaming || (!isImported && Boolean(session.pendingTurnId));
  const skillAudits=useChatSkillAudits(session.id,isStreaming,session.messages.length,isImported || session.engine === 'codex');
  // Keep the setup mounted when polling adds the goal-created message, so a failed
  // start can retry its saved ID rather than creating the goal a second time.
  const isEmpty = goalEditor?.welcome ?? (session.messages.length === 0 && !runInProgress && !deliveries.items.length && !deliveries.jobs.length && !deliveries.messages.length);
  const header = <header className="chat-header">
    <div className="chat-header-context"><SessionPurposeIcon session={session}/><span>{session.analysisContext?.kind==='account-analysis'||session.conversationType==='account-analysis'?'账号分析':session.analysisContext?.kind==='content-analysis'||session.conversationType==='content-analysis'?'作品分析':sessionPurpose(session).label}</span><span aria-hidden="true">/</span><h2 title={session.title}>{isEmpty&&!session.analysisContext&&!session.writingContext ? '新对话' : session.title}</h2></div>
    <div className="chat-header-actions">
      {session.writingContext && !isImported && onOpenSource && <button type="button" className="chat-new-button" title={`${session.writingContext.platform} · ${session.writingContext.accountId}`} onClick={() => onOpenSource(session.writingContext!.sourceSessionId)}>原分析</button>}
      {!isImported&&onShare&&<button type="button" className="chat-new-button chat-share-trigger" onClick={onShare} title="把完整对话分享给外部模型接管（本地 token）">分享</button>}
      {!isImported&&session.share&&onLoadShare&&<button type="button" className="chat-new-button chat-share-load" onClick={onLoadShare} title={`分享 token：${session.share.token}`}>加载接管内容</button>}
      {!isImported&&!goalEditor&&<button type="button" className="chat-new-button chat-side-trigger" onClick={openNewPanel} aria-expanded={panelVisible} aria-label="新增面板"><IconLayout size={16}/> 新增面板</button>}
      {!isImported&&!goalEditor&&<ChatProgressCapsule goal={goal} activity={stream?.activity||session.messages.at(-1)?.activity} startedAt={stream?.startedAt||session.messages.at(-1)?.startedAt} elapsedMs={!isStreaming?session.messages.at(-1)?.elapsedMs:undefined} failed={Boolean(session.messages.at(-1)?.error)&&!isStreaming} stopped={session.messages.at(-1)?.stopped&&!isStreaming} onGoal={viewGoal}/>}
      {isImported ? <span className="chat-header-status">只读备份</span> : isStreaming && <span className="chat-header-status" role="status">{stopping ? '正在停止' : '进行中'}</span>}
      {!isEmpty && onNewChat && <button type="button" className="chat-new-button" onClick={onNewChat} title="新建对话" aria-label="新建对话"><IconPlus size={16} /><span>新对话</span></button>}
    </div>
  </header>;

  useLayoutEffect(()=>{
    if(nodes.length>previousCount.current){navigationTarget.current=null;followLatest.current=true;}
    previousCount.current=nodes.length;
    const element=scrollRef.current;
    if(!isEmpty&&followLatest.current){if(element){element.scrollTop=element.scrollHeight;lastScrollTop.current=element.scrollTop;}setFollowing(true);setCurrentTurn(Math.max(0,nodes.length-1));}
    if(element)setAtBottom(isChatAtBottom(element.scrollTop,element.scrollHeight,element.clientHeight));
  },[session.messages,stream?.content,stream?.thinking,stream?.activity,stream?.stillWorking,isEmpty,nodes.length]);
  useEffect(()=>{
    const thread=messagesEndRef.current?.parentElement,element=scrollRef.current;if(!thread||!element||typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(()=>{
      if(followLatest.current){element.scrollTop=element.scrollHeight;lastScrollTop.current=element.scrollTop;}
      syncPosition();
    });
    observer.observe(thread);observer.observe(element);return()=>observer.disconnect();
  },[isEmpty,syncPosition]);

  // ---- 空态：居中欢迎页 ----
  if (isEmpty && !isImported) {
    return withGoal(
      <div className="chat-page chat-welcome-page">
        {header}
        <div className="chat-hero">
          <h1 className="chat-hero-title">{session.analysisContext ? session.analysisContext.kind === 'content-analysis' ? '从作品中，找到下一步' : '看清账号的内容方向' : greeting()}</h1>
          <p className="chat-hero-sub">{session.analysisContext ? '材料已就绪，选择分析重点或补充你的问题。' : '从一个想法开始，一起把内容做好。'}</p>
          <ChatComposer key={session.id} analysisContext={session.analysisContext} onOpenAnalysisMaterial={()=>{setPanelOpen(true);setPanelTab('analysis');}} usageRefreshKey={session.messages.length} sessionId={session.id} engine={session.engine} engineLocked={Boolean(session.writingContext || session.messages.length || session.pendingTurnId || deliveries.items.length || deliveries.messages.length || deliveries.jobs.length)} onEngineChange={onEngineChange} compaction={session.importedFromBackup ? undefined : stream?.compaction} onGoal={openGoal} goalEditor={goalEditor} onGoalClose={closeGoalEditor} onGoalChanged={()=>onTaskChange?.()} goalBusy={taskLive} goalActive={goalActive} goalStatus={goal?.status} onGoalAction={runGoalAction} onGoalView={viewGoal} onScheduleDraft={onScheduleDraft} onSideChat={openSidePanel} hero isStreaming={isStreaming} stopping={stopping} onSend={onSend} onStop={onStop} onOpenModels={onOpenModels} />
          {!goalEditor&&session.analysisContext&&<div className="chat-analysis-suggestions" aria-label="分析重点">
            {[['内容方向','根据这些作品，分析内容主题、目标受众和值得继续的方向，逐项引用证据。'],['逐篇分析','逐篇分析这些作品的内容结构、表达和表现，列出具体可修改之处；缺少材料时说明需要补什么。'],['下一篇选题','基于已有作品提出下一篇选题与创作方案，说明各自依据和需要验证的假设。']].map(([label,text])=><button key={label} type="button" className="btn btn-sm" onClick={()=>setChatDraftText(session.id,text)}><IconEdit size={14}/>{label}</button>)}
          </div>}
          {!goalEditor&&!session.analysisContext&&<div className="suggestions">
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
      {!isImported && <ChatQuoteToolbar key={session.id} sessionId={session.id} root={scrollRef} actions={messageSettings}/>}<div className="chat-conversation-body"><div className="chat-messages" ref={scrollRef} onScroll={syncPosition}
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
            let actions: BubbleActions | undefined;
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
            if (actions && !isImported && !live && msg.content.trim()) actions.messageSettings = { text: msg.content, actions: messageSettings };
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
                execution={!msg.externalSource && !isImported && msg.role === 'assistant' && auditTurn ? onProgressOwnership => <><ChatAgentActivity sessionId={session.id} turnId={auditTurn}/>{session.engine === 'codex' ? <CodexRunPanel key={auditTurn} sessionId={session.id} turnId={auditTurn} streaming={live} onProgressOwnership={onProgressOwnership}/> : <ChatExecutionPanel key={auditTurn} sessionId={session.id} turnId={auditTurn} streaming={live} onProgressOwnership={onProgressOwnership} onOpen={onOpenAudit ? () => onOpenAudit(auditTurn) : undefined} />}</> : undefined}
                status={!msg.externalSource && session.engine !== 'codex'&&!isImported&&msg.role==='assistant'&&(auditTurn||auditRecord)?<ChatSkillEvidence key={auditTurn} sessionId={session.id} turnId={auditTurn!} record={auditRecord} selectedSkills={selectedSkills} streaming={live} error={live?skillAudits.error:undefined} onOpen={auditTurn&&onOpenAudit?()=>onOpenAudit(auditTurn):undefined}/>:undefined}
              /></Fragment>
            );
          })}
          {isStreaming && (stream!.questions?.length ?? 0) > 0 && (
            <QuestionCards questions={stream!.questions || []} onDone={(qid) => onQuestionAnswered?.(qid)} />
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>{nodes.length>3&&<ChatTurnNavigation key={session.id} nodes={nodes} current={currentTurn} following={following} onJump={jumpTo} onLatest={goLatest}/>}
        {!atBottom && <button type="button" className={`chat-return-latest${runInProgress ? ' is-running' : ''}`} aria-label={runInProgress?'返回最新进度':'回到最新一轮'} title={runInProgress?'返回最新进度':'回到最新一轮'} onClick={goLatest}>{runInProgress && <span className="chat-latest-dots" aria-hidden="true"><i/><i/><i/></span>}<svg className="chat-latest-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 4v16m-6-6 6 6 6-6"/></svg></button>}
      </div>

      {!isImported && <div className="chat-input-area">
        {!isImported && <div className="chat-input-inner">
          {(stopping || stopError) && <div className="chat-stop-notice" role={stopError ? 'alert' : 'status'}>
            <p>{stopping ? '正在请求停止，等待后端确认…' : stopError}</p>
            <div>{stopError && isStreaming && <button type="button" className="btn btn-sm" disabled={stopping} onClick={onStop}>重试停止</button>}
              {onNewChat && <button type="button" className="btn btn-sm" onClick={onNewChat}>保留记录并新建对话</button>}</div>
          </div>}
          <ChatComposer key={session.id} analysisContext={session.analysisContext} onOpenAnalysisMaterial={()=>{setPanelOpen(true);setPanelTab('analysis');}} usageRefreshKey={session.messages.length} sessionId={session.id} engine={session.engine} engineLocked={Boolean(session.writingContext || session.messages.length || session.pendingTurnId || deliveries.items.length || deliveries.messages.length || deliveries.jobs.length)} onEngineChange={onEngineChange} compaction={session.importedFromBackup ? undefined : stream?.compaction} isStreaming={isStreaming} stopping={stopping} onSend={onSend} onStop={onStop} onSteer={onSteer} onOpenModels={onOpenModels} onGoal={openGoal} goalEditor={goalEditor} onGoalClose={closeGoalEditor} onGoalChanged={()=>onTaskChange?.()} goalBusy={taskLive} goalActive={goalActive} goalStatus={goal?.status} onGoalAction={runGoalAction} onGoalView={viewGoal} onScheduleDraft={onScheduleDraft} onSideChat={openSidePanel} />
        </div>}
      </div>}
    </div>
  );
}

/** 辅助对话线程：父会话的子会话，独立记录，不打断主对话。 */
function SideChatThread({ session, stream, stopping, stopError, onQuestionAnswered, onSteer, onSend, onStop, onOpenModels, onQuoteFromMain, onQuoteToMain, messageSettings }: {
  session: ChatSession; stream?: StreamState; stopping: boolean; stopError?: string;
  onQuestionAnswered?: ChatPageProps['onQuestionAnswered']; onSteer?: ChatPageProps['onSteer'];
  onSend: ChatPageProps['onSend']; onStop?: () => void; onOpenModels?: ChatPageProps['onOpenModels'];
  onQuoteFromMain?: () => void; onQuoteToMain?: () => void;
  messageSettings: MessageSettingsActions;
}) {
  const busy = Boolean(stream || session.pendingTurnId);
  const lastAssistant = [...session.messages].reverse().find(message => message.role === 'assistant' && (message.content || '').trim());
  const deliveries = useChatArtifacts(session.id, !session.importedFromBackup, busy);
  const thread = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => { if (follow.current && thread.current) thread.current.scrollTop = thread.current.scrollHeight; }, [session.messages.length, stream?.content, stream?.thinking, stream?.activity, stream?.stillWorking, stream?.questions]);
  return <div className="side-chat">
    <p className="side-chat-note">独立记录与草稿 · {session.engine === 'codex' ? 'Codex' : 'OpenClaw'} · 主对话内容需明确引用</p>
    <div className="side-chat-thread" ref={thread} onScroll={()=>{const el=thread.current;if(el)follow.current=isChatAtBottom(el.scrollTop,el.scrollHeight,el.clientHeight);}} role="log" aria-label="辅助对话消息">
      {!session.messages.length && !busy && <p className="side-chat-empty">还没有消息。可以问一个旁支问题，或先把主对话的上一轮引用进来。</p>}
      {session.messages.map((message, index) => <MessageBubble key={`${index}-${message.role}`} message={message} sessionId={session.id}
        actions={message.content.trim()?{onCopy:()=>navigator.clipboard.writeText(message.content),canModify:!busy,messageSettings:{text:message.content,actions:messageSettings}}:undefined}
        artifacts={message.role==='assistant'&&message.turnId?<ChatArtifacts artifacts={deliveries.items.filter(item=>item.turnId===message.turnId)} jobs={deliveries.jobs.filter(item=>item.turnId===message.turnId)} onUpdated={deliveries.updated} onJobsChanged={deliveries.retry}/>:undefined}/>)}
      {stream && <MessageBubble message={{role:'assistant',content:stream.content}} sessionId={session.id} isStreaming thinking={stream.thinking} activity={stream.activity} activitySteps={stream.activitySteps} stillWorking={stream.stillWorking}
        artifacts={<ChatArtifacts artifacts={deliveries.items.filter(item=>item.turnId===session.pendingTurnId)} jobs={deliveries.jobs.filter(item=>item.turnId===session.pendingTurnId)} onUpdated={deliveries.updated} onJobsChanged={deliveries.retry}/>}
        executionScope={`${session.id}:${session.pendingTurnId||''}`}
        execution={session.pendingTurnId?onProgressOwnership=>session.engine==='codex'?<CodexRunPanel sessionId={session.id} turnId={session.pendingTurnId!} streaming onProgressOwnership={onProgressOwnership}/>:<ChatExecutionPanel sessionId={session.id} turnId={session.pendingTurnId!} streaming onProgressOwnership={onProgressOwnership}/>:undefined}/>}
      {stream&&Boolean(stream.questions?.length)&&<QuestionCards questions={stream.questions||[]} onDone={qid=>onQuestionAnswered?.(qid)}/>}
      {busy && !stream && <p className="side-chat-running" role="status">正在恢复本轮连接…</p>}
      {deliveries.note&&<p role="status">{deliveries.note} <button type="button" className="link-btn" onClick={deliveries.retry}>重新读取产物</button></p>}
    </div>
    <div className="side-chat-composer">
      {(stopping||stopError)&&<div className="chat-stop-notice" role={stopError?'alert':'status'}><p>{stopping?'正在请求停止，等待后端确认…':stopError}</p>{stopError&&busy&&<button type="button" className="btn btn-sm" disabled={stopping} onClick={onStop}>重试停止</button>}</div>}
      <div className="side-chat-actions">
        <button type="button" className="side-chat-action" disabled={!onQuoteFromMain} onClick={onQuoteFromMain}>引用主对话上一轮</button>
        <button type="button" className="side-chat-action" disabled={!lastAssistant || !onQuoteToMain} onClick={onQuoteToMain}>引用到主对话</button>
      </div>
      <ChatComposer sessionId={session.id} engine={session.engine || 'openclaw'} engineLocked isStreaming={busy} stopping={stopping}
        usageRefreshKey={session.messages.length} compaction={stream?.compaction} onSend={onSend} onStop={()=>onStop?.()} onSteer={onSteer} onOpenModels={onOpenModels}/>
    </div>
  </div>;
}

export default function ChatPage(props:ChatPageProps) {
  const {session,stream}=props;
  const turnId=session.pendingTurnId||[...session.messages].reverse().find(message=>message.role==='assistant'&&!message.externalSource&&message.turnId)?.turnId||'';
  return <ChatRunProvider sessionId={session.id} turnId={turnId} engine={session.engine||'openclaw'} streaming={Boolean(stream)} enabled={!session.importedFromBackup}><ChatPageContent key={session.id} {...props}/></ChatRunProvider>;
}
