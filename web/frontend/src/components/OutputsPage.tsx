import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import { fetchOutputs, fetchOutputContent, mediaUrl, deleteOutput } from '../lib/api';
import type { OutputNode, OutputMeta } from '../lib/api';
import { renderMarkdown } from '../lib/sanitize';
import { Sk } from './Skeleton';
import { IconOutputs, IconImage, IconVideo, IconMusic, IconFile, IconFolder, IconRefresh, IconChevron, IconTrash } from './icons';
import '../styles/output-covers.css';

const FILTERS: { key: string; label: string; Icon: typeof IconOutputs }[] = [
  { key: 'all', label: '全部', Icon: IconOutputs },
  { key: 'image', label: '图片', Icon: IconImage },
  { key: 'video', label: '视频', Icon: IconVideo },
  { key: 'audio', label: '音频', Icon: IconMusic },
  { key: 'text', label: '文档', Icon: IconFile },
];

function normalizeFilter(value: string): string {
  if (value === 'imagegen') return 'image';
  return FILTERS.some((item) => item.key === value) ? value : 'all';
}

const KIND_LABEL: Record<string, string> = {
  article: '文章', 'xhs-note': '小红书', video: '视频', cards: '卡片',
  poster: '海报', audio: '音频', image: '图片', other: '其他',
};
const STATUS_LABEL: Record<string, string> = { draft: '草稿', ready: '待发', published: '已发' };
const STATUS_COLOR: Record<string, string> = { draft: '#94a3b8', ready: '#d97706', published: '#16a34a' };

const badge: CSSProperties = {
  fontSize: 11, padding: '1px 7px', borderRadius: 999,
  background: 'rgba(0,0,0,0.05)', color: 'var(--text-secondary)', whiteSpace: 'nowrap',
};
const statusBadge = (s: string): CSSProperties => ({
  ...badge, background: `${STATUS_COLOR[s] || '#94a3b8'}22`, color: STATUS_COLOR[s] || '#64748b',
});

function kindIcon(kind: string | undefined, size = 30) {
  if (kind === 'video') return <IconVideo size={size} />;
  if (kind === 'audio') return <IconMusic size={size} />;
  if (kind === 'image') return <IconImage size={size} />;
  return <IconFile size={size} />;
}
const isHtml = (name: string) => /\.html?$/i.test(name);
const downloadUrl = (path: string) => `${mediaUrl(path)}?download=1`;
const kindLabel = (f: OutputNode) =>
  f.kind === 'text' ? (isHtml(f.name) ? '卡片' : '文档')
    : f.kind === 'image' ? '图片' : f.kind === 'video' ? '视频' : f.kind === 'audio' ? '音频' : '文件';

/** 递归找目录下第一张图/视频作封面缩略图。 */
function firstMedia(node: OutputNode): OutputNode | null {
  if (node.type === 'file') return (node.kind === 'image' || node.kind === 'video') ? node : null;
  for (const c of node.children || []) {
    const m = firstMedia(c);
    if (m) return m;
  }
  return null;
}

/** 展示头声明的封面 → 伪 file 节点（供 Thumb 渲染）。 */
function coverNode(m?: OutputMeta): OutputNode | null {
  if (!m?.cover) return null;
  const kind = /\.(mp4|mov|webm|mkv)$/i.test(m.cover) ? 'video' : 'image';
  return { name: 'cover', type: 'file', path: m.cover, kind } as OutputNode;
}

/** 按名称路径解析到当前目录的 children（stackNames 稳定，刷新后仍有效）。 */
function resolvePath(roots: OutputNode[], names: string[]): OutputNode[] {
  let nodes = roots;
  for (const nm of names) {
    const found = nodes.find((n) => n.type === 'dir' && n.name === nm);
    if (!found) return nodes;   // 路径失效（被删/改）→ 停在能解析到的层
    nodes = found.children || [];
  }
  return nodes;
}

