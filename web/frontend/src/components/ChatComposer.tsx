import ChatCompactionIndicator from './ChatCompactionIndicator';
import type { SkillRequirements } from '../lib/selectedSkills';
import { useState, useRef, useEffect, useId, useLayoutEffect, useCallback, useSyncExternalStore } from 'react';
import { getChatDraft, subscribeChatDraft, setChatDraftText, removeChatDraftAttachment,
  dismissMissingDraftAttachments, setChatDraftError, beginChatDraftUpload,
  appendChatDraftUploads, finishChatDraftUpload, clearChatDraft } from '../lib/chatDrafts';
import { useComposerSkills } from '../hooks/useComposerSkills';
import { ComposerSkillChips, ComposerSkillPicker } from './ComposerSkills';
import ComposerModelPicker, { ComposerModelStatus } from './ComposerModelPicker';
import { useComposerModels } from '../hooks/useComposerModels';
import { uploadFiles, adoptOversize } from '../lib/api';
import type { UploadedFile, ThinkingLevel } from '../lib/api';
import { IconArrowUp, IconStop, IconChevron } from './icons';
import ComposerAttachments from './ComposerAttachments';
import ComposerAddMenu, { type ComposerUploadKind } from './ComposerAddMenu';
import { DEFAULT_THINKING_LEVEL, loadThinkingLevel, saveThinkingLevel, THINKING_LEVELS, THINKING_LABELS } from '../lib/thinkingLevel';
import '../styles/chat-composer.css';
import '../styles/thinking-level-picker.css';
import { showToast } from '../lib/toast';
import { CHAT_QUOTE_EVENT, appendQuotedText } from '../lib/chatQuote';
import { addChatDraftQuote } from '../lib/chatDrafts';
import ChatQuoteDraft from './ChatQuoteDraft';
import InlineInfo from './InlineInfo';
import ChatQueueTray from './ChatQueueTray';
import { getChatQueue, subscribeChatQueue, pauseChatQueue, updateQueuedMessage } from '../lib/chatQueue';

interface ChatComposerProps {
  sessionId: string;
  compaction?: import('../lib/chatCompaction').ChatCompaction;
  hero?: boolean;
  isStreaming: boolean;
  stopping?: boolean;
  onSend: (displayText: string, attachments?: UploadedFile[], selectedSkills?: string[], skillRequirements?: SkillRequirements, thinkingLevel?: ThinkingLevel, modelRef?: string) => boolean;
  onStop: () => void;
  onSteer?: (id: string) => Promise<boolean>;
  onOpenModels?: () => void;
}


/** Shared multiline composer for the welcome and conversation views. */
export default function ChatComposer(props: ChatComposerProps) {
  return <SessionChatComposer key={props.sessionId} {...props} />;
}

