import { ThinkingLevelPicker } from './ThinkingLevelPicker';
import ChatCompactionIndicator from './ChatCompactionIndicator';
import ChatContextUsage from './ChatContextUsage';
import type { SkillRequirements } from '../lib/selectedSkills';
import { useState, useRef, useEffect, useId, useLayoutEffect, useCallback, useMemo, useSyncExternalStore } from 'react';
import { getChatDraft, subscribeChatDraft, setChatDraftText, removeChatDraftAttachment,
  dismissMissingDraftAttachments, setChatDraftError, beginChatDraftUpload,
  appendChatDraftUploads, finishChatDraftUpload, clearChatDraft } from '../lib/chatDrafts';
import { useComposerSkills } from '../hooks/useComposerSkills';
import { ComposerSkillChips, ComposerSkillPicker } from './ComposerSkills';
import ComposerModelPicker from './ComposerModelPicker';
import ComposerSkillSuggestions from './ComposerSkillSuggestions';
import { useComposerModels } from '../hooks/useComposerModels';
import { composerModelIssue, isLegacyComposerModelIssue } from '../lib/composerModelIssue';
import { uploadFiles, adoptOversize } from '../lib/api';
import type { UploadedFile, ThinkingLevel } from '../lib/api';
import { IconArrowUp, IconStop, IconOpenClaw, IconTerminal, IconTarget, IconLoader } from './icons';
import ComposerAttachments from './ComposerAttachments';
import ComposerAddMenu, { type ComposerUploadKind } from './ComposerAddMenu';
import GeneratedFilePicker from './GeneratedFilePicker';
import AnalysisComposerMaterial from './AnalysisComposerMaterial';
import { analysisDraftText } from '../lib/analysisComposer';
import type { AnalysisBinding } from '../lib/analysisBinding';
import { loadThinkingLevel, saveThinkingLevel, THINKING_LABELS } from '../lib/thinkingLevel';
import type { ThinkingPreference } from '../lib/thinkingLevel';
import '../styles/chat-composer.css';
import '../styles/thinking-level-picker.css';
import { showToast } from '../lib/toast';
import { CHAT_QUOTE_EVENT, appendQuotedText } from '../lib/chatQuote';
import { addChatDraftQuote } from '../lib/chatDrafts';
import ChatQuoteDraft from './ChatQuoteDraft';
import ChatQueueTray from './ChatQueueTray';
import Select from './ui/Select';
import CodexSettings from './CodexSettings';
import { useCompatibleThinking } from '../hooks/useCompatibleThinking';
import { getChatQueue, subscribeChatQueue, pauseChatQueue, updateQueuedMessage } from '../lib/chatQueue';
import ComposerGoalMenu,{type ComposerCommandItem} from './ComposerGoalMenu';
import {parseComposerCommand,suggestsCommand,type ComposerCommand} from '../lib/goalCommand';
import ChatGoalComposer,{ChatGoalNotice} from './ChatGoalComposer';
import {useChatGoalComposer,type GoalEditor} from '../hooks/useChatGoalComposer';
import '../styles/chat-goal.css';

interface ChatComposerProps {
  analysisContext?: AnalysisBinding;
  onOpenAnalysisMaterial?: () => void;
  goalBusy?:boolean;
  goalActive?:boolean;
  goalStatus?:string;
  onGoal?:(seed?:string,modelRef?:string,onConfigured?:()=>void)=>void;
  onGoalAction?:(action:'pause'|'resume'|'clear')=>void;
  onGoalView?:()=>void;
  onScheduleDraft?:(text:string)=>void;
  onSideChat?:()=>void;                  // 打开侧边栏的辅助对话（父会话的子会话）
  goalEditor?:GoalEditor|null;
  onGoalClose?:()=>void;
  onGoalChanged?:()=>void;
  usageRefreshKey?: number;
  engine?: 'openclaw'|'codex';
  engineLocked?: boolean;
  onEngineChange?: (engine: 'openclaw'|'codex') => void;
  sessionId: string;
  compaction?: import('../lib/chatCompaction').ChatCompaction;
  hero?: boolean;
  isStreaming: boolean;
  stopping?: boolean;
  onSend: (displayText: string, attachments?: UploadedFile[], selectedSkills?: string[], skillRequirements?: SkillRequirements, thinkingLevel?: ThinkingLevel, modelRef?: string) => boolean;
  onStop: () => void;
  onSteer?: (id: string) => Promise<boolean>;
  onOpenModels?: (modelRef?: string) => void;
}


