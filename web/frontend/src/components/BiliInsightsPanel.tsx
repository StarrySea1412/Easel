import { useCallback, useEffect, useRef, useState } from 'react';
import { addBiliSuggestion, fetchAccountAnalytics, fetchBiliInsights } from '../lib/api';
import type { BiliSuggestion } from '../lib/api';
import '../styles/xhs-insights.css';

const METRIC_NAMES = { views: '播放', likes: '点赞', collects: '收藏', comments: '评论', shares: '分享' } as const;

function dateText(value: number | string | null | undefined): string {
  if (value == null || value === '') return '未提供';
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '未提供可靠日期' : date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function noteUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const allowed = ['bilibili.com', 'b23.tv'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    return url.protocol === 'https:' && !url.username && !url.password && allowed ? url.href : null;
  } catch { return null; }
}

function EvidenceNote({ note }: { note: BiliSuggestion['refs'][number] }) {
  const url = noteUrl(note.url);
  return <li className="xhs-evidence-note">
    <div className="xhs-evidence-title">
      {url ? <a href={url} target="_blank" rel="noopener noreferrer">{note.title || '未提供标题'} ↗</a>
        : <span>{note.title || '未提供标题'}</span>}
    </div>
    {!url && <p className="xhs-muted">未提供可核验的稿件链接</p>}
    <dl className="xhs-note-metrics">
      {Object.entries(METRIC_NAMES).map(([key, label]) => {
        const value = note.metrics?.[key as keyof typeof METRIC_NAMES];
        return <div key={key}><dt>{label}</dt><dd>{typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '缺失'}</dd></div>;
      })}
    </dl>
    <p className="xhs-muted">采集：{dateText(note.fetchedAt)}</p>
    <p className="xhs-muted">来源：{note.source?.startsWith('account_stats:') ? 'B站创作中心稿件列表' : '未提供来源说明'}</p>
  </li>;
}

function SuggestionEvidence({ suggestion }: { suggestion: BiliSuggestion }) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(8);
  return <details className="xhs-evidence" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>查看原稿件与依据（{suggestion.refs.length} 稿{suggestion.refs.length < suggestion.sampleSize ? ` / 共 ${suggestion.sampleSize} 稿` : ''}）</summary>
    {open && <><ol>{suggestion.refs.slice(0, visible).map((note) => <EvidenceNote key={note.noteId} note={note} />)}</ol>
      {visible < suggestion.refs.length && <button className="btn btn-sm xhs-more-evidence" onClick={() => setVisible((count) => count + 20)}>
        继续查看依据（已显示 {Math.min(visible, suggestion.refs.length)} / {suggestion.refs.length} 稿）
      </button>}</>}
  </details>;
}

type AddResult = { status: 'saving' | 'saved' | 'duplicate' | 'error' | 'changed'; message: string };

