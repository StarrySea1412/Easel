import { useSyncExternalStore } from 'react';
import { analyticsRevision, subscribeAnalytics, analyticsPending, analyticsError, readAnalyticsCache } from '../lib/analyticsCache';
import OutputMessageContent from './OutputMessageContent';
import PublishSpinner from './PublishSpinner';

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
      <details><summary>查看平台返回的作品与详细指标（{data.notes?.length || 0} 篇）</summary>
        <OutputMessageContent inert content={(data.notes || []).map(note => ['### ' + note.title, note.stat || '', note.url ? '来源：' + note.url : ''].filter(Boolean).join('\n\n')).join('\n\n')} />
        {data.metrics?.map((metric, i) => <p key={i}>{metric.label}：{metric.value} {metric.vs}</p>)}
      </details></>}
  </section>;
}
