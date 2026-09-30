import { readSelectedSkills } from '../lib/selectedSkills';
import { useState, useRef, useEffect, useId, useLayoutEffect } from 'react';
import BrushEntry from './BrushEntry';
import { uploadFiles, adoptOversize, fetchSkills } from '../lib/api';
import type { UploadedFile } from '../lib/api';
import { IconArrowUp, IconStop, IconPlus, IconFile } from './icons';
import { displayName } from '../lib/skillDisplayNames';
import '../styles/chat-composer.css';

interface ChatComposerProps {
  sessionId: string;
  hero?: boolean;
  isStreaming: boolean;
  onSend: (displayText: string, attachments?: UploadedFile[], selectedSkills?: string[]) => void;
  onStop: () => void;
}


/** Shared multiline composer for the welcome and conversation views. */
export default function ChatComposer({ sessionId, hero = false, isStreaming, onSend, onStop }: ChatComposerProps) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [maxMb, setMaxMb] = useState(50);
  const skillStorageKey = `easel:selected-skills:${sessionId}`;
  const [selectedSkills, setSelectedSkills] = useState<string[]>(() => readSelectedSkills(sessionId));
  const [skillNotice, setSkillNotice] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);
  const composingRef = useRef(false);
  const dragDepthRef = useRef(0);
  const inputId = useId();
  const hintId = `${inputId}-hint`;

  useEffect(() => {
    fetch('/api/upload/limits').then((r) => r.ok ? r.json() : null)
      .then((d) => { if (Number.isFinite(d?.max_mb) && d.max_mb > 0) setMaxMb(d.max_mb); }).catch(() => {});
  }, []);

  useEffect(() => {
    try { localStorage.setItem(skillStorageKey, JSON.stringify(selectedSkills)); }
    catch { setSkillNotice('浏览器未能保存技能选择，刷新后需要重新选择。'); }
  }, [skillStorageKey, selectedSkills]);

  useEffect(() => {
    let stale = false;
    fetchSkills().then((skills) => {
      if (stale) return;
      const installed = new Set(skills.map((skill) => skill.name));
      setSelectedSkills((current) => current.filter((name) => installed.has(name)));
    }).catch(() => { if (!stale) setSkillNotice('技能列表暂时无法读取，已保留当前选择。'); });
    return () => { stale = true; };
  }, [sessionId]);

  const doUpload = async (fs: FileList | File[]) => {
    const arr = Array.from(fs);
    if (!arr.length || uploadingRef.current || isStreaming) return;
    uploadingRef.current = true;
    setUploading(true);
    setUploadError('');
    const cap = maxMb * 1024 * 1024;
    const big = arr.filter((f) => f.size > cap);
    const small = arr.filter((f) => f.size <= cap);
    const errors: string[] = [];
    try {
      if (big.length) {
        try {
          const saved = await adoptOversize(big, sessionId);
          setAttachments((a) => [...a, ...saved]);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : '大文件添加失败，请重试');
        }
      }
      if (small.length) {
        try {
          const saved = await uploadFiles(small, sessionId);
          setAttachments((a) => [...a, ...saved]);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : '素材上传失败，请重试');
        }
      }
      setUploadError(errors.join('；'));
    } finally {
      uploadingRef.current = false;
      setUploading(false);
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
  const removeAttachment = (path: string) => setAttachments((a) => a.filter((x) => x.path !== path));

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
    const trimmed = input.trim();
    if ((!trimmed && attachments.length === 0) || isStreaming || uploadingRef.current || composingRef.current) return;
    // 附件通过结构化字段发送；用户消息气泡只显示用户实际输入的文字。
    onSend(trimmed, attachments, selectedSkills);
    setInput('');
    setAttachments([]);
    setUploadError('');
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
        if (!isStreaming && !uploadingRef.current) setDragOver(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = isStreaming || uploadingRef.current ? 'none' : 'copy';
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragOver(false);
      }}
      onDrop={onDrop}>
      <div className="composer-heading">
        <div className="composer-heading-main"><label htmlFor={inputId}>{hero ? '说说你的创作想法' : '继续创作'}</label>
          {selectedSkills.length > 0 && <div className="composer-selected-skills" aria-label="已选择的创作技能">{selectedSkills.map((skill) => <span className="composer-skill-chip" key={skill} title={skill}><span>{displayName(skill)}</span><button type="button" aria-label={`移除技能 ${displayName(skill)}`} onClick={() => setSelectedSkills((current) => current.filter((name) => name !== skill))}>×</button></span>)}</div>}
        </div>
        <span>支持多行输入</span>
      </div>
      <textarea
        ref={textareaRef}
        id={inputId}
        className="chat-input"
        placeholder={dragOver ? '松手添加素材…' : hero ? '例如：帮我写一篇关于周末露营的小红书文案…' : '输入消息，继续完善你的内容…'}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onPaste={onPaste}
        aria-label="创作消息"
        aria-describedby={hintId}
        rows={hero ? 4 : 3}
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
      {skillNotice && <p className="composer-skills-note" role="status">{skillNotice}</p>}
      <input ref={fileInputRef} type="file" multiple hidden
        onChange={(e) => { if (e.target.files) void doUpload(e.target.files); e.target.value = ''; }} />
      <div className="composer-bar">
        <div className="composer-tools">
          <BrushEntry selectedSkills={selectedSkills} onRemove={(skill) => setSelectedSkills((current) => current.filter((name) => name !== skill))} onPick={(text, skill, example) => {
            setSelectedSkills((current) => current.includes(skill) ? current : [...current, skill]);
            setInput((current) => example ? (current.trim() ? `${current}\n${text}` : text) : current.trim() ? current : text);
          }} />
          <button type="button" className="composer-attach-btn" onClick={() => fileInputRef.current?.click()}
            disabled={isStreaming || uploading} title={`添加图片或文档；超过 ${maxMb}MB 的文件将存为本地素材`}>
            <IconPlus size={15} /> {uploading ? '上传中…' : '添加素材'}
          </button>
        </div>
        <span className="composer-hint" id={hintId}>
          <span className="composer-file-hint">可拖入或粘贴图片、文档</span>
          <span>{isStreaming ? '正在生成，可随时停止' : uploading ? '正在添加素材，请稍候' : 'Enter 发送 · Shift+Enter 换行'}</span>
        </span>
        {isStreaming ? (
          <button type="button" className="send-btn" onClick={onStop} title="停止生成" aria-label="停止生成"><IconStop size={15} /></button>
        ) : (
          <button type="button" className="send-btn" onClick={handleSend} disabled={(!input.trim() && !attachments.length) || uploading} title="发送" aria-label="发送消息"><IconArrowUp size={18} /></button>
        )}
      </div>
    </div>
  );

}
