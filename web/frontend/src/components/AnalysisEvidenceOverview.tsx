import { useState } from 'react';
import type { AnalysisBinding } from '../lib/analysisBinding';
import { frozenEvidence, metricData, WORK_METRICS } from '../lib/analysisVisuals';
import AnalysisMetricChart from './AnalysisMetricChart';
import PlatformIcon from './PlatformIcon';
import Select from './ui/Select';
import { IconChevron } from './icons';

export default function AnalysisEvidenceOverview({ context }: { context: AnalysisBinding }) {
  const works = frozenEvidence(context.markdown, context.contentIds);
  const [selectedId, setSelectedId] = useState('');
  const selected = works.find(work => work.id === selectedId) || works[0];
  const selectedIndex = works.indexOf(selected);
  const textCount = works.filter(work => work.body?.trim() || work.transcript?.trim()).length;
  const metricCount = works.filter(work => Object.values(work.metrics || {}).some(value => typeof value === 'number')).length;
  return <div className="analysis-evidence">
    <div className="analysis-evidence-summary"><div><small>本轮样本</small><strong>{works.length || context.contentIds.length}<span>篇</span></strong></div><div><small>有正文 / 转录</small><strong>{textCount}<span>篇</span></strong></div><div><small>有表现指标</small><strong>{metricCount}<span>篇</span></strong></div></div>
    <section className="analysis-evidence-coverage"><div><strong>内容材料覆盖</strong><span>{textCount}/{works.length || context.contentIds.length}</span></div><svg viewBox="0 0 320 8" role="img" aria-label={'正文材料覆盖' + textCount + '篇，共' + context.contentIds.length + '篇'}><rect width="320" height="8" rx="4" fill="var(--surface-2)"/><rect width={works.length ? 320 * textCount / works.length : 0} height="8" rx="4" fill="#588b89"/></svg><p>{textCount < works.length ? '部分作品只有标题和指标，需补充正文或视频转录后再判断内容结构。' : works.length ? '可基于已有正文与指标分析；样本不代表账号全部作品。' : '此快照没有可识别的作品结构，可展开原始材料查看。'}</p></section>
    {selected && <>
      {works.length > 1 && <div className="analysis-evidence-navigation" role="group" aria-label="作品导航">
        <Select aria-label="选择分析作品" className="analysis-work-select" value={selected.id} title={selected.title} onChange={setSelectedId} options={works.map((work,index)=>({value:work.id,label:`${index+1}. ${work.title || '未提供标题'}`}))}/>
        <div className="analysis-evidence-stepper"><button className="btn btn-sm" type="button" aria-label="上一篇作品" disabled={selectedIndex===0} onClick={()=>setSelectedId(works[selectedIndex-1].id)}><IconChevron className="analysis-work-previous" size={13}/></button><span aria-live="polite">{selectedIndex+1} / {works.length}</span><button className="btn btn-sm" type="button" aria-label="下一篇作品" disabled={selectedIndex===works.length-1} onClick={()=>setSelectedId(works[selectedIndex+1].id)}><IconChevron className="analysis-work-next" size={13}/></button></div>
      </div>}
      <article className="analysis-evidence-work"><div className="analysis-evidence-source"><PlatformIcon platform={context.platform} name={context.platform}/><span>作品证据</span>{selected.url && /^https?:\/\//.test(selected.url) && <a href={selected.url} target="_blank" rel="noreferrer">查看原作 ↗</a>}</div><h3>{selected.title || '未提供标题'}</h3><div className="analysis-evidence-dates"><span>{selected.publishedAt ? '发布 ' + new Date(selected.publishedAt).toLocaleDateString('zh-CN') : '发布时间未提供'}</span><span>{selected.period === 'lifetime' ? '累计表现' : selected.period === 'unknown' || !selected.period ? '统计窗口未提供' : selected.period}</span></div>
      <AnalysisMetricChart title="作品表现" caption="独立指标对比 · 非每日趋势" data={metricData(Object.entries(selected.metrics || {}).filter(([key]) => key in WORK_METRICS).map(([key, value]) => ({label: WORK_METRICS[key], value})))}/>
      <div className="analysis-evidence-metrics">{Object.entries(selected.metrics || {}).filter(([key, value]) => key in WORK_METRICS && typeof value === 'number').map(([key, value]) => <div key={key}><span>{WORK_METRICS[key]}</span><strong>{value?.toLocaleString('zh-CN')}</strong></div>)}</div>
      {(selected.body || selected.transcript || selected.coverText) && <details className="analysis-evidence-text"><summary>内容摘录</summary><p>{selected.body || selected.transcript || selected.coverText}</p></details>}
      </article>
    </>}
    <footer className="analysis-evidence-foot" title={context.sourceHash}>来源快照 {context.sourceHash.slice(0, 10)} · {new Date(context.createdAt).toLocaleString('zh-CN')}</footer>
  </div>;
}
