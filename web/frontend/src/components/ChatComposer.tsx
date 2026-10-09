import type { SkillRequirements } from '../lib/selectedSkills';
import { useState, useRef, useEffect, useId, useLayoutEffect, useCallback, useSyncExternalStore } from 'react';
import { getChatDraft, subscribeChatDraft, setChatDraftText, removeChatDraftAttachment,
  dismissMissingDraftAttachments, setChatDraftError, beginChatDraftUpload,
  appendChatDraftUploads, finishChatDraftUpload, clearChatDraft } from '../lib/chatDrafts';
import { useComposerSkills } from '../hooks/useComposerSkills';
import { ComposerSkillChips, ComposerSkillPicker } from './ComposerSkills';
import ComposerModelPicker from './ComposerModelPicker';
import { useComposerModels } from '../hooks/useComposerModels';
import { uploadFiles, adoptOversize } from '../lib/api';
import type { UploadedFile, ThinkingLevel } from '../lib/api';
import { IconArrowUp, IconStop, IconPlus, IconFile, IconChevron } from './icons';
import { loadThinkingLevel, saveThinkingLevel, THINKING_LEVELS } from '../lib/thinkingLevel';
import '../styles/chat-composer.css';

interface ChatComposerProps {
  sessionId: string;
  hero?: boolean;
  isStreaming: boolean;
  stopping?: boolean;
  onSend: (displayText: string, attachments?: UploadedFile[], selectedSkills?: string[], skillRequirements?: SkillRequirements, thinkingLevel?: ThinkingLevel, modelRef?: string) => boolean;
  onStop: () => void;
}


/** Shared multiline composer for the welcome and conversation views. */
export default function ChatComposer(props: ChatComposerProps) {
  return <SessionChatComposer key={props.sessionId} {...props} />;
}

function SessionChatComposer({ sessionId, hero = false, isStreaming, stopping = false, onSend, onStop }: ChatComposerProps) {
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
    if (!arr.length || isStreaming || stopping) return;
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
    if ((!trimmed && submitted.attachments.length === 0) || isStreaming || stopping || submitted.uploading
      || submitted.missingAttachments.length || composingRef.current) return;
    // 附件通过结构化字段发送；用户消息气泡只显示用户实际输入的文字。
    try {
      const snapshot = skills.getSnapshot();
      if (!snapshot) return;
      const model = models.getSnapshot();
      if (!model) { setChatDraftError(sessionId, '所选模型当前无法用于本轮，草稿已保留。请刷新模型选项或改用会话配置。'); return; }
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
        if (!isStreaming && !uploading) setDragOver(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = isStreaming || uploading ? 'none' : 'copy';
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragOver(false);
      }}
      onDrop={onDrop}>
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
      {models.modelRef && !models.ready && <p className="composer-skills-note" role="status">{models.error || models.capability?.reason || '所选模型尚未通过本轮能力核验。请刷新或重新选择。'}</p>}
      <input ref={fileInputRef} type="file" multiple hidden
        onChange={(e) => { if (e.target.files) void doUpload(e.target.files); e.target.value = ''; }} />
      <div className="composer-bar">
        <div className="composer-tools">
          <button type="button" className="composer-attach-btn" onClick={() => fileInputRef.current?.click()}
            disabled={isStreaming || uploading} aria-label={uploading ? '正在添加素材' : '添加图片或文档'} title={`添加图片或文档；支持拖入或粘贴，超过 ${maxMb}MB 的文件将存为本地素材`}>
            <IconPlus size={18} />{uploading && <span>上传中…</span>}
          </button>
          <ComposerSkillPicker skills={skills} setInput={setInput} />
          <ComposerModelPicker models={models} disabled={isStreaming || stopping} />
          <ThinkingLevelPicker value={thinkingLevel} onChange={changeThinkingLevel} disabled={isStreaming || stopping} />
        </div>
        <span className="composer-hint" id={hintId}>
          <span>{stopping ? '正在等待停止确认' : isStreaming ? '正在生成，可随时停止' : uploading ? '正在添加素材，请稍候' : 'Enter 发送 · Shift+Enter 换行'}</span>
        </span>
        {isStreaming ? (
          <button type="button" className="send-btn" onClick={onStop} disabled={stopping} title={stopping ? '等待停止确认' : '停止生成'} aria-label={stopping ? '等待停止确认' : '停止生成'}><IconStop size={15} /></button>
        ) : (
          <button type="button" className="send-btn" onClick={handleSend} disabled={(!input.trim() && !attachments.length) || uploading || stopping || draft.missingAttachments.length > 0} title="发送" aria-label="发送消息"><IconArrowUp size={18} /></button>
        )}
      </div>
    </div>
  );

}

const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: '关闭', minimal: '极简', low: '低', medium: '中', high: '高',
  xhigh: '极高', adaptive: '自适应', max: '最大', ultra: 'Ultra',
};

function ThinkingLevelPicker({ value, onChange, disabled }: { value: ThinkingLevel; onChange: (value: ThinkingLevel) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const menuOpen = open && !disabled;
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, THINKING_LEVELS.indexOf(value)));
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionId = useId();
  const activeId = `${optionId}-${THINKING_LEVELS[activeIndex]}`;
  const openMenu = (index = Math.max(0, THINKING_LEVELS.indexOf(value))) => {
    if (disabled) return;
    setActiveIndex(index);
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
    if (menuOpen) menuRef.current?.focus();
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }, [menuOpen, activeIndex]);
  const choose = (level: ThinkingLevel) => {
    if (disabled) return;
    onChange(level);
    setActiveIndex(Math.max(0, THINKING_LEVELS.indexOf(level)));
    setOpen(false);
    triggerRef.current?.focus();
  };
  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault(); setActiveIndex(index => (index + 1) % THINKING_LEVELS.length);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault(); setActiveIndex(index => (index - 1 + THINKING_LEVELS.length) % THINKING_LEVELS.length);
    } else if (event.key === 'Home') {
      event.preventDefault(); setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault(); setActiveIndex(THINKING_LEVELS.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); choose(THINKING_LEVELS[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault(); setOpen(false); triggerRef.current?.focus();
    }
  };
  return <div className="thinking-level-picker" ref={rootRef}>
    <button ref={triggerRef} type="button" className="thinking-level-trigger" disabled={disabled}
      aria-haspopup="listbox" aria-expanded={menuOpen} aria-controls={menuOpen ? `${optionId}-menu` : undefined} aria-label={`思考强度：${THINKING_LABELS[value]}`} title="选择本轮思考强度；实际支持取决于模型"
      onClick={() => open ? setOpen(false) : openMenu()}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openMenu(); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); openMenu(); }
        else if (event.key === 'Escape') setOpen(false);
      }}>
      <span>思考强度</span><strong>{THINKING_LABELS[value]}</strong><IconChevron size={13} />
    </button>
    {menuOpen && <div ref={menuRef} id={`${optionId}-menu`} className="thinking-level-menu" role="listbox" tabIndex={-1} aria-label="思考强度选项" aria-activedescendant={activeId} onKeyDown={handleMenuKeyDown}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
      {THINKING_LEVELS.map((level, index) => <button id={`${optionId}-${level}`} key={level} type="button" tabIndex={-1} role="option" aria-selected={level === value}
        className={`thinking-level-option ${level === value ? 'is-selected' : ''} ${index === activeIndex ? 'is-active' : ''}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(level)}>
        <span><strong>{THINKING_LABELS[level]}</strong><small>{level}</small></span>
        {level === value && <span aria-hidden="true">✓</span>}
      </button>)}
    </div>}
  </div>;
}
