import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { mediaUrl, type UploadedFile } from '../lib/api';
import { useModalFocus } from '../hooks/useModalFocus';
import { IconFile, IconImage, IconMusic, IconVideo } from './icons';

function fileKind(name: string) {
  const extension = name.split('.').at(-1)?.toLowerCase() || '';
  const kind = /^(png|jpe?g|webp|gif|bmp|avif|svg)$/.test(extension) ? 'image'
    : /^(mp4|mov|webm|mkv|avi|m4v)$/.test(extension) ? 'video'
    : /^(mp3|wav|m4a|ogg|aac|flac)$/.test(extension) ? 'audio' : 'file';
  return { kind, format: extension.toUpperCase() || '文件' };
}

function AttachmentCard({ file, onPreview, onRemove }: { file: UploadedFile; onPreview: () => void; onRemove: () => void }) {
  const { kind, format } = fileKind(file.name);
  const [failed, setFailed] = useState(false);
  const Icon = kind === 'image' ? IconImage : kind === 'video' ? IconVideo : kind === 'audio' ? IconMusic : IconFile;
  return <div className={`attach-chip composer-attachment-card is-${kind}`}>
    <button type="button" className="composer-attachment-open" onClick={onPreview} aria-label={`查看附件 ${file.name}`} title={file.name}>
      <span className="composer-attachment-visual">
        {kind === 'image' && !failed ? <img src={mediaUrl(file.path)} alt={file.name} loading="lazy" onError={() => setFailed(true)}/>
          : kind === 'video' && !failed ? <><video src={mediaUrl(file.path)} preload="metadata" muted playsInline onError={() => setFailed(true)}/><span className="composer-attachment-play"><IconVideo size={20}/></span></>
          : <Icon size={22}/>}
      </span>
      <span className="composer-attachment-copy"><span className="attach-name">{file.name}</span><small>{format}{kind === 'image' || kind === 'video' ? ' · 点击预览' : ' · 点击查看'}</small></span>
    </button>
    <button type="button" className="attach-x" onClick={onRemove} title="移除附件" aria-label={`移除 ${file.name}`}>×</button>
  </div>;
}

function AttachmentPreview({ file, onClose }: { file: UploadedFile; onClose: () => void }) {
  const modal = useModalFocus(true, onClose);
  const { kind, format } = fileKind(file.name);
  const [failed, setFailed] = useState(false);
  return createPortal(<div className="composer-attachment-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={modal} className="composer-attachment-preview" role="dialog" aria-modal="true" aria-label={`附件预览 ${file.name}`} tabIndex={-1}>
      <header><div><strong>{file.name}</strong><small>{format}</small></div><button type="button" className="icon-btn" onClick={onClose} aria-label="关闭附件预览">×</button></header>
      <div className="composer-attachment-preview-body">
        {failed ? <p role="status">预览暂时无法加载，可以下载原文件查看。</p>
          : kind === 'image' ? <img src={mediaUrl(file.path)} alt={file.name} onError={() => setFailed(true)}/>
          : kind === 'video' ? <video src={mediaUrl(file.path)} controls preload="metadata" onError={() => setFailed(true)}/>
          : kind === 'audio' ? <audio src={mediaUrl(file.path)} controls preload="metadata" onError={() => setFailed(true)}/>
          : format === 'PDF' ? <iframe src={mediaUrl(file.path)} title={file.name} sandbox=""/>
          : <div className="composer-attachment-document"><IconFile size={44}/><p>{file.name}</p><small>下载后用对应应用查看文件内容。</small></div>}
      </div>
      <footer><a href={mediaUrl(file.path)} download={file.name}>下载原文件 ↗</a><button type="button" className="btn btn-sm" onClick={onClose}>关闭</button></footer>
    </div>
  </div>, document.body);
}

export default function ComposerAttachments({ files, onRemove }: { files: UploadedFile[]; onRemove: (path: string) => void }) {
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const close = useCallback(() => setPreviewPath(null), []);
  const preview = files.find(file => file.path === previewPath);
  return <><div className="composer-attachments" aria-label="已添加的素材">
    {files.map(file => <AttachmentCard key={file.path} file={file} onPreview={() => setPreviewPath(file.path)} onRemove={() => onRemove(file.path)}/>)}
  </div>{preview && <AttachmentPreview key={preview.path} file={preview} onClose={close}/>}</>;
}
