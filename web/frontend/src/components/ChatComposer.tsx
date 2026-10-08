import { readSelectedSkills, writeSelectedSkills, readSkillRequirements, writeSkillRequirements,
  requirementsForSelection, MAX_SKILL_REQUIREMENT_LENGTH, MAX_SKILL_REQUIREMENTS_TOTAL, MAX_SKILL_REQUIREMENTS_COUNT } from '../lib/selectedSkills';
import type { SkillRequirements } from '../lib/selectedSkills';
import { useState, useRef, useEffect, useId, useLayoutEffect, useCallback, useSyncExternalStore } from 'react';
import { getChatDraft, subscribeChatDraft, setChatDraftText, removeChatDraftAttachment,
  dismissMissingDraftAttachments, setChatDraftError, beginChatDraftUpload,
  appendChatDraftUploads, finishChatDraftUpload, clearChatDraft } from '../lib/chatDrafts';
import BrushEntry from './BrushEntry';
import SelectedSkillChip from './SelectedSkillChip';
import { uploadFiles, adoptOversize, fetchSkills } from '../lib/api';
import type { UploadedFile } from '../lib/api';
import { IconArrowUp, IconStop, IconPlus, IconFile } from './icons';
import '../styles/chat-composer.css';

interface ChatComposerProps {
  sessionId: string;
  hero?: boolean;
  isStreaming: boolean;
  stopping?: boolean;
  onSend: (displayText: string, attachments?: UploadedFile[], selectedSkills?: string[], skillRequirements?: SkillRequirements) => boolean;
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
  const [maxMb, setMaxMb] = useState(50);
  const [selectedSkills, updateSelectedSkills] = useState<string[]>(() => readSelectedSkills(sessionId));
  const selectedSkillsRef = useRef(selectedSkills);
  const [skillRequirements, updateSkillRequirements] = useState(() => readSkillRequirements(sessionId, selectedSkills));
  const skillRequirementsRef = useRef(skillRequirements);
  const [skillStorageNotice, setSkillStorageNotice] = useState('');
  const [skillCatalog, setSkillCatalog] = useState<Set<string> | null>(null);
  const [skillCatalogFailed, setSkillCatalogFailed] = useState(false);
  const skillNotice = skillStorageNotice || (skillCatalogFailed ? '技能列表暂时无法读取，已保留当前选择。'
    : skillCatalog && selectedSkills.some(name => !skillCatalog.has(name)) ? '部分已选技能未出现在当前列表中，已保留选择；发送前请确认技能是否可用。' : '');
  const setSelectedSkills = (update: (current: string[]) => string[]) => {
    const next = update(selectedSkillsRef.current);
    selectedSkillsRef.current = next;
    updateSelectedSkills(next);
    const kept = requirementsForSelection(skillRequirementsRef.current, next);
    skillRequirementsRef.current = kept;
    updateSkillRequirements(kept);
    const selectedSaved = writeSelectedSkills(sessionId, next);
    const requirementsSaved = writeSkillRequirements(sessionId, kept);
    setSkillStorageNotice(selectedSaved && requirementsSaved ? '' : '浏览器未能保存技能选择或补充要求，刷新后需要重新设置。');
  };
  const saveSkillRequirement = (skill: string, text: string) => {
    if (!selectedSkillsRef.current.includes(skill)) return false;
    const next = { ...skillRequirementsRef.current, [skill]: text.trim() };
    if (!text.trim()) delete next[skill];
    if (text.trim().length > MAX_SKILL_REQUIREMENT_LENGTH || Object.keys(next).length > MAX_SKILL_REQUIREMENTS_COUNT
      || Object.values(next).reduce((total, value) => total + value.length, 0) > MAX_SKILL_REQUIREMENTS_TOTAL) {
      setSkillStorageNotice('每个技能补充要求最多 2000 字；本会话最多 20 项，总共 10000 字。');
      return false;
    }
    const saved = writeSkillRequirements(sessionId, next);
    if (!saved) {
      setSkillStorageNotice('浏览器未能保存本会话补充要求，原要求仍然生效。请重试。');
      return false;
    }
    skillRequirementsRef.current = next;
    updateSkillRequirements(next);
    setSkillStorageNotice('');
    return true;
  };
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const dragDepthRef = useRef(0);
  const inputId = useId();
  const hintId = `${inputId}-hint`;

  useEffect(() => {
    fetch('/api/upload/limits').then((r) => r.ok ? r.json() : null)
      .then((d) => { if (Number.isFinite(d?.max_mb) && d.max_mb > 0) setMaxMb(d.max_mb); }).catch(() => {});
  }, []);

  useEffect(() => {
    let stale = false;
    fetchSkills().then((skills) => {
      if (stale) return;
      if (!Array.isArray(skills)) throw new Error('Invalid skill catalogue');
      // A late or incomplete directory response must never erase a user's picks.
      setSkillCatalog(new Set(skills.map((skill) => skill.name)));
      setSkillCatalogFailed(false);
    }).catch(() => { if (!stale) setSkillCatalogFailed(true); });
    return () => { stale = true; };
  }, [sessionId]);

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
      if (onSend(trimmed, submitted.attachments, selectedSkillsRef.current,
        requirementsForSelection(skillRequirementsRef.current, selectedSkillsRef.current)) === true) clearChatDraft(sessionId, submitted);
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
      {selectedSkills.length > 0 && <div className="composer-selected-skills" role="group" aria-label="已选择的创作技能"><span className="composer-selected-label">已选技能</span>{selectedSkills.map((skill) => <SelectedSkillChip key={skill} skillName={skill}
        requirement={Object.hasOwn(skillRequirements, skill) ? skillRequirements[skill] : undefined}
        onSaveRequirement={text => saveSkillRequirement(skill, text)}
        onRemove={() => setSelectedSkills(current => current.filter(name => name !== skill))} />)}</div>}
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
      {skillNotice && <p className="composer-skills-note" role="status">{skillNotice}</p>}
      <input ref={fileInputRef} type="file" multiple hidden
        onChange={(e) => { if (e.target.files) void doUpload(e.target.files); e.target.value = ''; }} />
      <div className="composer-bar">
        <div className="composer-tools">
          <button type="button" className="composer-attach-btn" onClick={() => fileInputRef.current?.click()}
            disabled={isStreaming || uploading} aria-label={uploading ? '正在添加素材' : '添加图片或文档'} title={`添加图片或文档；支持拖入或粘贴，超过 ${maxMb}MB 的文件将存为本地素材`}>
            <IconPlus size={18} />{uploading && <span>上传中…</span>}
          </button>
          <BrushEntry compact selectedSkills={selectedSkills} onRemove={(skill) => setSelectedSkills((current) => current.filter((name) => name !== skill))} onPick={(text, skill, example) => {
            setSelectedSkills((current) => current.includes(skill) ? current : [...current, skill]);
            setInput((current) => example ? (current.trim() ? `${current}\n${text}` : text) : current.trim() ? current : text);
          }} />
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