function Thumb({ f, big }: { f: OutputNode | null; big?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [f?.path]);
  if (!failed && f?.kind === 'image') return <img src={mediaUrl(f.path)} alt="" loading="lazy" style={{ objectFit: 'contain' }} onError={() => setFailed(true)} />;
  if (!failed && f?.kind === 'video') return <video src={mediaUrl(f.path)} preload="metadata" muted onError={() => setFailed(true)} />;
  const sample = f?.type === 'dir' ? allFiles(f.children || [])[0] : f;
  const extension = sample?.name.includes('.') ? sample.name.split('.').at(-1)!.toUpperCase().slice(0, 10) : 'FILE';
  const label = f?.type === 'dir' ? '文件夹' : extension === 'PY' ? 'Python' : extension === 'MD' ? 'Markdown' : sample ? kindLabel(sample) : '文件';
  return <div className={`gcard-cover${sample?.preview ? ' has-text' : ''}`}>
    <div className="gcard-cover-heading">{f?.type === 'dir' ? <IconFolder size={big ? 28 : 24} /> : kindIcon(sample?.kind, 24)}<span>{label}</span><b>{extension}</b></div>
    {sample?.preview ? <pre>{sample.preview}</pre> : <div className="gcard-cover-symbol">{f?.type === 'dir' ? <IconFolder size={48} /> : kindIcon(sample?.kind, 48)}</div>}
    <span className="gcard-cover-caption">{sample?.name || f?.name || '暂无内容'}</span>
  </div>;
}

function CreatedTime({ node }: { node: OutputNode }) {
  const date = node.createdAt && Number.isFinite(node.createdAt) && node.createdAt > 0 ? new Date(node.createdAt * 1000) : null;
  return <div className="gcard-created">创建时间：{date && !Number.isNaN(date.getTime())
    ? <time dateTime={date.toISOString()}>{date.toLocaleString('zh-CN', { hour12: false })}</time> : '未记录'}</div>;
}

function allFiles(nodes: OutputNode[]): OutputNode[] {
  return nodes.flatMap((node) => node.type === 'file' ? [node] : allFiles(node.children || []));
}

const generatedImage = (node: OutputNode) => node.kind === 'image'
  && (node.source === 'imagegen' || ['AI生图', 'images'].includes(node.path.split('/')[0]));

function imageDimensions(node: OutputNode): string {
  if (!node.width || !node.height) return '';
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(node.width, node.height);
  return `${node.width} × ${node.height} · ${node.width / divisor}:${node.height / divisor}`;
}

interface OutputsPageProps {
  jumpPath?: string;
  onJumpHandled?: () => void;
  initialFilter?: string;
  onReferenceImage?: (image: {name:string;url:string;mtime:number}) => void;
  onReuseImage?: (prompt: string, size?: string) => void;
}

