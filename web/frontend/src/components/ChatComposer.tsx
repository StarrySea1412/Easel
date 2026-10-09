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
import { IconArrowUp, IconStop, IconPlus, IconFile, IconChevron } from './icons';
import { DEFAULT_THINKING_LEVEL, loadThinkingLevel, saveThinkingLevel, THINKING_LEVELS } from '../lib/thinkingLevel';
import '../styles/chat-composer.css';
import ChatQueueTray from './ChatQueueTray';

interface ChatComposerProps {
  sessionId: string;
  hero?: boolean;
  isStreaming: boolean;
  stopping?: boolean;
  onSend: (displayText: string, attachments?: UploadedFile[], selectedSkills?: string[], skillRequirements?: SkillRequirements, thinkingLevel?: ThinkingLevel, modelRef?: string) => boolean;
  onStop: () => void;
  onOpenModels?: () => void;
}


/** Shared multiline composer for the welcome and conversation views. */
export default function ChatComposer(props: ChatComposerProps) {
  return <SessionChatComposer key={props.sessionId} {...props} />;
}

function SessionChatComposer({ sessionId, hero = false, isStreaming, stopping = false, onSend, onStop, onOpenModels }: ChatComposerProps) {
  const draft = useSyncExternalStore(
    useCallback(listener => subscribeChatDraft(sessionId, listener), [sessionId]),
    useCallback(() => getChatDraft(sessionId), [sessionId]),
  );
  const { text: input, attachments, uploading, error: uploadError } = draft;
  const setInput = (value: string | ((current: string) => string)) => setChatDraftText(sessionId, value);
  const [dragOver, setDragOver] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() => loadThinkingLevel());
  const [maxMb, setMaxMb] = useState(50);
  const skills = useComposerSkills(sessionId);
  const models = useComposerModels(sessionId);
  const effectiveModel = models.selected || models.options.find(option => option.id === (models.capability?.currentModelRef || models.capability?.defaultModelRef));
  const supportedThinking = effectiveModel?.thinkingLevels;
  const thinkingUnsupported = Boolean(supportedThinking?.length && !supportedThinking.includes(thinkingLevel));
  const thinkingWarning = thinkingUnsupported ? `${effectiveModel?.model} 不支持 ${THINKING_LABELS[thinkingLevel]}；运行时允许：${supportedThinking?.map(level => THINKING_LABELS[level as ThinkingLevel]).join('、')}。请选择支持的档位。` : '';
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const dragDepthRef = useRef(0);
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const changeThinkingLevel = (value: ThinkingLevel) => {
    setThinkingLevel(value);
    // Persist explicit choices only. StrictMode replays mount effects, which
    // must never replace an unreadable preference with the fallback value.
    saveThinkingLevel(value);
  };

  useEffect(() => {
    fetch('/api/upload/limits').then((r) => r.ok ? r.json() : null)
      .then((d) => { if (Number.isFinite(d?.max_mb) && d.max_mb > 0) setMaxMb(d.max_mb); }).catch(() => {});
  }, []);

  const doUpload = async (fs: FileList | File[]) => {
    const arr = Array.from(fs);
    if (!arr.length || stopping) return;
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
    const submitted = getChatDraft(sessionId);
    const trimmed = submitted.text.trim();
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
    if (e.key === 'Enter' && !e.shiftKey && !composingRef.current && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
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
      <ChatQueueTray sessionId={sessionId} />
      <ComposerSkillChips skills={skills} />
      <textarea
        ref={textareaRef}
        id={inputId}
        className="chat-input"
        placeholder={dragOver ? '松手添加素材…' : hero ? '描述你的想法，或添加素材…' : '继续对话，或提出新的想法…'}
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
      {attachments.length > 0 && (
        <div className="composer-attachments" aria-label="已添加的素材">
          {attachments.map((a) => (
            <span key={a.path} className="attach-chip" title={a.path}>
              <IconFile size={12} /> <span className="attach-name">{a.name}</span>
              <button type="button" className="attach-x" onClick={() => removeAttachment(a.path)} title="移除" aria-label={`移除 ${a.name}`}>×</button>
            </span>
          ))}
        </div>
      )}
      {uploadError && <div className="composer-upload-error" role="alert">{uploadError}</div>}
      {draft.missingAttachments.length > 0 && <div className="composer-skills-note" role="status">
        <p>文本草稿已恢复。刷新前的素材需要重新添加：{draft.missingAttachments.join('、')}。确认素材后才能发送。</p>
        <button type="button" className="composer-attach-btn" onClick={() => dismissMissingDraftAttachments(sessionId)}>忽略这些素材</button>
      </div>}
      {attachments.length > 0 && <p className="composer-skills-note">素材会随会话切换保留；刷新页面后需要重新添加。</p>}
      {skills.notice && <p className="composer-skills-note" role="status">{skills.notice}
        {skills.restorePending && <button type="button" className="link-btn" onClick={() => skills.retryRestore()}>重试恢复技能</button>}
      </p>}
      {models.notice && <p className="composer-skills-note" role="status">{models.notice}</p>}
      <input ref={fileInputRef} type="file" multiple hidden
        onChange={(e) => { if (e.target.files) void doUpload(e.target.files); e.target.value = ''; }} />
      <div className="composer-bar">
        <div className="composer-tools">
          <button type="button" className="composer-attach-btn" onClick={() => fileInputRef.current?.click()}
            disabled={stopping || uploading} aria-label={uploading ? '正在添加素材' : '添加图片或文档'} title={`添加图片或文档；支持拖入或粘贴，超过 ${maxMb}MB 的文件将存为本地素材`}>
            <IconPlus size={18} />{uploading && <span>上传中…</span>}
          </button>
          <ComposerSkillPicker skills={skills} setInput={setInput} />
          <ComposerModelPicker models={models} disabled={stopping} onOpenModels={onOpenModels} />
          <ThinkingLevelPicker value={thinkingLevel} onChange={changeThinkingLevel} disabled={stopping}
            supportedLevels={supportedThinking}
            modelLabel={models.selected?.model || (models.modelRef ? models.modelRef : '沿用会话模型')} />
        </div>
        <div className="composer-send-actions">{isStreaming && (
          <button type="button" className="send-btn" onClick={onStop} disabled={stopping} title={stopping ? '等待停止确认' : '停止生成'} aria-label={stopping ? '等待停止确认' : '停止生成'}><IconStop size={15} /></button>
        )}
          <button type="button" className="send-btn" onClick={handleSend} disabled={(!input.trim() && !attachments.length) || uploading || stopping || draft.missingAttachments.length > 0} title={isStreaming ? '加入队列，本轮完成后发送' : '发送'} aria-label={isStreaming ? '排队发送' : '发送消息'}><IconArrowUp size={18} /></button>
        </div>
      </div>
      <span className="composer-hint" id={hintId}>
        {stopping ? '正在等待停止确认' : isStreaming ? 'Enter 排队 · Shift+Enter 换行' : uploading ? '正在添加素材，请稍候' : 'Enter 发送 · Shift+Enter 换行'}
      </span>
      <ComposerModelStatus models={models} disabled={isStreaming || stopping} onOpenModels={onOpenModels} />
      {thinkingUnsupported && <p className="composer-thinking-warning" role="status">{thinkingWarning}</p>}
    </div>
  );

}

