import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchTrends, createIdea } from '../lib/api';
import type { TrendGroup } from '../lib/api';
import { Sk } from './Skeleton';
import { IconFire, IconRefresh, IconBookmark, IconCheck } from './icons';

interface TrendsPageProps {
  onUseTopic: (title: string) => void;   // 一键做成内容 → 跳 chat
}

const ALL_PLATFORMS: { key: string; label: string }[] = [
  { key: 'weibo', label: '微博' },
  { key: 'douyin', label: '抖音' },
  { key: 'zhihu', label: '知乎' },
  { key: 'bilibili', label: 'B站' },
  { key: 'baidu', label: '百度' },
  { key: 'toutiao', label: '头条' },
];

function sourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch { return undefined; }
}

export default function TrendsPage({ onUseTopic }: TrendsPageProps) {
  const [selected, setSelected] = useState<string[]>(['weibo', 'douyin', 'zhihu']);
  const [groups, setGroups] = useState<TrendGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState(0);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState('');
  const pendingSaves = useRef(new Set<string>());
  const requestSeq = useRef(0);

  const save = async (title: string, source: string) => {
    if (saved.has(title) || pendingSaves.current.has(title)) return;
    pendingSaves.current.add(title);
    setSaving(new Set(pendingSaves.current));
    setSaveError('');
    try {
      await createIdea({ title, source: `${source}热搜`, status: 'pending' });
      setSaved((prev) => new Set(prev).add(title));
    } catch { setSaveError(`「${title}」收藏失败，请重试。`); }
    finally { pendingSaves.current.delete(title); setSaving(new Set(pendingSaves.current)); }
  };

  const load = useCallback((pfs: string[]) => {
    const seq = ++requestSeq.current;
    setError('');
    setGroups((current) => current.filter((group) => pfs.includes(group.platform)));
    if (pfs.length === 0) { setGroups([]); setLoading(false); setUpdated(0); return; }
    setLoading(true);
    fetchTrends(pfs.join(','), 15)
      .then((d) => { if (seq === requestSeq.current) { setGroups(d.trends); setUpdated(d.updated); } })
      .catch(() => { if (seq === requestSeq.current) setError('热点拉取失败，请重试；若持续失败，请检查网络或代理配置。'); })
      .finally(() => { if (seq === requestSeq.current) setLoading(false); });
  }, []);

  useEffect(() => { load(selected); return () => { requestSeq.current += 1; }; }, [load, selected]);

  const toggle = (k: string) =>
    setSelected((prev) => prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]);

  return (
    <div className="page-scroll trends-page">
      <div className="page-head">
        <div>
          <h1 className="page-title"><IconFire size={22} /> 热点雷达</h1>
          <p className="page-subtitle">
            多平台实时热搜，挑值得蹭的选题，一键交给 AI 做成你的内容。
            {updated > 0 && <span style={{ color: 'var(--text-tertiary)' }}> · {new Date(updated * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新</span>}
          </p>
        </div>
        <button className="btn btn-sm" onClick={() => load(selected)} disabled={loading}>
          <IconRefresh size={14} /> {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      <div className="trend-platforms">
        {ALL_PLATFORMS.map((p) => (
          <button key={p.key} className={`chip ${selected.includes(p.key) ? 'active' : ''}`} aria-pressed={selected.includes(p.key)}
            onClick={() => toggle(p.key)}>{p.label}</button>
        ))}
      </div>

      {error && <div className="notice-error" role="alert">{error}</div>}
      {saveError && <div className="notice-error" role="alert">{saveError}</div>}
      {!selected.length && <div className="empty-state">选择至少一个平台查看热点。</div>}

      {loading && groups.length === 0 ? (
        <div className="trend-grid">
          {[1, 2, 3].map((c) => (
            <div key={c} className="card trend-col">
              <div className="trend-col-head"><Sk w={64} h={13} /></div>
              <div className="trend-list">
                {Array.from({ length: 9 }).map((_, j) => (
                  <div key={j} className="trend-item"><Sk w={`${86 - (j % 4) * 9}%`} h={12} /></div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
      <div className="trend-grid">
        {groups.map((g) => (
          <div key={g.platform} className="card trend-col">
            <div className="trend-col-head">{g.label}<span className="trend-count">{g.items.length}</span></div>
            <div className="trend-list">
              {g.items.length === 0 && !loading && <div className="trend-empty">暂无数据</div>}
              {g.items.map((it, i) => {
                const url = sourceUrl(it.url);
                return (
                <div key={i} className="trend-item">
                  <span className={`trend-rank ${i < 3 ? 'top' : ''}`}>{i + 1}</span>
                  <div className="trend-main">
                    {url ? <a className="trend-title" href={url} target="_blank" rel="noopener noreferrer"
                      title={it.title}>{it.title}</a> : <span className="trend-title">{it.title}</span>}
                    {it.hot && <span className="trend-hot">{it.hot}</span>}
                  </div>
                  <button className="trend-save" title={saved.has(it.title) ? '已收藏到选题库' : '收藏到选题库'}
                    disabled={saved.has(it.title) || saving.has(it.title)}
                    aria-label={saving.has(it.title) ? `正在收藏 ${it.title}` : saved.has(it.title) ? `已收藏 ${it.title}` : `收藏 ${it.title}`}
                    onClick={() => save(it.title, g.label)}>
                    {saved.has(it.title) ? <IconCheck size={14} /> : <IconBookmark size={14} />}
                  </button>
                  <button className="trend-use" title="做成内容"
                    onClick={() => onUseTopic(it.title)}>做内容</button>
                </div>
              ); })}
            </div>
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