export default function BiliInsightsPanel({ loggedIn, onNavigateIdeas }: { loggedIn: boolean; onNavigateIdeas: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchBiliInsights>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [added, setAdded] = useState<Record<string, AddResult>>({});
  const alive = useRef(true);
  const requestSequence = useRef(0);
  const busy = loading || Boolean(action) || Object.values(added).some((item) => item.status === 'saving');

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const result = await fetchBiliInsights();
      if (alive.current && sequence === requestSequence.current) setData(result);
    } catch (reason) {
      if (alive.current && sequence === requestSequence.current) setError(reason instanceof Error ? reason.message : '读取分析数据失败，请重试。');
    } finally {
      if (alive.current && sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; requestSequence.current += 1; };
  }, [load]);

  const collect = async () => {
    if (busy || !loggedIn) return;
    setAction('collect'); setError(''); setNotice('');
    let failure = '';
    try {
      const result = await fetchAccountAnalytics('bilibili');
      if (!result.loggedIn) failure = '未能核验B站登录状态，请先到账号中心重新扫码登录。';
    } catch (reason) { failure = reason instanceof Error ? reason.message : '采集失败，已保存的快照会保留。'; }
    if (!alive.current) return;
    await load();
    if (!alive.current) return;
    if (failure) setError(failure);
    else setNotice('已读取当前登录账号的稿件数据。快照只覆盖最近一页稿件，请按实际范围查看。');
    setAction('');
  };

  const addIdea = async (suggestion: BiliSuggestion) => {
    if (busy) return;
    setAdded((previous) => ({ ...previous, [suggestion.word]: { status: 'saving', message: '' } }));
    try {
      await addBiliSuggestion(suggestion.word);
      if (alive.current) setAdded((previous) => ({ ...previous, [suggestion.word]: { status: 'saved', message: '已加入待做选题，证据随选题保存。' } }));
    } catch (reason) {
      if (!alive.current) return;
      const message = reason instanceof Error ? reason.message : '加入失败，建议和证据已保留，可重试。';
      const status = (reason as { status?: number })?.status;
      const duplicate = status === 409 && /已在选题库|重复|已存在|已加入/.test(message);
      const changed = status === 404 || status === 409;
      setAdded((previous) => ({ ...previous, [suggestion.word]: { status: duplicate ? 'duplicate' : changed ? 'changed' : 'error', message } }));
    }
  };

  const suggestions = data?.suggestions || [];
  return <section className="xhs-panel" id="bili-insights" aria-labelledby="bili-insights-title">
    <div className="xhs-panel-head">
      <div><p className="xhs-eyebrow">本人B站 · 内容回顾</p><h2 id="bili-insights-title">从已有稿件，找下一篇的方向</h2>
        <p className="xhs-muted">基于你的稿件标题、标签和实际可得指标提出探索建议。快照按平台保存在本机，覆盖最近一页稿件；不承诺流量增长。</p></div>
      <div className="xhs-panel-actions">
        <button className="btn btn-sm" disabled={busy} onClick={() => { setError(''); void load(); }}>刷新分析</button>
        <button className="btn btn-sm btn-primary" disabled={busy || !loggedIn} onClick={() => void collect()}>
          {action === 'collect' ? '正在读取本人账号…' : '采集当前登录账号'}</button>
      </div>
    </div>
    {!loggedIn && <p className="xhs-connection-hint">先到「账号中心」用B站 App 扫码登录，再回本页采集本人稿件数据。</p>}
    {error && <div className="xhs-message xhs-message-error" role="alert">{error}
      <button className="btn btn-sm" disabled={busy} onClick={() => { setError(''); void load(); }}>重新读取已存数据</button></div>}
    {notice && <p className="xhs-message" role="status">{notice}</p>}

    {loading && <p className="xhs-loading" role="status">正在读取本机保存的分析…</p>}
    {!loading && suggestions.length === 0 && <div className="xhs-empty">
      <strong>还没有可分析的稿件快照</strong>
      <p>{data?.note || '采集本人账号后，再查看探索建议。'}</p>
      {loggedIn && <button className="btn btn-primary" disabled={busy} onClick={() => void collect()} style={{ marginTop: 10 }}>
        {action === 'collect' ? '正在抓取…' : '立即抓取我的稿件数据'}
      </button>}
    </div>}
    {suggestions.length > 0 && <>
      <div className="xhs-section-title"><h3>可继续探索的主题</h3><span className="xhs-muted">{data?.sampleSize} 稿样本 · {suggestions.length} 个候选词</span></div>
      <p className="xhs-muted xhs-method-note">{data?.note}</p>
      <p className="xhs-muted">样本采集时间：{data?.window ? `${dateText(data.window.from)} 至 ${dateText(data.window.to)}` : '未提供'}</p>
      <div className="xhs-suggestions">{suggestions.map((suggestion) => {
        const result = added[suggestion.word];
        const inLibrary = result?.status === 'saved' || result?.status === 'duplicate';
        const failed = result?.status === 'error' || result?.status === 'changed';
        return <article className="xhs-suggestion" key={suggestion.word}>
          <div className="xhs-suggestion-head"><h4>{suggestion.word}</h4><span className="badge">探索性建议</span></div>
          <p>{suggestion.evidence}</p>
          <p className="xhs-muted">相关稿件 {suggestion.sampleSize} 稿 · {suggestion.metric == null ? '播放样本均值不可用' : `播放样本均值 ${suggestion.metric}`}</p>
          <SuggestionEvidence suggestion={suggestion} />
          <div className="xhs-suggestion-action">
            <button className={`btn btn-sm ${inLibrary ? '' : 'btn-primary'}`} disabled={!inLibrary && busy}
              onClick={() => {
                if (inLibrary) onNavigateIdeas();
                else if (result?.status === 'changed') { setAdded({}); void load(); }
                else void addIdea(suggestion);
              }}>
              {result?.status === 'saving' ? '正在加入…' : inLibrary ? '查看选题库 →' : result?.status === 'changed' ? '刷新当前分析' : result?.status === 'error' ? '重试加入选题库' : '加入待做选题'}</button>
            {result?.message && <p role={failed ? 'alert' : 'status'} className={failed ? 'xhs-error-text' : 'xhs-muted'}>{result.message}</p>}
          </div>
        </article>;
      })}</div>
    </>}
    <div className="xhs-data-controls"><p className="xhs-muted">分析仅存本机（按平台保存），每稿最多保留最近两次快照、12 个月保留期；清除入口在「清除分析历史」。</p></div>
  </section>;
}