/** Shared multiline composer for the welcome and conversation views. */
export default function ChatComposer(props: ChatComposerProps) {
  return <SessionChatComposer key={props.sessionId} {...props} />;
}

function SessionChatComposer({ sessionId, analysisContext, onOpenAnalysisMaterial, usageRefreshKey = 0, engine = 'openclaw', engineLocked = false, onEngineChange, compaction, hero = false, isStreaming, stopping = false, onSend, onStop, onSteer, onOpenModels, goalBusy=false, goalActive=false, goalStatus, onGoal, onGoalAction, onGoalView, onScheduleDraft, onSideChat, goalEditor, onGoalClose, onGoalChanged }: ChatComposerProps) {
  const draft = useSyncExternalStore(
    useCallback(listener => subscribeChatDraft(sessionId, listener), [sessionId]),
    useCallback(() => getChatDraft(sessionId), [sessionId]),
  );
  const queue = useSyncExternalStore(subscribeChatQueue, () => getChatQueue(sessionId));
  const [queueEdit, setQueueEdit] = useState<{ id: string; text: string } | null>(null);
  const editingItem = queue.items.find(item => item.id === queueEdit?.id);
  const editingQueue = Boolean(editingItem);
  const { attachments, uploading, error: uploadError } = draft;
  const input = editingQueue ? queueEdit!.text : analysisDraftText(draft.text, analysisContext);
  const setInput = (value: string | ((current: string) => string)) => {
    if (editingQueue) setQueueEdit(current => current ? { ...current, text: typeof value === 'function' ? value(current.text) : value } : null);
    else setChatDraftText(sessionId, typeof value === 'function' ? value(input) : value);
  };
  const editQueued = (id: string, text: string) => {
    if(goalEditor){if(goalState.busy)return;onGoalClose?.();}
    if (queueEdit?.id === id) { textareaRef.current?.focus(); return; }
    if (editingQueue && !updateQueuedMessage(sessionId, queueEdit!.id, queueEdit!.text)) {
      setChatDraftError(sessionId, '当前修改未保存，请先保存或取消。'); return;
    }
    pauseChatQueue(sessionId); setQueueEdit({ id, text });
  };
  useEffect(() => { if (editingQueue) textareaRef.current?.focus(); }, [editingQueue, queueEdit?.id]);
  const [dragOver, setDragOver] = useState(false);
  const [preferredThinking, setThinkingLevel] = useState<ThinkingPreference>(() => loadThinkingLevel());
  const [maxMb, setMaxMb] = useState(50);
  const skills = useComposerSkills(sessionId);
  const models = useComposerModels(sessionId, engine);
  const runtime = engine === 'codex' ? 'codex' : models.capability?.runtime || 'openclaw';
  const alternate = engine !== 'codex' && runtime !== 'openclaw';
  const chatOnly = runtime === 'api';
  const runtimeLabel = ({api:'API 直连',acp:'ACP',opencode:'OpenCode',codex:'Codex（兼容）'} as Record<string,string>)[runtime] || 'OpenClaw';
  const [modelGuardShown, setModelGuardShown] = useState(false);
  const legacyModelError = isLegacyComposerModelIssue(uploadError);
  useEffect(() => {
    if (legacyModelError) {
      setChatDraftError(sessionId, '');
      setModelGuardShown(!models.ready);
    } else if (models.ready) setModelGuardShown(false);
  }, [legacyModelError, models.ready, sessionId]);
  const goalBlocked=Boolean(isStreaming||stopping||goalBusy);
  const goalState=useChatGoalComposer({editor:goalEditor,sessionId,engine:alternate?runtime:engine,
    modelRef:models.modelRef||models.capability?.currentModelRef||models.capability?.defaultModelRef||'',
    blocked:goalBlocked||uploading||draft.missingAttachments.length>0,onChanged:onGoalChanged,onClose:onGoalClose});
  const closeGoal=()=>{if(!goalState.busy){onGoalClose?.();requestAnimationFrame(()=>textareaRef.current?.focus());}};
  const displayedInput=goalEditor?goalState.objective:input;
  const effectiveModel = models.selected || models.options.find(option => option.id === (models.capability?.currentModelRef || models.capability?.defaultModelRef));
  const supportedThinking = effectiveModel?.thinkingLevels;
  const { level: thinkingLevel } = useCompatibleThinking(preferredThinking, supportedThinking, setThinkingLevel);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{if(goalEditor)textareaRef.current?.focus();},[goalEditor]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [outputsOpen, setOutputsOpen] = useState(false);
  const mediaInputRef = useRef<HTMLInputElement>(null), folderInputRef = useRef<HTMLInputElement>(null);
  const [skillPickerRequest, setSkillPickerRequest] = useState(0);
  const composingRef = useRef(false);
  const dragDepthRef = useRef(0);
  const inputId = useId();
  const [dismissedCommand,setDismissedCommand]=useState<string|null>(null);
  const [commandIndex,setCommandIndex]=useState(0);
  const commandItems=useMemo<ComposerCommandItem[]>(()=>{
    const terminal=Boolean(goalStatus&&['completed','cancelled'].includes(goalStatus));
    const items:ComposerCommandItem[]=[{id:'goal',label:'目标',hint:goalStatus&&!terminal?'查看当前目标':'设置要持续追求的目标',keys:'/goal'}];
    if(goalStatus==='active')items.push({id:'goal-pause',label:'暂停目标',hint:'停止自动推进，保留记录与产物',keys:'/goal pause'});
    if(goalStatus&&['draft','paused','blocked'].includes(goalStatus))items.push({id:'goal-resume',label:'继续目标',hint:'从当前记录恢复执行',keys:'/goal resume'});
    if(goalStatus&&!terminal)items.push({id:'goal-clear',label:'清除目标',hint:'结束当前目标并保留历史',keys:'/goal clear'});
    items.push({id:'schedule',label:'定时任务',hint:'按计划重复执行，先到定时任务页确认时间与模型',keys:'/定时'});
    if(onSideChat)items.push({id:'side',label:'辅助对话',hint:'在侧边栏开一个不打断主对话的子对话',keys:'/side'});
    return items;
  },[goalStatus,onSideChat]);
  const commandOpen=Boolean(onGoal&&!goalEditor&&!editingQueue&&suggestsCommand(input)&&dismissedCommand!==input);
  useEffect(()=>{if(commandOpen)setCommandIndex(0);},[commandOpen]);
  const clearCommandDraft=(commandText:string)=>{if(getChatDraft(sessionId).text===commandText){setChatDraftText(sessionId,'');setDismissedCommand(null);}};
  const openGoal=()=>{
    if(!onGoal)return;
    const parsed=parseComposerCommand(input);
    const commandText=input,seed=parsed&&parsed.kind==='set'?parsed.text:'';
    const currentRef=models.modelRef||models.capability?.currentModelRef||models.capability?.defaultModelRef||'';
    setDismissedCommand(input);
    onGoal(seed,currentRef,()=>{if(getChatDraft(sessionId).text===commandText&&parseComposerCommand(commandText)!==null)setChatDraftText(sessionId,'');});
  };
  /** Codex command surface: view, lifecycle and scheduling are local actions. */
  const dispatchCommand=(command:ComposerCommand)=>{
    if(!onGoal)return;
    if(command.kind==='set'){openGoal();return;}
    const commandText=input;setDismissedCommand(commandText);
    if(command.kind==='view'){if(onGoalView)onGoalView();else openGoal();clearCommandDraft(commandText);return;}
    clearCommandDraft(commandText);
    if(command.kind==='lifecycle'){onGoalAction?.(command.action);return;}
    if(onScheduleDraft)onScheduleDraft(command.text);
    else showToast('定时任务入口在当前页面不可用，请从左侧“定时任务”进入。','info');
  };
  const chooseCommandItem=(id:string)=>{
    const parsed=parseComposerCommand(input),commandText=input;
    setDismissedCommand(commandText);
    if(id==='goal'){if(onGoalView)onGoalView();else openGoal();clearCommandDraft(commandText);return;}
    clearCommandDraft(commandText);
    if(id==='side'){onSideChat?.();return;}
    if(id==='goal-pause'){onGoalAction?.('pause');return;}
    if(id==='goal-resume'){onGoalAction?.('resume');return;}
    if(id==='goal-clear'){onGoalAction?.('clear');return;}
    if(id==='schedule'){
      if(onScheduleDraft)onScheduleDraft(parsed?.kind==='schedule'?parsed.text:'');
      else showToast('定时任务入口在当前页面不可用，请从左侧“定时任务”进入。','info');
    }
  };
  useEffect(() => {
    const quote = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; text: string }>).detail;
      if (detail?.sessionId !== sessionId || typeof detail.text !== 'string' || !detail.text.trim()) return;
      if (editingQueue) setQueueEdit(current => current ? { ...current, text: appendQuotedText(current.text, detail.text) } : current);
      else addChatDraftQuote(sessionId, detail.text);
      textareaRef.current?.focus(); showToast('已引用到输入框，可继续编辑；尚未发送。', 'success');
    };
    window.addEventListener(CHAT_QUOTE_EVENT, quote);
    return () => window.removeEventListener(CHAT_QUOTE_EVENT, quote);
  }, [sessionId, editingQueue]);
  const changeThinkingLevel = (value: ThinkingPreference) => {
    setThinkingLevel(value);
    // Persist explicit choices only. StrictMode replays mount effects, which
    // must never replace an unreadable preference with the fallback value.
    const saved = saveThinkingLevel(value);
    showToast(saved ? `已选择思考强度：${THINKING_LABELS[value]}，下一轮生效` : '强度已在本页修改，但未能保存。', saved ? 'success' : 'error');
  };

  useEffect(() => {
    fetch('/api/upload/limits').then((r) => r.ok ? r.json() : null)
      .then((d) => { if (Number.isFinite(d?.max_mb) && d.max_mb > 0) setMaxMb(d.max_mb); }).catch(() => {});
  }, []);

  const doUpload = async (fs: FileList | File[]) => {
    const arr = Array.from(fs);
    if (!arr.length || stopping || editingQueue) return;
    const token = beginChatDraftUpload(sessionId);
    if (!token) return;
    const cap = maxMb * 1024 * 1024;
    const big = arr.filter((f) => f.size > cap);
    const small = arr.filter((f) => f.size <= cap);
    const errors: string[] = [];
    try {
      if (big.length) {
        try {
          const saved = await adoptOversize(big, sessionId);
          appendChatDraftUploads(sessionId, token, saved);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : '大文件添加失败，请重试');
        }
      }
      if (small.length) {
        try {
          const saved = await uploadFiles(small, sessionId);
          appendChatDraftUploads(sessionId, token, saved);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : '素材上传失败，请重试');
        }
      }
    } finally {
      finishChatDraftUpload(sessionId, token, errors.join('；'));
    }
  };
  const onDrop = (e: React.DragEvent) => {
    dragDepthRef.current = 0;
    setDragOver(false);
    if (!e.dataTransfer.files?.length) return;
    e.preventDefault();
    void doUpload(e.dataTransfer.files);
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (e.clipboardData.files?.length) { e.preventDefault(); void doUpload(e.clipboardData.files); }
  };
  const removeAttachment = (path: string) => removeChatDraftAttachment(sessionId, path);
  const openUpload = (kind: ComposerUploadKind) => {
    (kind === 'media' ? mediaInputRef : kind === 'folder' ? folderInputRef : fileInputRef).current?.click();
  };
  const uploadSelection = (event: React.ChangeEvent<HTMLInputElement>, folder = false) => {
    let files = Array.from(event.currentTarget.files || []); event.currentTarget.value = '';
    if (folder) {
      const supported = files.filter(file => /\.(png|jpe?g|webp|gif|bmp|svg|mp4|mov|webm|m4v|pdf|txt|md|markdown|csv|json|srt|vtt|docx?|xlsx?|pptx?|mp3|wav|m4a)$/i.test(file.name));
      if (supported.length !== files.length) showToast(`已跳过 ${files.length - supported.length} 个不支持的文件。`);
      files = supported;
      if (!files.length) { showToast('文件夹中没有支持的素材文件。'); return; }
    }
    void doUpload(files);
  };

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const resize = () => {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight + 2, 240) + 'px';
    };
    resize();
    // Reflow long drafts when the sidebar or viewport changes the available width.
    let previousWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === previousWidth) return;
      previousWidth = el.clientWidth;
      resize();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [displayedInput]);

  const handleSend = () => {
    if(goalEditor){void goalState.save();return;}
    if (editingQueue && queueEdit) {
      if (updateQueuedMessage(sessionId, queueEdit.id, queueEdit.text)) setQueueEdit(null);
      else setChatDraftError(sessionId, '修改未保存，请检查输入或浏览器存储。');
      return;
    }
    if(onGoal){const command=parseComposerCommand(input);if(command){dispatchCommand(command);return;}}
    if(goalBusy){setChatDraftError(sessionId,'目标轮次正在运行，本条消息尚未发送；请稍候或先暂停目标。');return;}
    const submitted = getChatDraft(sessionId);
    const requestText = analysisDraftText(submitted.text, analysisContext).trim();
    const trimmed = submitted.quotes?.length ? `${submitted.quotes.map((text, index) => `引用 ${index + 1}：\n${appendQuotedText('', text).trim()}`).join('\n\n')}\n\n${requestText}`.trim() : requestText;
    if ((!trimmed && submitted.attachments.length === 0) || stopping || submitted.uploading
      || submitted.missingAttachments.length || composingRef.current) return;
    // 附件通过结构化字段发送；用户消息气泡只显示用户实际输入的文字。
    try {
      const snapshot = engine === 'codex' || chatOnly ? {selectedSkills: [], skillRequirements: {}} : skills.getSnapshot();
      if (!snapshot) return;
      const model = models.getSnapshot();
      if (!model) { setModelGuardShown(true); return; }
      const effort = alternate ? undefined : thinkingLevel;
      const accepted = model.modelRef ? onSend(trimmed, submitted.attachments, snapshot.selectedSkills, snapshot.skillRequirements, effort, model.modelRef)
        : onSend(trimmed, submitted.attachments, snapshot.selectedSkills, snapshot.skillRequirements, effort);
      if (accepted === true) clearChatDraft(sessionId, submitted);
      else setChatDraftError(sessionId, '当前消息未被接收，草稿已保留，请稍后重试。');
    } catch {
      setChatDraftError(sessionId, '消息暂时无法发送，草稿已保留，请稍后重试。');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if(composingRef.current||e.nativeEvent.isComposing||e.keyCode===229)return;
    if(goalEditor){
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeGoal();}
      if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();handleSend();}
      return;
    }
    if(commandOpen){
      if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();setCommandIndex(index=>(index+(e.key==='ArrowDown'?1:commandItems.length-1))%commandItems.length);return;}
      if(e.key==='Escape'){e.preventDefault();setDismissedCommand(input);return;}
      if((e.key==='Enter'||e.key==='Tab')&&!e.shiftKey){e.preventDefault();chooseCommandItem(commandItems[Math.min(commandIndex,commandItems.length-1)].id);return;}
    }
    if (editingQueue && e.key === 'Escape') { e.preventDefault(); setQueueEdit(null); return; }
    if (e.key === 'Enter' && !e.shiftKey && !composingRef.current && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-composer-stack">
      <ChatQueueTray sessionId={sessionId} editingId={editingQueue ? queueEdit!.id : undefined} onEdit={editQueued} onSteer={onSteer} isStreaming={isStreaming} stopping={stopping} />
    <div className={`composer chat-composer ${hero ? 'composer-hero' : ''} ${dragOver ? 'composer-drag' : ''}`}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        if (!uploading && !stopping) setDragOver(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = stopping || uploading ? 'none' : 'copy';
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragOver(false);
      }}
      onDrop={onDrop}>
      <ChatCompactionIndicator event={compaction} />
      {commandOpen&&<ComposerGoalMenu id={`${inputId}-commands`} anchor={textareaRef} items={commandItems} selected={Math.min(commandIndex,commandItems.length-1)} onSelect={setCommandIndex} onChoose={chooseCommandItem}/>}
      {!editingQueue && <ChatQuoteDraft sessionId={sessionId} quotes={draft.quotes || []} comment={input}/>}
      {!editingQueue && !goalEditor && analysisContext && <AnalysisComposerMaterial context={analysisContext} onOpen={onOpenAnalysisMaterial}/>}
      {!editingQueue && engine !== 'codex' && !chatOnly && <ComposerSkillChips skills={skills} />}
      <textarea
        ref={textareaRef}
        id={inputId}
        className="chat-input"
        placeholder={dragOver ? '松手添加素材…' : goalEditor ? '输入目标…' : analysisContext ? '想重点分析什么？补充你的要求…' : draft.quotes?.length ? '针对引用内容，补充你的想法…' : hero ? '描述你的想法，或添加素材…' : '继续对话，或提出新的想法…'}
        value={displayedInput}
        disabled={Boolean(goalEditor&&goalState.fieldsLocked)}
        maxLength={goalEditor?6000:undefined}
        onChange={(e) => goalEditor?goalState.setObjective(e.target.value):setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onPaste={onPaste}
        aria-label={goalEditor?'要持续追求的目标':'创作消息'}
        aria-haspopup={onGoal&&!goalEditor?'listbox':undefined}
        aria-expanded={onGoal&&!goalEditor?commandOpen:undefined}
        aria-controls={commandOpen?`${inputId}-commands`:undefined}
        aria-activedescendant={commandOpen?`${inputId}-commands-${commandItems[Math.min(commandIndex,commandItems.length-1)]?.id||'goal'}`:undefined}
        rows={2}
        autoFocus={hero}
      />
      {goalEditor&&<ChatGoalNotice state={goalState} goal={goalEditor.goal} blocked={goalBlocked}/>}
      {!editingQueue && attachments.length > 0 && <ComposerAttachments files={attachments} onRemove={removeAttachment}/>}
      {!editingQueue && engine !== 'codex' && !chatOnly && <ComposerSkillSuggestions text={input} skills={skills} disabled={stopping}/>}
      {(modelGuardShown || legacyModelError) && !models.ready && <div className="composer-connection-notice" role={models.loading ? 'status' : 'alert'} aria-busy={models.loading}>
        <span className="composer-connection-icon" aria-hidden="true">{models.loading ? <IconLoader className="composer-connection-spinner" size={17}/> : <IconOpenClaw size={17}/>}</span>
        <div className="composer-connection-content"><p>{models.loading ? '正在检查连接…' : composerModelIssue(models).replace(' 草稿已保留，消息尚未发送。', '')}</p>
        </div>
      </div>}
      {uploadError && !legacyModelError && <div className="composer-upload-error" role="alert">{uploadError}</div>}
      {draft.missingAttachments.length > 0 && <div className="composer-skills-note" role="status">
        <p>文本草稿已恢复。刷新前的素材需要重新添加：{draft.missingAttachments.join('、')}。确认素材后才能发送。</p>
        <button type="button" className="composer-attach-btn" onClick={() => dismissMissingDraftAttachments(sessionId)}>忽略这些素材</button>
      </div>}
      {engine !== 'codex' && !chatOnly && skills.notice && <p className="composer-skills-note" role="status">{skills.notice}
        {skills.restorePending && <button type="button" className="link-btn" onClick={() => skills.retryRestore()}>重试恢复技能</button>}
      </p>}
      {models.notice && <p className="composer-skills-note" role="status">{models.notice}</p>}
      {goalBusy&&!goalEditor&&<p className="composer-skills-note" role="status">目标正在执行</p>}
      {!goalBusy&&goalActive&&!goalEditor&&<p className="composer-skills-note" role="status">目标进行中</p>}
      <input ref={fileInputRef} type="file" multiple hidden onChange={uploadSelection}/>
      <input ref={mediaInputRef} type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.mp4,.mov,.webm,.m4v" multiple hidden onChange={uploadSelection}/>
      <input ref={folderInputRef} type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={event => uploadSelection(event, true)}/>
      <div className="composer-bar">
        <div className="composer-tools" hidden={editingQueue}>
          <Select className="composer-engine composer-engine-icon" aria-label="对话引擎" value={engine} disabled={engineLocked || isStreaming || stopping || Boolean(goalEditor)}
            title={`对话引擎：${engine === 'codex' ? 'Codex' : runtimeLabel}`}
            options={[{value:'openclaw',label:runtimeLabel,icon:<IconOpenClaw size={18}/>},{value:'codex',label:'Codex',icon:<IconTerminal size={16}/>}]} onChange={value=>onEngineChange?.(value as 'openclaw'|'codex')} />
          <ComposerAddMenu skillsDisabled={engine === 'codex' || chatOnly} disabled={stopping || uploading} uploading={uploading} onUpload={openUpload} onOutputs={()=>setOutputsOpen(true)} onSkills={() => setSkillPickerRequest(value => value + 1)}/>
          {outputsOpen && <GeneratedFilePicker sessionId={sessionId} onClose={()=>setOutputsOpen(false)}/>}
          {goalEditor?<ChatGoalComposer state={goalState} goal={goalEditor.goal} onExit={closeGoal}/>:onGoal&&Boolean(goalStatus)&&<button type="button" className="composer-goal-btn" aria-pressed={false} aria-label="设置或查看目标" title="设置或查看当前对话目标" disabled={editingQueue} onClick={()=>openGoal()}><IconTarget size={16}/><span>目标</span></button>}
          {engine !== 'codex' && !chatOnly && <ComposerSkillPicker skills={skills} setInput={setInput} openRequest={skillPickerRequest}/>}
          <ChatContextUsage sessionId={sessionId} modelRef={models.modelRef || models.capability?.currentModelRef || models.capability?.defaultModelRef || ''} engine={engine} streaming={isStreaming} refreshKey={usageRefreshKey} onOpenModels={onOpenModels} />
          {goalEditor&&goalState.modelLocked?<Select className="composer-goal-locked-model" aria-label="目标执行模型" value={goalState.executionModel} disabled onChange={()=>{}} options={[{value:goalState.executionModel,label:goalState.executionModel}]}/>:engine === 'codex' ? <Select aria-label="选择模型" value={models.modelRef} disabled={stopping || models.loading}
            options={[{value:'',label:'Codex 默认模型'},...models.options.map(option=>({value:option.id,label:option.label}))]} onChange={models.choose}/>
            : <ComposerModelPicker models={models} disabled={stopping} onOpenModels={onOpenModels} />}
          {!alternate && <ThinkingLevelPicker value={preferredThinking} onChange={changeThinkingLevel} disabled={stopping}
            supportedLevels={supportedThinking} />}
        </div>
        {editingQueue && <div className="composer-queue-edit-actions">
          <span>编辑待发送消息</span>
          <button type="button" onClick={() => setQueueEdit(null)}>取消</button>
          <button type="button" onClick={handleSend} disabled={!input.trim() || input.length > 20000}>保存修改</button>
        </div>}
        <div className="composer-send-actions" hidden={editingQueue}>{isStreaming && (
          <button type="button" className="send-btn" onClick={onStop} disabled={stopping} title={stopping ? '等待停止确认' : '停止生成'} aria-label={stopping ? '等待停止确认' : '停止生成'}><IconStop size={15} /></button>
        )}{goalEditor?<button type="button" className="send-btn" onClick={handleSend} disabled={!goalState.canSubmit||uploading} title={`${goalState.label} · ${goalState.executionModel||'请先选择模型'}`} aria-label={goalState.label} aria-busy={goalState.busy}><IconArrowUp size={18}/></button>:(!isStreaming || Boolean(input.trim() || attachments.length || draft.quotes?.length)) && (
          <button type="button" className="send-btn" onClick={handleSend} disabled={(!input.trim() && !attachments.length && !draft.quotes?.length) || uploading || stopping || draft.missingAttachments.length > 0 || (goalBusy&&parseComposerCommand(input)===null&&input.trim()!=='/')} title={goalBusy?'目标轮次运行中，先暂停目标再发送':isStreaming ? '加入队列，本轮完成后发送' : '发送'} aria-label={isStreaming ? '排队发送' : '发送消息'}><IconArrowUp size={18} /></button>
        )}
        </div>
      </div>
      {engine === 'codex' && <details><summary>Codex 设置与能力</summary><CodexSettings /></details>}
    </div>
    </div>
  );

}



export { ThinkingLevelPicker } from './ThinkingLevelPicker';
