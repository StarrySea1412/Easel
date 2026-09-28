import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addXhsSuggestion, clearXhsAnalysis, fetchAccountAnalytics, fetchXhsInsights, importXhsRecords,
} from '../lib/api';
import type { XhsImportPayload, XhsInsights, XhsNoteEvidence, XhsSuggestion } from '../lib/api';
import '../styles/xhs-insights.css';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const METRIC_NAMES = { likes: '点赞', collects: '收藏', comments: '评论' } as const;
const FIELD_NAMES: Record<string, string> = {
  ...METRIC_NAMES, publish: '发布时间', published_at: '发布时间', publishedAt: '发布时间',
  fetched_at: '采集时间', fetchedAt: '采集时间', tags: '标签', url: '原文链接',
  originalUrl: '原文链接', title: '标题', account_id: '账号归属',
};

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
    const allowed = ['xiaohongshu.com', 'xhslink.com'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    return url.protocol === 'https:' && !url.username && !url.password && allowed ? url.href : null;
  } catch { return null; }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function EvidenceNote({ note }: { note: XhsNoteEvidence }) {
  const url = noteUrl(note.url);
  return <li className="xhs-evidence-note">
    <div className="xhs-evidence-title">
      {url ? <a href={url} target="_blank" rel="noopener noreferrer">{note.title || '未提供标题'} ↗</a>
        : <span>{note.title || '未提供标题'}</span>}
    </div>
    {!url && <p className="xhs-muted">未提供可核验的原文链接</p>}
    <dl className="xhs-note-metrics">
      {Object.entries(METRIC_NAMES).map(([key, label]) => {
        const value = note.metrics?.[key as keyof typeof METRIC_NAMES];
        return <div key={key}><dt>{label}</dt><dd>{typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '缺失'}</dd></div>;
      })}
    </dl>
    <p className="xhs-muted">发布：{note.publishedAt ? dateText(note.publishedAt) : note.publish || '未提供可靠日期'}</p>
    <p className="xhs-muted">采集：{dateText(note.fetchedAt)}{note.importedAt ? ` · 导入：${dateText(note.importedAt)}` : ''}</p>
    <p className="xhs-muted">来源：{note.source?.startsWith('user_export:') ? '用户导出的记录' : note.source?.startsWith('account_stats:') ? '本人笔记管理页' : '未提供来源说明'}</p>
    {note.tags?.length > 0 && <p className="xhs-tags">{note.tags.map((tag) => `#${tag}`).join(' ')}</p>}
    {Object.keys(note.missingFields || {}).length > 0 && <ul className="xhs-missing-fields">
      {Object.entries(note.missingFields).map(([key, reason]) => <li key={key}>{FIELD_NAMES[key] || FIELD_NAMES[key.replace(/^metrics\./, '')] || '数据说明'}：{reason}</li>)}
    </ul>}
  </li>;
}

function SuggestionEvidence({ suggestion }: { suggestion: XhsSuggestion }) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(8);
  return <details className="xhs-evidence" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>查看原笔记与依据（{suggestion.refs.length} 篇{suggestion.refs.length < suggestion.sampleSize ? ` / 共 ${suggestion.sampleSize} 篇` : ''}）</summary>
    {open && <><ol>{suggestion.refs.slice(0, visible).map((note) => <EvidenceNote key={note.noteId} note={note} />)}</ol>
      {visible < suggestion.refs.length && <button className="btn btn-sm xhs-more-evidence" onClick={() => setVisible((count) => count + 20)}>
        继续查看依据（已显示 {Math.min(visible, suggestion.refs.length)} / {suggestion.refs.length} 篇）
      </button>}</>}
  </details>;
}

type ImportPreview = { name: string; payload: XhsImportPayload };
type AddResult = { status: 'saving' | 'saved' | 'duplicate' | 'changed' | 'error'; message: string };