function SessionChatComposer({ sessionId, compaction, hero = false, isStreaming, stopping = false, onSend, onStop, onSteer, onOpenModels }: ChatComposerProps) {
  const draft = useSyncExternalStore(
    useCallback(listener => subscribeChatDraft(sessionId, listener), [sessionId]),
    useCallback(() => getChatDraft(sessionId), [sessionId]),
  );
  const queue = useSyncExternalStore(subscribeChatQueue, () => getChatQueue(sessionId));
  const [queueEdit, setQueueEdit] = useState<{ id: string; text: string } | null>(null);
  const editingItem = queue.items.find(item => item.id === queueEdit?.id);
  const editingQueue = Boolean(editingItem);
  const { attachments, uploading, error: uploadError } = draft;
  const input = editingQueue ? queueEdit!.text : draft.text;
  const setInput = (value: string | ((current: string) => string)) => {
    if (editingQueue) setQueueEdit(current => current ? { ...current, text: typeof value === 'function' ? value(current.text) : value } : null);
    else setChatDraftText(sessionId, value);
  };
  const editQueued = (id: string, text: string) => {
    if (queueEdit?.id === id) { textareaRef.current?.focus(); return; }
    if (editingQueue && !updateQueuedMessage(sessionId, queueEdit!.id, queueEdit!.text)) {
      setChatDraftError(sessionId, '当前修改未保存，请先保存或取消。'); return;
    }
    pauseChatQueue(sessionId); setQueueEdit({ id, text });
  };
  useEffect(() => { if (editingQueue) textareaRef.current?.focus(); }, [editingQueue, queueEdit?.id]);
  const [dragOver, setDragOver] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() => loadThinkingLevel());
  const [maxMb, setMaxMb] = useState(50);
  const skills = useComposerSkills(sessionId);
  const models = useComposerModels(sessionId);
  const effectiveModel = models.selected || models.options.find(option => option.id === (models.capability?.currentModelRef || models.capability?.defaultModelRef));
  const supportedThinking = effectiveModel?.thinkingLevels;
  const thinkingUnsupported = Boolean(supportedThinking?.length && !supportedThinking.includes(thinkingLevel));
  const thinkingWarning = thinkingUnsupported ? `${effectiveModel?.model} 不支持 ${THINKING_LABELS[thinkingLevel]}；网关声明可选：${supportedThinking?.map(level => THINKING_LABELS[level as ThinkingLevel]).join('、')}。请选择支持的档位。` : '';
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null), folderInputRef = useRef<HTMLInputElement>(null);
  const [skillPickerRequest, setSkillPickerRequest] = useState(0);
  const composingRef = useRef(false);
  const dragDepthRef = useRef(0);
  const inputId = useId();
  const hintId = `${inputId}-hint`;
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
  const changeThinkingLevel = (value: ThinkingLevel) => {
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
  }, [input]);

  const handleSend = () => {
    if (editingQueue && queueEdit) {
      if (updateQueuedMessage(sessionId, queueEdit.id, queueEdit.text)) setQueueEdit(null);
      else setChatDraftError(sessionId, '修改未保存，请检查输入或浏览器存储。');
      return;
    }
    const submitted = getChatDraft(sessionId);
    const trimmed = submitted.quotes?.length ? `${submitted.quotes.map((text, index) => `引用 ${index + 1}：\n${appendQuotedText('', text).trim()}`).join('\n\n')}\n\n${submitted.text.trim()}`.trim() : submitted.text.trim();
    if ((!trimmed && submitted.attachments.length === 0) || stopping || submitted.uploading
      || submitted.missingAttachments.length || composingRef.current) return;
    // 附件通过结构化字段发送；用户消息气泡只显示用户实际输入的文字。
    try {
      const snapshot = skills.getSnapshot();
      if (!snapshot) return;
      const model = models.getSnapshot();
      if (!model) { setChatDraftError(sessionId, '所选模型当前无法用于本轮，草稿已保留。请刷新模型选项或改用会话配置。'); return; }
      if (thinkingUnsupported) { setChatDraftError(sessionId, `${thinkingWarning} 草稿已保留，未发送请求。`); return; }
      const accepted = model.modelRef ? onSend(trimmed, submitted.attachments, snapshot.selectedSkills, snapshot.skillRequirements, thinkingLevel, model.modelRef)
        : onSend(trimmed, submitted.attachments, snapshot.selectedSkills, snapshot.skillRequirements, thinkingLevel);
      if (accepted === true) clearChatDraft(sessionId, submitted);
      else setChatDraftError(sessionId, '当前消息未被接收，草稿已保留，请稍后重试。');
    } catch {
      setChatDraftError(sessionId, '消息暂时无法发送，草稿已保留，请稍后重试。');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      {!editingQueue && <ChatQuoteDraft sessionId={sessionId} quotes={draft.quotes || []} comment={input}/>}
      {!editingQueue && <ComposerSkillChips skills={skills} />}
      <textarea
        ref={textareaRef}
        id={inputId}
        className="chat-input"
        placeholder={dragOver ? '松手添加素材…' : draft.quotes?.length ? '针对引用内容，补充你的想法…' : hero ? '描述你的想法，或添加素材…' : '继续对话，或提出新的想法…'}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onPaste={onPaste}
        aria-label="创作消息"
        aria-describedby={hintId}
        rows={2}
        autoFocus={hero}
      />
      {!editingQueue && attachments.length > 0 && <ComposerAttachments files={attachments} onRemove={removeAttachment}/>}
      {uploadError && <div className="composer-upload-error" role="alert">{uploadError}</div>}
      {draft.missingAttachments.length > 0 && <div className="composer-skills-note" role="status">
        <p>文本草稿已恢复。刷新前的素材需要重新添加：{draft.missingAttachments.join('、')}。确认素材后才能发送。</p>
        <button type="button" className="composer-attach-btn" onClick={() => dismissMissingDraftAttachments(sessionId)}>忽略这些素材</button>
      </div>}
      {skills.notice && <p className="composer-skills-note" role="status">{skills.notice}
        {skills.restorePending && <button type="button" className="link-btn" onClick={() => skills.retryRestore()}>重试恢复技能</button>}
      </p>}
      {models.notice && <p className="composer-skills-note" role="status">{models.notice}</p>}
      <input ref={fileInputRef} type="file" multiple hidden onChange={uploadSelection}/>
      <input ref={mediaInputRef} type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.mp4,.mov,.webm,.m4v" multiple hidden onChange={uploadSelection}/>
      <input ref={folderInputRef} type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={event => uploadSelection(event, true)}/>
      <div className="composer-bar">
        <div className="composer-tools" hidden={editingQueue}>
          <ComposerAddMenu disabled={stopping || uploading} uploading={uploading} onUpload={openUpload} onSkills={() => setSkillPickerRequest(value => value + 1)}/>
          <ComposerSkillPicker skills={skills} setInput={setInput} openRequest={skillPickerRequest}/>
          <ComposerModelPicker models={models} disabled={stopping} onOpenModels={onOpenModels} />
          <ThinkingLevelPicker value={thinkingLevel} onChange={changeThinkingLevel} disabled={stopping}
            supportedLevels={supportedThinking}
            modelLabel={models.selected?.model || (models.modelRef ? models.modelRef : '沿用会话模型')} />
        </div>
        {editingQueue && <div className="composer-queue-edit-actions">
          <span>编辑待发送消息</span>
          <button type="button" onClick={() => setQueueEdit(null)}>取消</button>
          <button type="button" onClick={handleSend} disabled={!input.trim() || input.length > 20000}>保存修改</button>
        </div>}
        <div className="composer-send-actions" hidden={editingQueue}>{isStreaming && (stopping || (!input.trim() && !attachments.length && !draft.quotes?.length)) ? (
          <button type="button" className="send-btn" onClick={onStop} disabled={stopping} title={stopping ? '等待停止确认' : '停止生成'} aria-label={stopping ? '等待停止确认' : '停止生成'}><IconStop size={15} /></button>
        ) : (
          <button type="button" className="send-btn" onClick={handleSend} disabled={(!input.trim() && !attachments.length && !draft.quotes?.length) || uploading || stopping || draft.missingAttachments.length > 0} title={isStreaming ? '加入队列，本轮完成后发送' : '发送'} aria-label={isStreaming ? '排队发送' : '发送消息'}><IconArrowUp size={18} /></button>
        )}
        </div>
      </div>
      <span className="composer-hint" id={hintId}>
        {editingQueue ? 'Enter 保存 · Esc 取消 · Shift+Enter 换行' : stopping ? '正在等待停止确认' : isStreaming ? 'Enter 排队 · Shift+Enter 换行' : uploading ? '正在添加素材，请稍候' : 'Enter 发送 · Shift+Enter 换行'}
      </span>
      {!editingQueue && <ComposerModelStatus models={models} disabled={isStreaming || stopping} onOpenModels={onOpenModels} />}
      {thinkingUnsupported && <p className="composer-thinking-warning" role="status">{thinkingWarning}</p>}
    </div>
    </div>
  );

}