export default function OutputsPage({ initialFilter = 'all', jumpPath, onJumpHandled, onReuseImage, onReferenceImage }: OutputsPageProps) {
  const [roots, setRoots] = useState<OutputNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState('');
  const [stack, setStack] = useState<string[]>([]);   // 当前所在的文件夹名称路径
  const [filter, setFilter] = useState(() => normalizeFilter(initialFilter));
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<OutputNode | null>(null);
  const [content, setContent] = useState('');
  const [contentError, setContentError] = useState('');
  const [binaryContent, setBinaryContent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const reqSeq = useRef(0);
  const treeReqSeq = useRef(0);
  const drawerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    const seq = ++treeReqSeq.current;
    setTreeLoading(true);
    setTreeError('');
    fetchOutputs()
      .then((nodes) => { if (seq === treeReqSeq.current) setRoots(nodes); })
      .catch(() => { if (seq === treeReqSeq.current) setTreeError('加载产物列表失败，请重试'); })
      .finally(() => { if (seq === treeReqSeq.current) setTreeLoading(false); });
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    window.addEventListener('easel:outputs-updated', load);
    return () => window.removeEventListener('easel:outputs-updated', load);
  }, [load]);
  useEffect(() => { setFilter(normalizeFilter(initialFilter)); setStack([]); }, [initialFilter]);

  useEffect(() => {
    if (!selected) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawerRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setSelected(null); }
      if (event.key !== 'Tab') return;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], iframe, audio[controls], video[controls], [tabindex="0"]');
      const first = focusable?.[0];
      const last = focusable?.[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === drawerRef.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); previous?.focus(); };
  }, [selected]);

  const currentNodes = useMemo(() => resolvePath(roots, stack), [roots, stack]);
  const searching = filter !== 'all' || Boolean(query.trim());
  const dirs = useMemo(
    () => searching ? [] : currentNodes.filter((n) => n.type === 'dir').sort((a, b) => (b.mtime || 0) - (a.mtime || 0)),
    [currentNodes, searching]);
  const files = useMemo(() => {
    const fs = searching ? allFiles(currentNodes) : currentNodes.filter((n) => n.type === 'file');
    const term = query.trim().toLocaleLowerCase();
    return fs.filter((f) => (filter === 'all' || f.kind === filter)
      && (!term || `${f.name} ${f.path} ${f.generation?.prompt || ''}`.toLocaleLowerCase().includes(term)))
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  }, [currentNodes, filter, query, searching]);
  const generatedCount = useMemo(() => allFiles(roots).filter(generatedImage).length, [roots]);
  const filterCounts = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    const matches = allFiles(currentNodes).filter(f => !term || `${f.name} ${f.path} ${f.generation?.prompt || ''}`.toLocaleLowerCase().includes(term));
    return Object.fromEntries(FILTERS.map(f => [f.key, f.key === 'all' ? (term ? matches.length : currentNodes.length) : matches.filter(node => node.kind === f.key).length]));
  }, [currentNodes, query]);

  const atTop = stack.length === 0;
  const atProjectRoot = stack.length === 1;
  // 当前项目的展示头（进入项目后才有），用于「成品/素材」分区
  const projectMeta = useMemo(
    () => (stack.length >= 1 ? roots.find((r) => r.name === stack[0])?.meta : undefined),
    [roots, stack]);
  const deliverableSet = useMemo(
    () => new Set(atProjectRoot ? (projectMeta?.deliverablePaths || []) : []),
    [projectMeta, atProjectRoot]);
  const hasSplit = atProjectRoot && !searching && deliverableSet.size > 0;
  const deliverableFiles = useMemo(
    () => (hasSplit ? files.filter((f) => deliverableSet.has(f.path)) : []),
    [files, deliverableSet, hasSplit]);
  const restFiles = useMemo(
    () => (hasSplit ? files.filter((f) => !deliverableSet.has(f.path)) : files),
    [files, deliverableSet, hasSplit]);

  const enterDir = useCallback((name: string) => { setStack((s) => [...s, name]); setFilter('all'); setQuery(''); }, []);
  const goTo = useCallback((depth: number) => { setStack((s) => s.slice(0, depth)); setFilter('all'); setQuery(''); }, []);

  const remove = useCallback(async (node: OutputNode, e: React.MouseEvent) => {
    e.stopPropagation();
    const isDir = node.type === 'dir';
    const label = isDir ? `项目/文件夹「${node.meta?.title || node.name}」及其全部内容` : `文件「${node.name}」`;
    if (!window.confirm(`确定删除${label}？\n此操作不可恢复。`)) return;
    try {
      await deleteOutput(node.path);
      setSelected((cur) => (cur?.path === node.path ? null : cur));
      load();
    } catch (err) {
      alert((err as Error).message || '删除失败');
    }
  }, [load]);

  const open = useCallback(async (f: OutputNode) => {
    const seq = ++reqSeq.current;
    setSelected(f); setContent(''); setContentError(''); setBinaryContent(false); setLoading(false); setCopyStatus('');
    if (f.kind === 'text' && !isHtml(f.name)) {
      setLoading(true);
      try {
        const res = await fetchOutputContent(f.path);
        if (seq === reqSeq.current) { setContent(res.isBinary ? '' : res.content); setBinaryContent(Boolean(res.isBinary)); }
      } catch {
        if (seq === reqSeq.current) setContentError('文件预览加载失败，请重试或下载文件。');
      } finally { if (seq === reqSeq.current) setLoading(false); }
    }
  }, []);

  useEffect(() => {
    if (!jumpPath || treeLoading || treeError) return;
    const parts = jumpPath.split('/').filter(Boolean);
    const parent = parts.slice(0, -1);
    const node = resolvePath(roots, parent).find(n => n.name === parts.at(-1));
    setStack(node?.type === 'file' ? parent : parts);
    setFilter('all'); setQuery('');
    if (node?.type === 'file') void open(node);
    else setSelected(null);
    onJumpHandled?.();
  }, [jumpPath, roots, treeLoading, treeError, open, onJumpHandled]);

  const preview = () => {
    if (!selected) return null;
    const url = mediaUrl(selected.path);
    if (selected.kind === 'image') return <img src={url} alt={selected.name} style={{ display: 'block', width: '100%', maxHeight: '65vh', objectFit: 'contain', borderRadius: 'var(--radius)', background: 'var(--surface-2)' }} />;
    if (selected.kind === 'video') return <video src={url} controls style={{ maxWidth: '100%', borderRadius: 'var(--radius)' }} />;
    if (selected.kind === 'audio') return <audio src={url} controls style={{ width: '100%' }} />;
    if (selected.kind === 'text' && isHtml(selected.name)) return (
      <>
        {/* allow-scripts：让预览页自带的「复制到公众号」按钮(execCommand('copy'))能运行；
            allow="clipboard-write"：授予剪贴板写权限。不给 allow-same-origin —— iframe 保持
            opaque origin，脚本跑得起来但访问不到本站，安全。(修复：内嵌预览里复制按钮点了没反应) */}
        <iframe src={`${url}?v=${selected.mtime ?? 0}`} title={selected.name} sandbox="allow-scripts" allow="clipboard-write"
          style={{ width: '100%', height: '68vh', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: '#fff' }} />
        <div style={{ marginTop: 8 }}><a href={url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-start)', fontSize: 13 }}>在新标签打开 ↗</a></div>
      </>
    );
    if (selected.kind === 'text') {
      if (loading) return <div className="loading"><div className="spinner" />加载中…</div>;
      if (contentError) return <div className="notice-error" role="alert">{contentError} <button className="btn btn-sm" onClick={() => open(selected)}>重试</button> <a href={downloadUrl(selected.path)} download>下载文件</a></div>;
      if (binaryContent) return <div>此文件无法作为文本预览。<a href={downloadUrl(selected.path)} download>下载 {selected.name}</a></div>;
      if (!content) return <div className="trend-empty">文件内容为空</div>;
      return <div className="outputs-viewer-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />;
    }
    return <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>无法预览。<a href={downloadUrl(selected.path)} download style={{ color: 'var(--accent-start)' }}>下载 {selected.name}</a></div>;
  };

  /** 项目/文件夹卡片：顶层项目用展示头（标题/平台/状态/封面），嵌套子文件夹回退朴素样式。 */
  const renderDir = (d: OutputNode) => {
    const m = d.meta;
    const cover = coverNode(m) || firstMedia(d);
    return (
      <div key={d.path} className="card card-hover gcard" onClick={() => enterDir(d.name)}>
        <div className="gcard-thumb">
          <span className="gcard-kind">{m?.kind ? (KIND_LABEL[m.kind] || m.kind) : '文件夹'}</span>
          <button className="gcard-del" title="删除" onClick={(e) => remove(d, e)}><IconTrash size={14} /></button>
          <Thumb f={cover || d} big />
        </div>
        <div className="gcard-meta">
          <button className="gcard-name" title={m?.title || d.name} style={{ border: 0, background: 'none', padding: 0, color: 'inherit', textAlign: 'left', width: '100%', cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); enterDir(d.name); }}>
            {!m && <IconFolder size={13} />} {m?.title || d.name}
          </button>
          <div className="gcard-sub" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {m?.platform && <span style={badge}>{m.platform}</span>}
            {m?.status && <span style={statusBadge(m.status)}>{STATUS_LABEL[m.status] || m.status}</span>}
            <span>{d.fileCount ?? 0} 个文件</span>
          </div>
          <CreatedTime node={d} />
        </div>
      </div>
    );
  };

  const renderFile = (f: OutputNode) => (
    <div key={f.path} className="card card-hover gcard" onClick={() => open(f)}>
      <div className="gcard-thumb">
        <span className="gcard-kind">{kindLabel(f)}</span>
        <button className="gcard-del" title="删除" onClick={(e) => remove(f, e)}><IconTrash size={14} /></button>
        <Thumb f={f} />
      </div>
      <div className="gcard-meta">
        <button className="gcard-name" title={f.name} style={{ border: 0, background: 'none', padding: 0, color: 'inherit', textAlign: 'left', width: '100%', cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); void open(f); }}>{f.name}</button>
        {f.kind === 'image' && <div className="gcard-sub" style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>{generatedImage(f) && <span style={badge}>AI 生图</span>}<span>{imageDimensions(f) || '查看完整图片'}</span></div>}
        {f.generation?.prompt && <div className="gcard-sub" title={f.generation.prompt} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 4 }}>{f.generation.prompt}</div>}
        <CreatedTime node={f} />
      </div>
    </div>
  );

  const empty = dirs.length === 0 && files.length === 0;

  return (
    <div className="gallery-page">
      <div className="gallery-head">
        <div>
          <h1 className="page-title">
            <IconOutputs size={21} />
            <button className="crumb" style={{ border: 0, background: 'none', padding: 0, font: 'inherit' }} onClick={() => goTo(0)}>内容库</button>
            {stack.map((name, i) => (
              <span key={i}>
                <span className="crumb-sep">/</span>
                {i === stack.length - 1
                  ? (projectMeta?.title && i === 0 ? projectMeta.title : name)
                  : <button className="crumb" style={{ border: 0, background: 'none', padding: 0, font: 'inherit' }} onClick={() => goTo(i + 1)}>{name}</button>}
              </span>
            ))}
          </h1>
          <p className="page-subtitle">
            {searching ? `共 ${files.length} 个结果，按最新保存排序${stack.length ? ' · 当前文件夹及子目录' : ''}` : atTop
              ? `${dirs.length} 个文件夹 · ${files.length} 个文件 · ${generatedCount} 张 AI 生图。生成的图片和历史记录统一保存在这里。`
              : `${dirs.length} 个文件夹 · ${files.length} 个文件（可继续点开子文件夹）`}
          </p>
        </div>
        <button className="btn btn-sm" onClick={load} disabled={treeLoading}><IconRefresh size={14} /> {treeLoading ? '刷新中…' : '刷新'}</button>
      </div>

      {treeError && <div className="notice-error">{treeError}</div>}

      {/* 项目主题标签（进入项目根时展示） */}
      {atProjectRoot && projectMeta?.tags && projectMeta.tags.length > 0 && (
        <div className="gallery-filters" style={{ marginBottom: 4 }}>
          {projectMeta.tags.map((t) => <span key={t} style={badge}>#{t}</span>)}
        </div>
      )}

      <div className="gallery-toolbar">
        <div className="gallery-filter-options" role="group" aria-label="内容筛选">
          {stack.length > 0 && <button className="btn btn-sm" onClick={() => goTo(stack.length - 1)}>
            <span style={{ transform: 'rotate(180deg)', display: 'inline-flex' }}><IconChevron size={13} /></span> 返回上级
          </button>}
          {FILTERS.map((f) => (
            <button key={f.key} className={`chip gallery-filter-chip ${filter === f.key ? 'active' : ''}`} aria-label={`${f.label} ${filterCounts[f.key]}`} title={f.key === 'all' && !query.trim() ? '当前层级的文件与文件夹数量' : '包含当前文件夹及子目录中的匹配文件'} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}><f.Icon size={14} /><span>{f.label}</span><span className="gallery-filter-count">{filterCounts[f.key]}</span></button>
          ))}
        </div>
        <input className="gallery-search" type="search" aria-label="搜索内容库" placeholder="搜索文件名、路径或生图提示词" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>

      {empty && !treeError && !treeLoading ? (
        <div className="empty-state" style={{ height: 300 }}>
          <div className="empty-icon"><IconOutputs size={44} /></div>
          <p>{searching ? '没有找到匹配的内容，试试清空搜索或切换为「全部」' : atTop ? '还没有产物——去对话或生图工坊生成第一条内容吧' : '这个文件夹是空的'}</p>
        </div>
      ) : hasSplit ? (
        <>
          {/* 成品区 */}
          {deliverableFiles.length > 0 && (
            <>
              <div className="section-label" style={{ margin: '6px 0 8px', fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
                成品 · {deliverableFiles.length}
              </div>
              <div className="gallery-grid">{deliverableFiles.map(renderFile)}</div>
            </>
          )}
          {/* 素材 / 过程文件区 */}
          {(dirs.length > 0 || restFiles.length > 0) && (
            <>
              <div className="section-label" style={{ margin: '18px 0 8px', fontSize: 13, fontWeight: 600, color: 'var(--text-tertiary)' }}>
                素材 / 过程文件
              </div>
              <div className="gallery-grid">
                {dirs.map(renderDir)}
                {restFiles.map(renderFile)}
              </div>
            </>
          )}
        </>
      ) : (
        <div className="gallery-grid">
          {treeLoading && Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card gcard">
              <Sk h={130} r={10} style={{ display: 'block', marginBottom: 10 }} />
              <Sk w="70%" h={13} style={{ marginBottom: 8, display: 'block' }} />
              <Sk w="40%" h={11} style={{ display: 'block' }} />
            </div>
          ))}
          {!treeLoading && dirs.map(renderDir)}
          {!treeLoading && files.map(renderFile)}
        </div>
      )}

      {selected && (
        <div className="drawer-overlay" onClick={() => setSelected(null)}>
          <div ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-label={`预览 ${selected.name}`} tabIndex={-1} onClick={(e) => e.stopPropagation()} style={selected.kind === 'image' ? { width: 'min(1080px, 100vw)' } : undefined}>
            <div className="drawer-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ minWidth: 0 }}>
                <div className="skill-detail-title" style={{ fontSize: 16 }}>{selected.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3, fontFamily: "'SF Mono','Consolas',monospace" }}>{selected.path}</div>
              </div>
              <button className="icon-btn" aria-label="关闭预览" onClick={() => setSelected(null)}>×</button>
            </div>
            <div className="drawer-body">
              {preview()}
              {selected.kind === 'image' && <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 14, lineHeight: 1.7 }}>
                {onReferenceImage&&<button className="btn btn-sm" onClick={()=>onReferenceImage({name:selected.name,url:mediaUrl(selected.path),mtime:selected.mtime||0})}>用作参考图 · 图生图</button>}<div>{imageDimensions(selected)}{selected.mtime ? ` · 保存于 ${new Date(selected.mtime * 1000).toLocaleString('zh-CN')}` : ''}</div>
                {selected.generation?.size && <div>请求尺寸：{selected.generation.size}{selected.generation.model ? ` · 模型：${selected.generation.model}` : ''}</div>}
                {selected.generation?.prompt ? <>
                  <div style={{ fontWeight: 600, marginTop: 12 }}>生成提示词</div>
                  <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '6px 0 10px' }}>{selected.generation.prompt}</p>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn btn-sm" onClick={async () => {
                      try { await navigator.clipboard.writeText(selected.generation!.prompt); setCopyStatus('提示词已复制'); }
                      catch { setCopyStatus('复制失败，请选择上方提示词手动复制'); }
                    }}>复制提示词</button>
                    {onReuseImage && <button className="btn btn-sm" onClick={() => onReuseImage(selected.generation!.prompt, selected.generation?.size)}>用此提示词再创作</button>}
                    <span role="status">{copyStatus}</span>
                  </div>
                </> : generatedImage(selected) && <p>这张历史图片未保存提示词，可查看或下载完整原图。</p>}
              </div>}
            </div>
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <a className="btn btn-sm" href={mediaUrl(selected.path)} target="_blank" rel="noreferrer">打开原文件 ↗</a>
              <a className="btn btn-sm" href={downloadUrl(selected.path)} download={selected.name}>下载文件</a>
              <button className="btn btn-sm btn-danger" onClick={(e) => remove(selected, e)}><IconTrash size={13} /> 删除此文件</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
