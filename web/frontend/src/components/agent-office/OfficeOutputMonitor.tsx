import { NativeSelect as Select } from '../ui/Select';
import { useEffect, useId, useRef, useState } from 'react';
import { useWorkspaceOutputs, type WorkspaceOutput, type WorkspaceOutputKind } from './workspaceOutputData';
import OfficeOutputPreview from './OfficeOutputPreview';
import { acknowledgeOfficeOutputs, countOfficeOutputChanges, createOfficeOutputChanges, observeOfficeOutputs } from './officeOutputChanges';
import { selectOfficeOutputs, type OfficeOutputSort } from './officeOutputView';
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
export default function OfficeOutputMonitor(props: OfficeOutputMonitorProps) {
  // A new mode starts a new observation, including the data hook: retained live
  // snapshots must not become the baseline when returning from demo mode.
  return <OfficeOutputSession key={props.mode} {...props} />;
}

function OfficeOutputSession({ mode, onOpenOutputs }: OfficeOutputMonitorProps) {
  const { snapshot, loading, error, stale, refresh } = useWorkspaceOutputs(mode === 'live');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<OfficeOutputSort>('recent');
  const searchInput = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [changes, setChanges] = useState(createOfficeOutputChanges);
  const titleId = useId();
  const items = mode === 'demo' ? DEMO_FILES : snapshot?.items || [];
  const visible = selectOfficeOutputs(items, { query, kind: filter, sort });
  const selected = visible.find(item => item.id === selectedId);
  const counts = countOfficeOutputChanges(changes, visible);
  // The hook replaces snapshot only on success; failures retain its identity.
  useEffect(() => { if (snapshot) setChanges(previous => observeOfficeOutputs(previous, snapshot.items)); }, [snapshot]);
  return <section className="office-output-monitor" aria-labelledby={titleId}>
    <header className="office-output-heading"><div><span className="office-output-eyebrow">WORKSPACE OUTPUTS</span><h2 id={titleId}>工作区产出</h2><p>{mode === 'demo' ? '模拟文件示例，不会读取或链接真实产出。' : '展示整个工作区的近期文件，不代表由当前会话或某位员工生成。'}</p></div>
      {mode === 'live' && <button type="button" className="office-output-refresh" onClick={refresh} disabled={loading}>{loading ? '读取中…' : '刷新产出'}</button>}
    </header>
    <div className="office-output-toolbar"><span className={`office-output-source${stale ? ' is-stale' : ''}`}>{mode === 'demo' ? '模拟示例' : stale ? '上次快照 · 更新中断' : snapshot ? '真实文件元数据' : '工作区文件'}</span><label>类型<Select aria-label="筛选产出类型" value={filter} onChange={event => { setFilter(event.target.value); setSelectedId(null); }}><option value="all">全部</option>{Object.entries(KIND_LABEL).map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}</Select></label></div>
    <div className="office-output-searchbar">
      <label className="office-output-search">搜索文件名或路径<input ref={searchInput} type="search" maxLength={160} value={query} placeholder="例如：品牌、草稿、项目目录" onChange={event => { setQuery(event.target.value); setSelectedId(null); }} /></label>
      <label className="office-output-sort">排序<Select aria-label="产出排序方式" value={sort} onChange={event => setSort(event.target.value as OfficeOutputSort)}><option value="recent">最近修改</option><option value="name">文件名称</option><option value="size">文件大小</option></Select></label>
    </div>
    <div className="office-output-search-summary"><span role="status">显示 {visible.length} / {items.length} 个文件 · 仅搜索当前清单</span>{(query || filter !== 'all') && <button type="button" onClick={() => { setQuery(''); setFilter('all'); setSelectedId(null); searchInput.current?.focus(); }}>清除筛选</button>}</div>
    {mode === 'live' && <div className="office-output-observation">
      <div className="office-output-change-toolbar"><p role="status" aria-live="polite" aria-atomic="true">{changes.initialized ? `本次页面观察 · 当前列表：新发现 ${counts.new} · 更新 ${counts.updated}` : '等待首次成功快照建立观察基线。'}</p><button type="button" disabled={counts.new + counts.updated === 0} onClick={() => setChanges(previous => acknowledgeOfficeOutputs(previous, visible.map(item => item.path)))}>标记已查看</button></div>
      <p className="office-output-change-note">仅比较本次页面观察的文件路径、时间和大小；新发现不代表刚创建，更新不代表内容已验收。每次最多 20 项，切换模式或离开页面后重置。</p>
    </div>}
    {error && mode === 'live' && <p className="office-output-error" role="alert">{error}{snapshot ? ' 列表保留上次结果，文件可能已变化。' : ' 尚未取得可确认的产出清单。'}</p>}
    {mode === 'live' && snapshot?.truncated && <p className="office-output-scope-note">扫描范围有限，以下近期文件可能未覆盖全部工作区产出。</p>}
    {mode === 'live' && snapshot?.warnings.map((warning, index) => <p key={`${warning}-${index}`} className="office-output-scope-note">{warning}</p>)}
    {visible.length ? <ul className="office-output-list">{visible.map((item, index) => {
      const change = mode === 'live' ? changes.files.get(item.path)?.change : undefined;
      const changeId = `${titleId}-change-${index}`;
      return <li key={item.id}>
      <button type="button" className={`office-output-file${selectedId === item.id ? ' is-selected' : ''}${change ? ' has-change' : ''}`} aria-pressed={selectedId === item.id} aria-label={`查看 ${item.name}`} aria-describedby={change ? changeId : undefined} onClick={() => {
        if (selectedId !== item.id) setChanges(previous => acknowledgeOfficeOutputs(previous, item.path));
        setSelectedId(selectedId === item.id ? null : item.id);
      }}>
        <span className={`office-output-kind office-output-kind--${item.kind}`} aria-hidden="true">{KIND_LABEL[item.kind]}</span>
        <span className="office-output-file-main"><span className="office-output-file-title"><strong>{item.name}</strong>{change && <span id={changeId} className={`office-output-change office-output-change--${change}`}>{change === 'new' ? '新发现' : '更新'}</span>}</span><span>{item.path}</span><small>{mode === 'demo' ? '示例大小' : fileTime(item.modifiedAt)} · {bytes(item.size)}</small></span>
        <span className="office-output-file-indicator" aria-hidden="true">{selectedId === item.id ? '−' : '+'}</span>
      </button>
      {selected?.id === item.id && (mode === 'demo' ? <div className="office-output-demo-preview"><strong>模拟产出示例</strong><p>这张卡片仅演示完成内容的呈现方式，不对应真实文件，也没有下载链接。</p></div> : <OfficeOutputPreview key={JSON.stringify([item.id, item.path, item.href, item.modifiedAt, item.size])} item={item} />)}
    </li>; })}</ul> : <p className="office-output-empty" role="status">{loading && !snapshot ? '正在读取工作区的真实文件清单…' : error && !snapshot ? '清单暂不可用，请稍后刷新。' : query.trim() ? '当前清单中没有同时匹配关键词和类型的文件。可清除筛选，或打开内容库查看其他产出。' : filter !== 'all' ? '当前快照中没有这类文件。' : '本次扫描未发现可展示的近期产出。'}</p>}
    <footer className="office-output-footer"><span>{mode === 'demo' ? '演示与真实产出分开显示' : snapshot ? `最近 ${items.length} 个文件 · 快照 ${fileTime(snapshot.observedAt)}` : '不根据员工状态推测文件归属或成品状态'}</span>{onOpenOutputs && mode === 'live' && <button type="button" onClick={onOpenOutputs}>打开内容库 ↗</button>}</footer>
    {mode === 'live' && snapshot?.detail && <p className="office-output-detail">{snapshot.detail}</p>}
  </section>;
}