export function ThinkingLevelPicker({ value, onChange, disabled, modelLabel, supportedLevels }: { value: ThinkingLevel; onChange: (value: ThinkingLevel) => void; disabled: boolean; modelLabel: string; supportedLevels?: string[] }) {
  const [open, setOpen] = useState(false);
  const menuOpen = open && !disabled;
  const strengthLevels = THINKING_LEVELS.filter(level => level !== 'adaptive');
  const resetLevel = supportedLevels?.length && !supportedLevels.includes(DEFAULT_THINKING_LEVEL)
    ? THINKING_LEVELS.find(level => supportedLevels.includes(level)) : DEFAULT_THINKING_LEVEL;
  const index = Math.max(0, strengthLevels.indexOf(value as Exclude<ThinkingLevel, 'adaptive'>));
  const availableIndexes = strengthLevels.flatMap((level, i) => !supportedLevels?.length || supportedLevels.includes(level) ? [i] : []);
  const minIndex = availableIndexes[0] ?? 0, maxIndex = availableIndexes.at(-1) ?? 0;
  const sliderIndex = Math.min(maxIndex, Math.max(minIndex, index));
  const rootRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, below: false });
  const pickerId = useId();
  const openMenu = () => {
    if (disabled) return;
    setOpen(true);
  };
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const place = () => {
      const root = rootRef.current?.getBoundingClientRect(), menu = menuRef.current?.getBoundingClientRect();
      if (!root || !menu) return;
      setMenuPosition({ left: Math.max(12, Math.min(root.right - menu.width, window.innerWidth - menu.width - 12)) - root.left,
        below: root.top - menu.height - 8 < 12 && window.innerHeight - root.bottom > root.top });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (menuOpen) sliderRef.current?.focus();
  }, [menuOpen]);
  const choose = (nextIndex: number) => {
    if (disabled) return;
    const level = strengthLevels[Math.min(strengthLevels.length - 1, Math.max(0, Math.round(nextIndex)))];
    if (level && supportedLevels?.length && !supportedLevels.includes(level)) {
      return;
    }
    if (level && level !== value) onChange(level);
  };
  const closeAndFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const handleSliderKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault(); const next = availableIndexes.find(i => i > index); if (next !== undefined) choose(next);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault(); for (let i = index - 1; i >= 0; i--) { if (!supportedLevels?.length || supportedLevels.includes(strengthLevels[i])) { choose(i); break; } }
    } else if (event.key === 'Home') {
      event.preventDefault(); choose(minIndex);
    } else if (event.key === 'End') {
      event.preventDefault(); for (let i = strengthLevels.length - 1; i >= 0; i--) { if (!supportedLevels?.length || supportedLevels.includes(strengthLevels[i])) { choose(i); break; } }
    } else if (event.key === 'Enter') {
      event.preventDefault(); closeAndFocus();
    }
  };
  return <div className={`thinking-level-picker${value === 'ultra' ? ' is-ultra' : ''}${value === 'adaptive' ? ' is-adaptive' : ''}`} ref={rootRef} style={{ '--thinking-progress': `${sliderIndex / (strengthLevels.length - 1) * 100}%`, '--thinking-available': `${maxIndex / (strengthLevels.length - 1) * 100}%` } as React.CSSProperties}>
    <button ref={triggerRef} type="button" className="thinking-level-trigger" disabled={disabled}
      aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls={menuOpen ? `${pickerId}-menu` : undefined} aria-label={`思考强度：${THINKING_LABELS[value]}`} title="选择本轮思考强度；实际支持取决于模型"
      onClick={() => open ? setOpen(false) : openMenu()}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openMenu(); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); openMenu(); }
        else if (event.key === 'Escape') setOpen(false);
      }}>
      <strong>{THINKING_LABELS[value]}</strong><IconChevron size={13} />
    </button>
    {menuOpen && <div ref={menuRef} id={`${pickerId}-menu`} className="thinking-level-menu" role="dialog" aria-label="思考强度"
      style={{ left: menuPosition.left, right: 'auto', ...(menuPosition.below ? { top: 'calc(100% + 8px)', bottom: 'auto' } : {}) }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeAndFocus(); } }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
      <div className="thinking-level-heading"><strong>{THINKING_LABELS[value]}</strong>
        <button type="button" className="thinking-level-adaptive" aria-pressed={value === 'adaptive'} title={supportedLevels?.length && !supportedLevels.includes('adaptive') ? '网关声明不支持自适应' : '由模型自动决定强度'} disabled={disabled || Boolean(supportedLevels?.length && !supportedLevels.includes('adaptive'))} onClick={() => onChange('adaptive')}>自适应</button>
        <button type="button" className="thinking-level-reset" aria-label="恢复默认思考强度" title={resetLevel ? `恢复可用默认：${THINKING_LABELS[resetLevel]}` : '当前模型没有可用默认档位'} disabled={disabled || !resetLevel || value === resetLevel}
          onClick={() => { if (resetLevel) onChange(resetLevel); sliderRef.current?.focus(); }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M3 7a5 5 0 1 1 .9 4M3 2v5h5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      <div className="thinking-level-model"><span title={`所选模型：${modelLabel}`}>{modelLabel}</span><InlineInfo label="思考强度能力说明">
        {supportedLevels?.length ? <>网关声明可选：{supportedLevels.map(level => THINKING_LABELS[level as ThinkingLevel]).join('、')}。不支持的档位已禁用。<br/>这是能力声明，非本轮调用实测。</> : <>能力信息尚未提供；当前选择用于下一轮请求。</>}
      </InlineInfo></div>
      <div className="thinking-level-slider-wrap">
        {maxIndex < strengthLevels.length - 1 && <span className="thinking-level-unavailable" aria-hidden="true"/>}
        {value === 'ultra' && <div className="thinking-level-particles" aria-hidden="true">{Array.from({ length: 9 }, (_, particle) => <i key={particle} />)}</div>}
        <input ref={sliderRef} className="thinking-level-slider" type="range" min={0} max={maxIndex || 1} step={1} value={sliderIndex}
          style={{width:maxIndex ? `calc(${maxIndex / (strengthLevels.length - 1) * 100}% + ${27 * (1 - maxIndex / (strengthLevels.length - 1))}px)` : '27px'}}
          aria-label="思考强度" aria-valuetext={THINKING_LABELS[value]} aria-describedby={`${pickerId}-hint`} disabled={disabled || availableIndexes.length < 2}
          onChange={event => choose(Number(event.target.value))} onKeyDown={handleSliderKeyDown} />
        <div className="thinking-level-ticks">{strengthLevels.map((level, tick) => <button type="button" key={level} disabled={disabled || !availableIndexes.includes(tick)} aria-label={`选择${THINKING_LABELS[level]}思考强度`} aria-pressed={level===value} title={!availableIndexes.includes(tick) ? `${THINKING_LABELS[level]}：网关声明不支持` : THINKING_LABELS[level]} className={`${level === value ? 'is-current' : tick < sliderIndex ? 'is-filled' : ''}`} onClick={()=>choose(tick)}><span/></button>)}</div>
      </div>
      <span id={`${pickerId}-hint`} className="thinking-level-note">支持程度取决于模型，调整立即保存，对下一轮生效。</span>
    </div>}
  </div>;
}
