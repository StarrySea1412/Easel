import { useState, useRef } from 'react';
import { createIdea } from '../lib/api';
import { useTrends } from '../hooks/useTrends';
import { useTrendSourceSelection } from '../hooks/useTrendSourceSelection';
import { TREND_SOURCES } from '../lib/trendPreferences';
import TrendSourcePicker from './TrendSourcePicker';
import PlatformIcon from './PlatformIcon';
import { Sk } from './Skeleton';
import { IconFire, IconRefresh, IconBookmark, IconCheck } from './icons';
import '../styles/trends.css';

interface TrendsPageProps { onUseTopic: (title: string) => void; }

function sourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function timestamp(value: number) {
  return new Date(value * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function TrendSkeleton({ label }: { label: string }) {
  return <div className="trend-skeleton" role="status" aria-label={`正在获取${label}`}>
    <span className="trend-loading-label">正在获取{label}…</span>
    {Array.from({ length: 7 }, (_, index) => <div className="trend-skeleton-row" key={index} aria-hidden="true">
      <Sk w={20} h={20} r={5} />
      <div><Sk w={`${94 - (index % 3) * 12}%`} h={13} /><Sk w="35%" h={9} /></div>
    </div>)}
  </div>;
}

export default function TrendsPage({ onUseTopic }: TrendsPageProps) {
  const selection = useTrendSourceSelection();
  const { selected } = selection;
  const { entries, loading, refresh, retry } = useTrends(selected);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState('');
  const pendingSaves = useRef(new Set<string>());

  const save = async (title: string, source: string) => {
    if (saved.has(title) || pendingSaves.current.has(title)) return;
    pendingSaves.current.add(title); setSaving(new Set(pendingSaves.current)); setSaveError('');
    try {
      await createIdea({ title, source, status: 'pending' });
      setSaved(previous => new Set(previous).add(title));
    } catch { setSaveError(`「${title}」收藏失败，请重试。`); }
    finally { pendingSaves.current.delete(title); setSaving(new Set(pendingSaves.current)); }
  };

  return <div className="page-scroll trends-page">
    <div className="page-head">
      <div>
        <h1 className="page-title"><IconFire size={22} /> 热点雷达</h1>
        <p className="page-subtitle">浏览平台热榜、科技资讯与社区讨论，找到值得做的选题。</p>
      </div>
      <button className="btn btn-sm" onClick={refresh} disabled={loading || !selected.length}>
        <IconRefresh size={14} /> {loading ? '获取中…' : '全部刷新'}
      </button>
    </div>

    <TrendSourcePicker selection={selection} />
    <p className="trend-explainer">各来源独立获取，正常结果缓存 5 分钟；获取时间不代表平台发布时间。来源异常时会标明原因及旧数据。</p>
    {saveError && <div className="notice-error" role="alert">{saveError}</div>}
    {!selected.length && <div className="empty-state">选择至少一个来源查看选题。</div>}

    <div className="trend-grid">
      {selected.map(platform => {
        const state = entries[platform];
        const group = state?.group;
        const label = group?.label || TREND_SOURCES.find(item => item.key === platform)!.label;
        const busy = state?.loading !== false;
        const issue = state?.error || group?.error?.message;
        const items = group?.items || [];
        const stale = group?.status === 'stale' || (!!state?.error && items.length > 0);
        const source = group?.source;
        const sourceLink = source && sourceUrl(source.url);
        return <section key={platform} className="card trend-col" aria-label={`${label}来源`} aria-busy={busy}>
          <div className="trend-col-head">
            <span className="trend-source-heading"><span aria-hidden="true"><PlatformIcon platform={platform} name={label} className="trend-platform-icon" /></span>{label}</span>{items.length > 0 && <span className="trend-count">{items.length} 条</span>}
            <button className="trend-refresh" disabled={busy} onClick={() => retry(platform)} aria-label={`刷新${label}`}>
              <IconRefresh size={13} />{busy ? '获取中' : '刷新'}
            </button>
          </div>
          {source && <div className="trend-source">
            <span>{source.kind}</span><span> · </span>
            {sourceLink ? <a href={sourceLink} target="_blank" rel="noopener noreferrer">{source.name}</a> : <span>{source.name}</span>}
          </div>}
          {group?.fetchedAt && <div className={`trend-time${stale ? ' stale' : ''}`}>
            {stale ? '上次可用数据' : group.status === 'cached' ? '缓存数据' : '获取于'} · <time dateTime={new Date(group.fetchedAt * 1000).toISOString()}>{timestamp(group.fetchedAt)}</time>
            {group.sourceUpdatedAt ? <span> · 来源更新 {timestamp(group.sourceUpdatedAt)}</span> : <span> · 来源未提供榜单时间</span>}
          </div>}
          {busy && items.length === 0 ? <TrendSkeleton label={label} /> : <>
            {issue && <div className="trend-source-error" role="status">
              <strong>{stale ? '暂时无法更新，保留上次结果' : '此来源暂不可用'}</strong>
              <p>{issue}</p>
              {group?.checkedAt && <span>最近检查 {timestamp(group.checkedAt)}{group.nextRetryAt ? ` · 建议 ${timestamp(group.nextRetryAt)} 后重试` : ' · 短时间内重试复用检查结果'}</span>}
              <button className="btn btn-sm" disabled={busy} onClick={() => retry(platform)}>{busy ? '重试中…' : `重试${label}`}</button>
            </div>}
            {!items.length && !issue && <div className="trend-empty">此来源暂未返回条目，可稍后刷新。</div>}
            <div className="trend-list">
              {items.map((item, index) => {
                const url = sourceUrl(item.url);
                return <div key={`${item.title}-${index}`} className="trend-item">
                  <span className={`trend-rank ${index < 3 ? 'top' : ''}`}>{index + 1}</span>
                  <div className="trend-main">
                    {url ? <a className="trend-title" href={url} target="_blank" rel="noopener noreferrer" title={item.title}>{item.title}</a> : <span className="trend-title">{item.title}</span>}
                    {(item.hot || item.publishedAt || item.createdAt || item.linkKind === 'search') && <span className="trend-hot">
                      {[item.hot, item.createdAt ? `提问于 ${timestamp(item.createdAt)}` : item.publishedAt ? `发布于 ${timestamp(item.publishedAt)}` : '', item.linkKind === 'search' ? '打开平台搜索' : ''].filter(Boolean).join(' · ')}
                    </span>}
                  </div>
                  <button className="trend-save" title={saved.has(item.title) ? '已收藏到选题库' : '收藏到选题库'}
                    disabled={saved.has(item.title) || saving.has(item.title)}
                    aria-label={saving.has(item.title) ? `正在收藏 ${item.title}` : saved.has(item.title) ? `已收藏 ${item.title}` : `收藏 ${item.title}`}
                    onClick={() => save(item.title, `${label} · ${source?.kind || '热点'}`)}>
                    {saved.has(item.title) ? <IconCheck size={14} /> : <IconBookmark size={14} />}
                  </button>
                  <button className="trend-use" title="做成内容" onClick={() => onUseTopic(item.title)}>做内容</button>
                </div>;
              })}
            </div>
          </>}
        </section>;
      })}
    </div>
  </div>;
}
