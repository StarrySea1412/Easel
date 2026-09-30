import { useEffect, useRef, useState } from 'react';
import { fetchAccountAnalytics } from '../lib/api';
import type { AccountAnalysis } from '../lib/accountAnalysis';
import Select from './ui/Select';
import '../styles/platform-analysis.css';

export const OTHER_ANALYSIS_PLATFORMS = new Set(['douyin', 'kuaishou', 'zhihu', 'weixin-channels', 'bilibili', 'wechat-oa']);
type Platform = { platform: string; name: string; loggedIn: boolean; identity: string };

export default function PlatformAnalysisPanel({ accounts, platform, onPlatformChange, revision, showPlatformPicker = true }: {
  accounts: Platform[]; platform: string; onPlatformChange: (platform: string) => void; revision: number; showPlatformPicker?: boolean;
}) {
  const [data, setData] = useState<AccountAnalysis | null>(null);
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const sequence = useRef(0);
  const pending = useRef(false);
  const current = accounts.find((account) => account.platform === platform);
  useEffect(() => {
    sequence.current += 1; pending.current = false;
    setData(null); setNickname(''); setError(''); setBusy(false); setSearch('');
    return () => { sequence.current += 1; };
  }, [platform, current?.identity, current?.loggedIn, revision]);

  const collect = async () => {
    if (!current?.loggedIn || pending.current) return;
    pending.current = true;
    const request = ++sequence.current;
    setBusy(true); setError('');
    try {
      const result = await fetchAccountAnalytics(platform);
      if (request !== sequence.current) return;
      if (!result.loggedIn) {
        setData(null); setNickname('');
        throw new Error('平台登录已失效，请到「账号中心」重新登录并校验账号后采集。');
      }
      if (!result.analysis) throw new Error('服务尚未返回分析摘要，请更新服务后重试。');
      setData(result.analysis); setNickname(result.nickname || '当前登录会话');
    } catch (reason) {
      if (request === sequence.current) setError(reason instanceof Error ? reason.message : '采集失败，请重试。');
    } finally {
      if (request === sequence.current) { pending.current = false; setBusy(false); }
    }
  };
  const visibleNotes = data?.notes.filter((note) => note.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) || [];

  return <section id="platform-analysis" className="platform-analysis card" aria-labelledby="platform-analysis-title">
    <div className="platform-analysis-head">
      <div><h2 id="platform-analysis-title">多平台账号分析</h2><p>读取当前登录平台的真实数据，按来源与覆盖范围复盘。</p></div>
      <div className="platform-analysis-actions">
        {showPlatformPicker && <Select aria-label="分析平台" value={platform} onChange={onPlatformChange}
          options={accounts.map((account) => ({ value: account.platform, label: account.name, description: account.loggedIn ? '可采集当前登录会话' : '需要先登录' }))} />}
        <button className="btn btn-primary btn-sm" disabled={!current?.loggedIn || busy} onClick={() => void collect()}>{busy ? '采集中…' : data ? '重新采集' : '采集本人数据'}</button>
      </div>
    </div>
    {error && <div className="notice-error" role="alert">{error}{data ? ' 下方保留上次成功结果，本次没有更新数据。' : ''}</div>}
    {busy && <p role="status">正在读取{current?.name}，平台响应可能需要几分钟。尚未得到的指标不会填为 0。</p>}
    {!current?.loggedIn && <p className="platform-analysis-empty">请先到「账号中心」登录{current?.name || '所选平台'}并校验账号。公众号数据需要后台扫码会话。</p>}
    {current?.loggedIn && !data && !busy && <p className="platform-analysis-empty">尚未采集。点击「采集本人数据」获取本次账号概览、平台指标与作品记录。</p>}
    {data && <>
      <div className="platform-analysis-provenance">
        <strong>{current?.name} · {nickname}</strong>
        <span>来源：<a href={data.source.url} target="_blank" rel="noreferrer">{data.source.label} ↗</a></span>
        <span>{error ? '上次成功采集' : '采集时间'}：{data.fetchedAt ? new Date(data.fetchedAt * 1000).toLocaleString('zh-CN') : '平台未提供可靠时间'}</span>
        <span>覆盖：{data.coverage.numericMetrics} 项数值 · {data.coverage.notes} 条作品记录</span>
      </div>
      <div className="platform-analysis-overview">
        {data.overview.map((metric) => <div key={metric.key}><span>{metric.label}</span><strong>{metric.value == null ? '缺失' : metric.value.toLocaleString('zh-CN')}</strong></div>)}
      </div>
      {data.quality && <section aria-label="作品数据质量">
        <h3>这批数据能分析到哪里</h3>
        <div className="platform-analysis-overview">
          <div><span>返回作品</span><strong>{data.quality.returnedNotes}</strong></div>
          <div><span>有逐篇指标</span><strong>{data.quality.notesWithMetrics}</strong></div>
          <div><span>逐篇数值项</span><strong>{data.quality.structuredMetricValues}</strong></div>
          <div><span>缺可靠发布时间</span><strong>{data.quality.notesMissingPublishTime}</strong></div>
        </div>
        <p className="platform-analysis-muted">{data.quality.level === 'no_content' ? '尚无作品证据' : data.quality.level === 'records_only' ? '仅有作品记录，可核对主题和原始摘要' : '可查看已返回的逐篇指标'} · {data.quality.notesMissingOriginalLink} 条缺少独立原文链接 · 统计起止日期{data.quality.periodKnown ? '已核验' : '未核验'}</p>
        <p className="platform-analysis-muted">{data.quality.comparisonReason}</p>
      </section>}
      {!!data.periodWindows?.length && <details>
        <summary>公众号统计窗口与覆盖范围</summary>
        <p className="platform-analysis-muted">窗口以平台本次返回的最新日期为锚点，不代表截至今天。每日阅读／分享人数相加不能视为整个区间去重人数；平台时区尚未核验。</p>
        <ul className="platform-analysis-muted">{data.periodWindows.map((window) => <li key={window.label}>{window.label}：{window.from && window.to ? `${window.from} 至 ${window.to}` : '日期未知'} · 返回 {window.observedDays ?? '未知'} 日 · 缺失 {window.missingDays ?? '未知'} 日 · {window.complete ? '日期覆盖完整（仍需核对指标缺失）' : '日期覆盖不完整或未核验'}</li>)}</ul>
      </details>}
      {!!data.unmatchedEvidence?.length && <details>
        <summary>未关联到作品的公众号分析证据 · {data.unmatchedEvidence.length} 条</summary>
        <p className="platform-analysis-muted">缺少可唯一匹配的内容标识，暂不与同标题作品合并。</p>
        {data.unmatchedEvidence.map((evidence, index) => <p key={index}>{evidence.title} · {evidence.source} · {evidence.period} · {evidence.metrics.map((metric) => `${metric.label} ${metric.value}`).join(' · ') || '无结构化数值'}</p>)}
      </details>}
      <div className="platform-analysis-columns">
        <div>
          <h3>平台指标</h3><p className="platform-analysis-muted">{data.period}</p>
          {data.metrics.length ? <dl className="platform-analysis-metrics">{data.metrics.map((metric, index) => <div key={`${metric.label}-${index}`}>
            <dt>{metric.label}</dt><dd>{metric.value}{metric.comparison && <small>平台对比：{metric.comparison}</small>}
              {metric.coverage && <small>{metric.coverage.complete ? '已返回记录字段齐全' : '部分合计（覆盖不完整）'} · 已知 {metric.coverage.knownRecords ?? '未知'} / 返回 {metric.coverage.sampleRecords ?? '未知'} 条</small>}
              {metric.window && <small>{metric.window.from && metric.window.to ? `${metric.window.from} 至 ${metric.window.to}` : '统计起止日期未核验'}{metric.window.kind === 'returned_publish_records' && ' · 仅本次发表列表，不是全账号总量'}{metric.window.missingDays != null && metric.window.missingDays > 0 && ` · 缺 ${metric.window.missingDays} 日`}{metric.window.aggregation === 'sum_daily_uv_not_period_unique' && ' · 每日人数相加，非区间去重人数'}</small>}
            </dd>
          </div>)}</dl> : <p className="platform-analysis-muted">本次没有返回可用的平台区间指标。</p>}
          <h3>缺失与使用范围</h3>
          <ul className="platform-analysis-muted">{data.missingFields.map((field) => <li key={field}>{field}</li>)}{data.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
        </div>
        <div>
          <h3>根据本次数据的建议</h3>
          {data.suggestions.length ? data.suggestions.map((suggestion) => <article className="platform-analysis-suggestion" key={suggestion.title}>
            <strong>{suggestion.title}</strong><p className="platform-analysis-muted">依据：{suggestion.reason}</p><p>{suggestion.action}</p>
          </article>) : <p className="platform-analysis-muted">当前证据不足，暂不生成内容效果建议。</p>}
        </div>
      </div>
      <h3>本次返回的作品 · {data.notes.length}</h3>
      <p className="platform-analysis-muted">采集范围可能只包含最近一页，缺失指标与没有作品是不同情况。</p>
      {data.notes.length > 0 && <label className="platform-analysis-search">搜索本次作品
        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="输入作品标题关键词" aria-label="搜索本次作品标题" />
      </label>}
      {search.trim() && <p role="status" className="platform-analysis-muted">找到 {visibleNotes.length} / {data.notes.length} 条作品{visibleNotes.length === 0 ? '，请尝试其他标题关键词。' : ''}</p>}
      <div className="platform-analysis-notes">{visibleNotes.map((note, index) => <article key={`${note.url}-${index}`}>
        <strong>{note.title}</strong>
        {note.url && <a href={note.url} target="_blank" rel="noreferrer">{note.linkLabel} ↗</a>}
        {note.metrics.length > 0 && <p>{note.metrics.map((metric) => `${metric.label} ${metric.value}`).join(' · ')}</p>}
        <details><summary>查看采集证据与缺失说明{note.missingFields.length > 0 ? `（${note.missingFields.length} 项）` : ''}</summary>
        {note.stat ? <p>平台原始摘要：{note.stat}</p> : <p className="platform-analysis-muted">平台未返回原始摘要。</p>}
        {note.publish && <p>平台发布时间文本：{note.publish}{!note.publishedAt && '（未解析为可靠日期）'}</p>}
        {note.analyticsEvidence?.map((evidence, evidenceIndex) => <p key={evidenceIndex}>独立分析证据：{evidence.source} · {evidence.period} · {evidence.metrics.map((metric) => `${metric.label} ${metric.value}`).join(' · ') || '无结构化数值'}（与发表页指标分开保留）</p>)}
        {note.missingFields.length > 0 && <ul className="platform-analysis-muted">{note.missingFields.map((field) => <li key={field}>{field}</li>)}</ul>}
        </details>
      </article>)}</div>
    </>}
  </section>;
}
