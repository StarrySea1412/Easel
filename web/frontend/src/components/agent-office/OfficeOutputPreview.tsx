import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { safeWorkspaceOutputHref, type WorkspaceOutput } from './workspaceOutputData';
import { canPreviewOfficeText, readOfficeTextPreview, type OfficeTextPreviewResult } from './officeTextPreview';
import './office-output-preview.css';

type MediaKind = 'image' | 'video' | 'audio';
export const OFFICE_MEDIA_PREVIEW_TIMEOUT_MS = 15_000;

function previewKind(item: WorkspaceOutput): MediaKind | null {
  if (item.kind === 'image' && /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(item.path)) return 'image';
  if (item.kind === 'video' && /\.(mp4|mov|webm|m4v|mkv)$/i.test(item.path)) return 'video';
  if (item.kind === 'audio' && /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(item.path)) return 'audio';
  return null;
}

function MediaAttempt({ kind, name, src, onRetry }: { kind: MediaKind; name: string; src: string; onRetry: () => void }) {
  const resource = useRef<HTMLImageElement | HTMLMediaElement | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [error, setError] = useState('');
  const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
  useLayoutEffect(() => {
    const element = resource.current;
    if (!element) return;
    let active = true;
    let deadline: ReturnType<typeof window.setTimeout>;
    const successEvent = kind === 'image' ? 'load' : 'loadedmetadata';
    const ready = () => {
      if (!active) return;
      window.clearTimeout(deadline);
      setState('ready');
    };
    const release = () => {
      if (!active) return;
      active = false;
      window.clearTimeout(deadline);
      element.removeEventListener(successEvent, ready);
      element.removeEventListener('error', failed);
      if (kind !== 'image') (element as HTMLMediaElement).pause();
      element.removeAttribute('src');
      // Reset the media element's resource selection to stop buffered playback
      // and release the old request. No separate full-file fetch is performed.
      if (kind !== 'image') (element as HTMLMediaElement).load();
    };
    const fail = (message: string) => {
      if (!active) return;
      release();
      setError(message);
      setState('failed');
    };
    const failed = () => fail('文件无法预览，加载失败或浏览器不支持此格式。可重试或打开原文件。');
    element.addEventListener(successEvent, ready);
    element.addEventListener('error', failed);
    deadline = window.setTimeout(() => fail(`${label}${kind === 'image' ? '' : '元数据'}加载超时，可重试或打开原文件。`), OFFICE_MEDIA_PREVIEW_TIMEOUT_MS);
    // Install this resource's listeners before assigning src, including cache
    // hits. Each retry owns a new element; departed events cannot change it.
    element.setAttribute('src', src);
    return release;
  }, [kind, label, src]);

  return <>
    {state === 'failed' ? <div className="office-media-failure"><p className="office-output-error" role="alert">{error}</p><button type="button" className="office-media-retry" onClick={onRetry}>重试媒体预览</button></div>
      : <><p className="office-media-status" role="status" aria-live="polite">{state === 'loading' ? kind === 'image' ? '正在加载图片…' : `正在读取${label}元数据…` : kind === 'image' ? '图片已加载。' : `${label}元数据已就绪，请使用播放控件。`}</p>
        {kind === 'image' ? <img ref={element => { resource.current = element; }} alt={name} />
          : kind === 'video' ? <video ref={element => { resource.current = element; }} controls preload="metadata" playsInline aria-label={`${name}视频预览`} />
            : <audio ref={element => { resource.current = element; }} controls preload="metadata" aria-label={`${name}音频预览`} />}</>}
  </>;
}

function MediaFilePreview({ item, kind, href }: { item: WorkspaceOutput; kind: MediaKind; href: string }) {
  const [attempt, setAttempt] = useState(0);
  const sessionId = useId();
  const container = useRef<HTMLElement | null>(null);
  const src = `${href}?v=${encodeURIComponent(item.modifiedAt)}&size=${item.size}&preview=${encodeURIComponent(`${sessionId}-${attempt}`)}`;
  return <section ref={container} className="office-media-preview" aria-label={`${item.name}媒体预览`} tabIndex={-1}>
    <MediaAttempt key={src} kind={kind} name={item.name} src={src} onRetry={() => {
      container.current?.focus();
      setAttempt(value => value + 1);
    }} />
  </section>;
}

function TextFilePreview({ item }: { item: WorkspaceOutput }) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<OfficeTextPreviewResult | null>(null);
  const [error, setError] = useState('');
  const { id, name, kind, path, href, modifiedAt, size } = item;
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError('');
    void readOfficeTextPreview({ id, name, kind, path, href, modifiedAt, size }, controller.signal).then(value => {
      if (!controller.signal.aborted) setResult(value);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '文本预览读取失败，请重试。');
    });
    return () => controller.abort();
  }, [id, name, kind, path, href, modifiedAt, size, revision]);
  return <section className="office-text-preview" aria-label={`${item.name}纯文本预览`}>
    <div className="office-text-preview-heading"><strong>纯文本预览</strong><span>UTF-8 · 最多 64 KiB</span></div>
    <p className="office-output-preview-note">预览为本次读取的文件内容，可能与列表快照不同。</p>
    {error ? <><p className="office-output-error" role="alert">{error}</p><button type="button" className="office-text-preview-retry" onClick={() => setRevision(value => value + 1)}>重试文本预览</button></>
      : result ? <>{result.text ? <pre tabIndex={0} aria-label={`${item.name}文本内容`}>{result.text}</pre> : <p className="office-output-preview-note" role="status">{result.bytesRead === 0 ? '文件为空。' : '文件没有可显示正文。'}</p>}
        {result.truncated && <p className="office-output-scope-note" role="status">预览已达到 64 KiB 读取上限，可能未显示完整内容；请下载原文件查看全文。</p>}</>
        : <p className="office-output-preview-note" role="status">正在限量读取文本…</p>}
  </section>;
}

export default function OfficeOutputPreview({ item }: { item: WorkspaceOutput }) {
  const kind = previewKind(item);
  const textPreview = canPreviewOfficeText(item);
  const href = safeWorkspaceOutputHref(item.path, item.href);
  if (!href) return <p className="office-output-error" role="alert">文件路径无法确认，请刷新清单。</p>;
  return <div className="office-output-preview">
    {textPreview ? <TextFilePreview item={item} />
      : kind ? <MediaFilePreview key={JSON.stringify([item.path, item.kind, item.href, item.modifiedAt, item.size])} item={item} kind={kind} href={href} />
        : <p className="office-output-preview-note">此格式不在面板中嵌入预览，可下载原文件查看。</p>}
    <div className="office-output-file-actions">
      {kind && <a href={href} target="_blank" rel="noopener noreferrer">打开原文件 ↗</a>}
      <a href={href} download={item.name}>下载文件</a>
    </div>
  </div>;
}
