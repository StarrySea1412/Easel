import { useEffect, useId, useState } from 'react';
import { safeWorkspaceOutputHref, useWorkspaceOutputs, type WorkspaceOutput, type WorkspaceOutputKind } from './workspaceOutputData';
import { canPreviewOfficeText, readOfficeTextPreview, type OfficeTextPreviewResult } from './officeTextPreview';
import './office-output-monitor.css';

export interface OfficeOutputMonitorProps {
  mode: 'demo' | 'live';
  onOpenOutputs?: () => void;
}

const KIND_LABEL: Record<WorkspaceOutputKind, string> = { image: '图片', video: '视频', audio: '音频', text: '文本', document: '文档', archive: '压缩包' };
const DEMO_FILES: WorkspaceOutput[] = [
  { id: 'demo-brief', name: '品牌提案摘要.md', path: '模拟示例 / 品牌提案摘要.md', kind: 'text', size: 2400, modifiedAt: '', href: '' },
  { id: 'demo-visual', name: '春日视觉方案.png', path: '模拟示例 / 春日视觉方案.png', kind: 'image', size: 160000, modifiedAt: '', href: '' },
  { id: 'demo-review', name: '交付检查清单.pdf', path: '模拟示例 / 交付检查清单.pdf', kind: 'document', size: 62000, modifiedAt: '', href: '' },
];

function bytes(size: number) {
  return size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`;
}
function fileTime(value: string) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '模拟时间';
}
function previewKind(item: WorkspaceOutput): 'image' | 'video' | 'audio' | null {
  if (item.kind === 'image' && /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(item.path)) return 'image';
  if (item.kind === 'video' && /\.(mp4|mov|webm|m4v|mkv)$/i.test(item.path)) return 'video';
  if (item.kind === 'audio' && /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(item.path)) return 'audio';
  return null;
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

function FilePreview({ item }: { item: WorkspaceOutput }) {
  const [failed, setFailed] = useState(false);
  const kind = previewKind(item);
  const textPreview = canPreviewOfficeText(item);
  const href = safeWorkspaceOutputHref(item.path, item.href);
  const previewUrl = href ? `${href}?v=${encodeURIComponent(item.modifiedAt)}` : null;
  if (!href) return <p className="office-output-error" role="alert">文件路径无法确认，请刷新清单。</p>;
  return <div className="office-output-preview">
    {textPreview ? <TextFilePreview item={item} /> : failed ? <p className="office-output-error" role="alert">文件无法预览，可能已移动、删除或格式不受支持。请刷新清单后重试。</p>
      : kind === 'image' ? <img src={previewUrl!} alt={item.name} onError={() => setFailed(true)} />
        : kind === 'video' ? <video src={previewUrl!} controls preload="metadata" onError={() => setFailed(true)} />
          : kind === 'audio' ? <audio src={previewUrl!} controls preload="none" onError={() => setFailed(true)} />
            : <p className="office-output-preview-note">此格式不在面板中嵌入预览，可下载原文件查看。</p>}
    <div className="office-output-file-actions">
      {kind && <a href={href} target="_blank" rel="noopener noreferrer">打开原文件 ↗</a>}
      <a href={href} download={item.name}>下载文件</a>
    </div>
  </div>;
}

export default function OfficeOutputMonitor({ mode, onOpenOutputs }: OfficeOutputMonitorProps) {
  const { snapshot, loading, error, stale, refresh } = useWorkspaceOutputs(mode === 'live');
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const titleId = useId();
  const items = mode === 'demo' ? DEMO_FILES : snapshot?.items || [];
  const visible = items.filter(item => filter === 'all' || item.kind === filter);
  const selected = visible.find(item => item.id === selectedId);
  useEffect(() => { setSelectedId(null); }, [mode]);
  return <section className="office-output-monitor" aria-labelledby={titleId}>
    <header className="office-output-heading"><div><span className="office-output-eyebrow">WORKSPACE OUTPUTS</span><h2 id={titleId}>工作区产出</h2><p>{mode === 'demo' ? '模拟文件示例，不会读取或链接真实产出。' : '展示整个工作区的近期文件，不代表由当前会话或某位员工生成。'}</p></div>
      {mode === 'live' && <button type="button" className="office-output-refresh" onClick={refresh} disabled={loading}>{loading ? '读取中…' : '刷新产出'}</button>}
    </header>
    <div className="office-output-toolbar"><span className={`office-output-source${stale ? ' is-stale' : ''}`}>{mode === 'demo' ? '模拟示例' : stale ? '上次快照 · 更新中断' : snapshot ? '真实文件元数据' : '工作区文件'}</span><label>类型<select aria-label="筛选产出类型" value={filter} onChange={event => { setFilter(event.target.value); setSelectedId(null); }}><option value="all">全部</option>{Object.entries(KIND_LABEL).map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}</select></label></div>
    {error && mode === 'live' && <p className="office-output-error" role="alert">{error}{snapshot ? ' 列表保留上次结果，文件可能已变化。' : ' 尚未取得可确认的产出清单。'}</p>}
    {mode === 'live' && snapshot?.truncated && <p className="office-output-scope-note">扫描范围有限，以下近期文件可能未覆盖全部工作区产出。</p>}
    {mode === 'live' && snapshot?.warnings.map((warning, index) => <p key={`${warning}-${index}`} className="office-output-scope-note">{warning}</p>)}
    {visible.length ? <ul className="office-output-list">{visible.map(item => <li key={item.id}>
      <button type="button" className={`office-output-file${selectedId === item.id ? ' is-selected' : ''}`} aria-pressed={selectedId === item.id} aria-label={`查看 ${item.name}`} onClick={() => setSelectedId(selectedId === item.id ? null : item.id)}>
        <span className={`office-output-kind office-output-kind--${item.kind}`} aria-hidden="true">{KIND_LABEL[item.kind]}</span>
        <span className="office-output-file-main"><strong>{item.name}</strong><span>{item.path}</span><small>{mode === 'demo' ? '示例大小' : fileTime(item.modifiedAt)} · {bytes(item.size)}</small></span>
        <span className="office-output-file-indicator" aria-hidden="true">{selectedId === item.id ? '−' : '+'}</span>
      </button>
      {selected?.id === item.id && (mode === 'demo' ? <div className="office-output-demo-preview"><strong>模拟产出示例</strong><p>这张卡片仅演示完成内容的呈现方式，不对应真实文件，也没有下载链接。</p></div> : <FilePreview key={JSON.stringify([item.id, item.path, item.href, item.modifiedAt, item.size])} item={item} />)}
    </li>)}</ul> : <p className="office-output-empty" role="status">{loading && !snapshot ? '正在读取工作区的真实文件清单…' : error && !snapshot ? '清单暂不可用，请稍后刷新。' : filter !== 'all' ? '当前快照中没有这类文件。' : '本次扫描未发现可展示的近期产出。'}</p>}
    <footer className="office-output-footer"><span>{mode === 'demo' ? '演示与真实产出分开显示' : snapshot ? `最近 ${items.length} 个文件 · 快照 ${fileTime(snapshot.observedAt)}` : '不根据员工状态推测文件归属或成品状态'}</span>{onOpenOutputs && mode === 'live' && <button type="button" onClick={onOpenOutputs}>打开内容库 ↗</button>}</footer>
    {mode === 'live' && snapshot?.detail && <p className="office-output-detail">{snapshot.detail}</p>}
  </section>;
}