export default function XhsInsightsPanel({ loggedIn, onNavigateIdeas }: {
  loggedIn: boolean;
  onNavigateIdeas: () => void;
}) {
  const [data, setData] = useState<XhsInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [added, setAdded] = useState<Record<string, AddResult>>({});
  const alive = useRef(true);
  const requestSequence = useRef(0);
  const fileSequence = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const accountId = data?.account?.id;
  const busy = loading || Boolean(action) || Object.values(added).some((item) => item.status === 'saving');

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const result = await fetchXhsInsights();
      if (alive.current && sequence === requestSequence.current) setData(result);
    } catch (reason) {
      if (alive.current && sequence === requestSequence.current) setError(errorText(reason, '读取分析数据失败，请重试。'));
    } finally {
      if (alive.current && sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; requestSequence.current += 1; fileSequence.current += 1; };
  }, [load]);

  useEffect(() => { setAdded({}); setConfirmClear(false); }, [accountId]);

  const collect = async () => {
    if (busy || !loggedIn) return;
    setAction('collect'); setError(''); setNotice(''); setConfirmClear(false);
    let failure = '';
    try {
      const result = await fetchAccountAnalytics('xiaohongshu');
      if (!result.loggedIn) failure = '未能核验小红书登录状态，请先重新登录，再采集本人数据。';
    } catch (reason) { failure = errorText(reason, '采集失败，已有样本会保留。'); }
    if (!alive.current) return;
    await load();
    if (!alive.current) return;
    if (failure) setError(failure);
    else setNotice('已读取当前登录账号的数据。请按下方实际覆盖范围查看。');
    setAction('');
  };

  const chooseFile = (file?: File) => {
    if (!file) return;
    setError(''); setNotice(''); setImportPreview(null);
    const sequence = ++fileSequence.current;
    if (file.size > MAX_IMPORT_BYTES) { setError('文件超过 5 MB，请缩小导出范围后重试。'); return; }
    const reader = new FileReader();
    reader.onerror = () => { if (alive.current) setError('无法读取这个文件，请重新选择。'); };
    reader.onload = () => {
      if (!alive.current || sequence !== fileSequence.current) return;
      try {
        const value = JSON.parse(String(reader.result)) as Record<string, unknown>;
        if (!value || typeof value !== 'object' || typeof value.accountId !== 'string' || !value.accountId.trim()
          || !Array.isArray(value.records) || value.records.length < 1 || value.records.length > 2000) {
          throw new Error('JSON 需要 accountId 和 1–2000 条 records；请按下方格式准备。');
        }
        if (value.platform && value.platform !== 'xiaohongshu') throw new Error('请选择小红书本人账号的导出文件。');
        const records: XhsImportPayload['records'] = value.records.map((record: unknown) => {
          if (!record || typeof record !== 'object' || typeof (record as Record<string, unknown>).title !== 'string') {
            throw new Error('每条记录都需要 title 标题。');
          }
          const r = record as XhsImportPayload['records'][number];
          return { account_id: r.account_id, accountId: r.accountId,
            note_id: r.note_id, title: r.title, tags: r.tags, publish: r.publish, url: r.url,
            fetched_at: r.fetched_at, metrics: r.metrics };
        });
        setImportPreview({ name: file.name, payload: { accountId: value.accountId.trim(),
          accountName: typeof value.accountName === 'string' ? value.accountName : '', records } });
      } catch (reason) { setError(errorText(reason, '文件不是可读取的 JSON。')); }
    };
    reader.readAsText(file, 'UTF-8');
  };

  const importRecords = async () => {
    if (!importPreview || busy) return;
    setAction('import'); setError(''); setNotice(''); setConfirmClear(false);
    try {
      const result = await importXhsRecords(importPreview.payload);
      if (!alive.current) return;
      setNotice(`已导入 ${result.importedCount} 条记录，当前展示这份导入账号的数据；账号归属未经登录核验。`);
      setImportPreview(null);
      if (fileInput.current) fileInput.current.value = '';
      await load();
    } catch (reason) { if (alive.current) setError(errorText(reason, '导入失败，文件预览已保留，可修正后重试。')); }
    finally { if (alive.current) setAction(''); }
  };

  const clear = async () => {
    if (!accountId || busy) return;
    setAction('clear'); setError(''); setNotice('');
    try {
      await clearXhsAnalysis(accountId);
      if (!alive.current) return;
      setNotice('已清除此账号的分析历史；登录状态和已加入选题库的内容保持不变。');
      setConfirmClear(false); setAdded({});
      await load();
    } catch (reason) { if (alive.current) setError(errorText(reason, '清除失败，原有分析数据仍可查看。')); }
    finally { if (alive.current) setAction(''); }
  };

  const addIdea = async (suggestion: XhsSuggestion) => {
    if (!accountId || busy) return;
    setAdded((previous) => ({ ...previous, [suggestion.word]: { status: 'saving', message: '' } }));
    try {
      await addXhsSuggestion(suggestion.word, accountId);
      if (alive.current) setAdded((previous) => ({ ...previous, [suggestion.word]: { status: 'saved', message: '已加入待做选题，证据随选题保存。' } }));
    } catch (reason) {
      if (!alive.current) return;
      const message = errorText(reason, '加入失败，建议和证据已保留，可重试。');
      const status = (reason as { status?: number })?.status;
      const duplicate = status === 409 && /已在选题库|重复|已存在|已加入/.test(message);
      const changed = status === 404 || status === 409;
      setAdded((previous) => ({ ...previous, [suggestion.word]: { status: duplicate ? 'duplicate' : changed ? 'changed' : 'error', message } }));
    }
  };

  const suggestions = data?.suggestions || [];
  return <section className="xhs-panel" id="xhs-insights" aria-labelledby="xhs-insights-title">
    <div className="xhs-panel-head">
      <div><p className="xhs-eyebrow">本人小红书 · 内容回顾</p><h2 id="xhs-insights-title">从已有笔记，找下一篇的方向</h2>
        <p className="xhs-muted">基于你的标题、标签和实际可得指标提出探索建议。这里不提供公域热榜，也不承诺流量增长。</p></div>
      <div className="xhs-panel-actions">
        <button className="btn btn-sm" disabled={busy} onClick={() => { setError(''); void load(); }}>刷新分析</button>
        <button className="btn btn-sm btn-primary" disabled={busy || !loggedIn} onClick={() => void collect()}>
          {action === 'collect' ? '正在读取本人账号…' : '采集当前登录账号'}</button>
      </div>
    </div>
    {!loggedIn && <p className="xhs-connection-hint">先在上方登录小红书，再采集本人账号；也可以导入自己导出的笔记记录。</p>}
    {error && <div className="xhs-message xhs-message-error" role="alert">{error}
      <button className="btn btn-sm" disabled={busy} onClick={() => { setError(''); void load(); }}>重新读取已存数据</button></div>}
    {notice && <p className="xhs-message" role="status">{notice}</p>}

    {data?.account && <div className="xhs-account-strip">
      <div><strong>{data.account.name || data.account.externalId}</strong><span className="xhs-muted">账号 ID：{data.account.externalId || data.account.id}</span></div>
      <span className={`badge ${data.account.source === 'live' && data.account.verified ? 'badge-ok' : ''}`}>
        {data.account.source === 'import' ? '手动导入 · 归属未核验' : data.account.verified ? '已核验登录账号采集' : '账号归属未核验'}</span>
    </div>}
    {data?.stale && <p className="xhs-message xhs-message-warning" role="status">数据已过期：以下保留上次成功保存的样本，不能代表当前账号表现。采集成功后再核对覆盖范围。</p>}

    {data?.account && data.coverage && <div className="xhs-coverage">
      <dl><div><dt>样本范围</dt><dd>{data.coverage.scope === 'imported' ? '这份导入文件' : '本人页面可见范围'}</dd></div>
        <div><dt>已保存笔记</dt><dd>{data.coverage.storedNotes ?? data.sampleSize} 篇</dd></div>
        <div><dt>本次观察</dt><dd>{data.coverage.observedNotes} 篇{data.coverage.scope === 'visible_page' && data.coverage.pagesFetched ? ` · ${data.coverage.pagesFetched} 页` : ''}</dd></div></dl>
      <p>{data.coverage.reason || '当前只覆盖已取得的记录，不能视为账号的完整历史。'}</p>
      {Boolean(data.coverage.omittedNotes) && <p className="xhs-muted">另有 {data.coverage.omittedNotes} 篇缺少可靠笔记标识，未计入分析。</p>}
      <p className="xhs-muted">样本采集时间：{data.window ? `${dateText(data.window.from)} 至 ${dateText(data.window.to)}` : '未提供；导入时间不等于采集时间'}</p>
      <p className="xhs-muted">缺失指标按“缺失”展示。点赞受发布时间和曝光机会影响，样本均值不表示某个词带来增长。</p>
    </div>}

    {loading && <p className="xhs-loading" role="status">正在读取本机保存的分析…</p>}
    {!loading && suggestions.length === 0 && <div className="xhs-empty">
      <strong>{data?.accountRequired ? '还没有可核验的本人分析账号' : '暂时没有足够的候选词证据'}</strong>
      <p>{data?.note || '采集本人账号，或导入自己的标题与标签记录后，再查看探索建议。'}</p>
    </div>}
    {suggestions.length > 0 && <>
      <div className="xhs-section-title"><h3>可继续探索的主题</h3><span className="xhs-muted">{data?.sampleSize} 篇样本 · {suggestions.length} 个候选词</span></div>
      <p className="xhs-muted xhs-method-note">{data?.note}</p>
      <div className="xhs-suggestions">{suggestions.map((suggestion) => {
        const result = added[suggestion.word];
        const inLibrary = result?.status === 'saved' || result?.status === 'duplicate';
        const failed = result?.status === 'error' || result?.status === 'changed';
        return <article className="xhs-suggestion" key={`${accountId}:${suggestion.word}`}>
          <div className="xhs-suggestion-head"><h4>{suggestion.word}</h4><span className="badge">探索性建议</span></div>
          <p>{suggestion.evidence}</p>
          <p className="xhs-muted">相关笔记 {suggestion.sampleSize} 篇 · {suggestion.metric == null ? '点赞样本均值不可用' : `点赞样本均值 ${suggestion.metric}`}</p>
          <SuggestionEvidence suggestion={suggestion} />
          <div className="xhs-suggestion-action">
            <button className={`btn btn-sm ${inLibrary ? '' : 'btn-primary'}`} disabled={!inLibrary && (busy || !accountId)}
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

    <details className="xhs-import">
      <summary>导入自己导出的笔记 JSON</summary>
      <p>文件先在本机预览，点击确认后才写入本地分析。最多 5 MB / 2000 条。导入数据与登录采集分开保存；请仅导入自己的账号。</p>
      <label className="xhs-file-label">选择导出文件<input ref={fileInput} type="file" accept=".json,application/json" disabled={busy}
        onChange={(event) => chooseFile(event.target.files?.[0])} /></label>
      {importPreview && <div className="xhs-import-preview">
        <strong>{importPreview.name}</strong><p>账号：{importPreview.payload.accountName || importPreview.payload.accountId} · ID {importPreview.payload.accountId}</p>
        <p>{importPreview.payload.records.length} 条记录；导入后将展示这份账号数据，归属未经登录核验。</p>
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void importRecords()}>{action === 'import' ? '正在导入…' : '确认导入这份本人记录'}</button>
      </div>}
      <details className="xhs-import-format"><summary>查看 JSON 格式</summary><p>以下仅为格式示例，请替换为真实账号和笔记 ID。每篇需要标题，以及可靠的 note_id 或原笔记 URL。缺失的指标请用 null；不要用 0 代替未知。fetched_at 是实际采集时间的 Unix 秒，可省略。</p>
        <pre>{JSON.stringify({ accountId: 'your_account_id', accountName: '你的昵称', records: [{ note_id: 'your_note_id', title: '我的通勤穿搭记录', tags: ['通勤穿搭'], publish: '2026-09-20', url: 'https://www.xiaohongshu.com/explore/your_note_id', metrics: { likes: 12, collects: null, comments: 0 } }] }, null, 2)}</pre>
      </details>
    </details>

    <div className="xhs-data-controls"><p className="xhs-muted">分析仅存本机，保留最多 {data?.retention?.days || 365} 天，每篇最多 {data?.retention?.snapshotsPerNote || 2} 次快照。</p>
      {accountId && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirmClear(true)}>清除此账号分析数据</button>}</div>
    {confirmClear && data?.account && <div className="xhs-clear-confirm" role="alert">
      <p>确认清除「{data.account.name || data.account.externalId}」的本地分析历史？这会删除该账号的笔记快照及建议，保留登录状态、其他账号数据和已加入的选题。如需删除已入库内容，请到选题库操作。</p>
      <div><button className="btn btn-sm" disabled={busy} onClick={() => setConfirmClear(false)}>取消</button>
        <button className="btn btn-sm xhs-danger-button" disabled={busy} onClick={() => void clear()}>{action === 'clear' ? '正在清除…' : '确认清除此账号'}</button></div>
    </div>}
  </section>;
}
