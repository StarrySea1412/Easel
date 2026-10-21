import { useSyncExternalStore } from 'react';
import { analyticsRevision, subscribeAnalytics, analyticsPending, analyticsError, readAnalyticsCache } from '../lib/analyticsCache';
import PlatformIcon from './PlatformIcon';
import { IconFile, IconEye } from './icons';
import PublishSpinner from './PublishSpinner';
import AnalysisMetricChart from './AnalysisMetricChart';
import { metricData } from '../lib/analysisVisuals';
import '../styles/analysis-visuals.css';

/** The exact dashboard snapshot, including its still-running collection. */
export default function AccountAnalyticsDetails({ platform }: { platform: string }) {
  useSyncExternalStore(subscribeAnalytics, analyticsRevision);
  const data = readAnalyticsCache(platform), pending = analyticsPending(platform), error = analyticsError(platform);
  if (!data && !pending && !error) return null;
  return <section className="ca-paper" aria-label="工作台账号分析详情" aria-busy={pending}>
    <div className="ca-card-heading"><h3>{data?.nickname || data?.name || '账号分析'}</h3>{pending && <span role="status" aria-label="正在更新账号数据"><PublishSpinner /></span>}</div>
    {error && <p className="ca-error" role="alert">{error}{data ? '，上次结果保留。' : ''}</p>}
    {data && <><p className="ca-caption">工作台同一份结果 · {data.fetched_at ? new Date(data.fetched_at * 1000).toLocaleString('zh-CN') : '时间未提供'}</p>
      <div className="ca-metric-strip">{([['粉丝', data.followers], ['获赞', data.likes], ['作品', data.posts]] as const).filter(([, value]) => value != null).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value?.toLocaleString('zh-CN')}</strong></div>)}</div>
      {data.warning && <p>{data.warning}</p>}
      <AnalysisMetricChart title={data.metrics_title || '平台指标'} caption={data.metrics_source ? data.metrics_source.from+' — '+data.metrics_source.to : '当前账号采集快照'} data={metricData(data.metrics || [])}/>
      <details className="account-works-details"><summary><IconFile size={16}/>作品与详细指标<span>{data.notes?.length || 0} 篇</span></summary>
        <div className="account-works-grid">{(data.notes || []).map((note, index) => <article className="account-work-card" key={`${note.url}-${index}`}>
          <header><span className="account-work-index">{String(index + 1).padStart(2, '0')}</span><PlatformIcon platform={platform} name={platform}/>{/^https?:\/\//i.test(note.url) && <a className="btn btn-sm" href={note.url} target="_blank" rel="noreferrer" aria-label={`查看原作：${note.title}`}><IconEye size={14}/>查看原作</a>}</header>
          <h4 title={note.title}>{note.title || '未提供标题'}</h4>
          {note.title.length > 100 && <details className="account-work-excerpt"><summary>完整文案</summary><p>{note.title}</p></details>}
          {note.stat && <details className="account-work-excerpt"><summary>平台摘要</summary><p>{note.stat}</p></details>}
        </article>)}</div>
        {!data.notes?.length && <p className="ca-caption">平台尚未返回作品。</p>}
        {!!data.metrics?.length && <div className="account-metrics-table"><table><caption>平台详细指标</caption><thead><tr><th scope="col">指标</th><th scope="col">数值</th><th scope="col">对比</th></tr></thead><tbody>{data.metrics.map((metric, i) => <tr key={i}><th scope="row">{metric.label}</th><td>{metric.value ?? '未提供'}</td><td>{metric.vs || '—'}</td></tr>)}</tbody></table></div>}
      </details></>}
  </section>;
}