const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: '关闭', minimal: '极简', low: '低', medium: '中', high: '高',
  xhigh: '极高', adaptive: '自适应', max: '最大', ultra: 'Ultra',
};

function ThinkingLevelPicker({ value, onChange, disabled, modelLabel, supportedLevels }: { value: ThinkingLevel; onChange: (value: ThinkingLevel) => void; disabled: boolean; modelLabel: string; supportedLevels?: string[] }) {
  const [open, setOpen] = useState(false);
  const menuOpen = open && !disabled;
  const strengthLevels = THINKING_LEVELS.filter(level => level !== 'adaptive');
  const resetLevel = supportedLevels?.length && !supportedLevels.includes(DEFAULT_THINKING_LEVEL)
    ? THINKING_LEVELS.find(level => supportedLevels.includes(level)) : DEFAULT_THINKING_LEVEL;
  const index = Math.max(0, strengthLevels.indexOf(value as Exclude<ThinkingLevel, 'adaptive'>));
  const rootRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickerId = useId();
  const openMenu = () => {
    if (disabled) return;
    setOpen(true);
  };
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
    if (level && level !== value && (!supportedLevels?.length || supportedLevels.includes(level))) onChange(level);
  };
  const closeAndFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const handleSliderKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault(); const next = strengthLevels.findIndex((level, i) => i > index && (!supportedLevels?.length || supportedLevels.includes(level))); if (next >= 0) choose(next);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault(); for (let i = index - 1; i >= 0; i--) { if (!supportedLevels?.length || supportedLevels.includes(strengthLevels[i])) { choose(i); break; } }
    } else if (event.key === 'Home') {
      event.preventDefault(); choose(0);
    } else if (event.key === 'End') {
      event.preventDefault(); for (let i = strengthLevels.length - 1; i >= 0; i--) { if (!supportedLevels?.length || supportedLevels.includes(strengthLevels[i])) { choose(i); break; } }
    } else if (event.key === 'Enter') {
      event.preventDefault(); closeAndFocus();
    }
  };
  return <div className={`thinking-level-picker${value === 'ultra' ? ' is-ultra' : ''}${value === 'adaptive' ? ' is-adaptive' : ''}`} ref={rootRef} style={{ '--thinking-progress': `${index / (strengthLevels.length - 1) * 100}%` } as React.CSSProperties}>
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
    {menuOpen && <div id={`${pickerId}-menu`} className="thinking-level-menu" role="dialog" aria-label="思考强度"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeAndFocus(); } }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
      <div className="thinking-level-heading"><strong>{THINKING_LABELS[value]}</strong>
        <button type="button" className="thinking-level-adaptive" aria-pressed={value === 'adaptive'} title={supportedLevels?.length && !supportedLevels.includes('adaptive') ? '当前运行时不支持自适应' : '由模型自动决定强度'} disabled={disabled || Boolean(supportedLevels?.length && !supportedLevels.includes('adaptive'))} onClick={() => onChange('adaptive')}>自适应</button>
        <button type="button" className="thinking-level-reset" aria-label="恢复默认思考强度" title={resetLevel ? `恢复可用默认：${THINKING_LABELS[resetLevel]}` : '当前模型没有可用默认档位'} disabled={disabled || !resetLevel || value === resetLevel}
          onClick={() => { if (resetLevel) onChange(resetLevel); sliderRef.current?.focus(); }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M3 7a5 5 0 1 1 .9 4M3 2v5h5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      <p className="thinking-level-model" title={`所选模型：${modelLabel}`}>{modelLabel}</p>
      {supportedLevels?.length ? <p className="thinking-level-supported">运行时支持：{supportedLevels.map(level => THINKING_LABELS[level as ThinkingLevel]).join('、')}</p> : null}
      <div className="thinking-level-slider-wrap">
        {value === 'ultra' && <div className="thinking-level-particles" aria-hidden="true">{Array.from({ length: 9 }, (_, particle) => <i key={particle} />)}</div>}
        <input ref={sliderRef} className="thinking-level-slider" type="range" min={0} max={strengthLevels.length - 1} step={1} value={index}
          aria-label="思考强度" aria-valuetext={THINKING_LABELS[value]} aria-describedby={`${pickerId}-hint`} disabled={disabled}
          onChange={event => choose(Number(event.target.value))} onKeyDown={handleSliderKeyDown} />
        <div className="thinking-level-ticks" aria-hidden="true">{strengthLevels.map((level, tick) => <span key={level} className={level === value ? 'is-current' : tick < index ? 'is-filled' : ''} />)}</div>
      </div>
      <span id={`${pickerId}-hint`} className="thinking-level-note">支持程度取决于模型，调整立即保存，对下一轮生效。</span>
    </div>}
  </div>;
}
