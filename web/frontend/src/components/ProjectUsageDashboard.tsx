import { useId, useState, type CSSProperties } from 'react';
import { IconChart, IconCoins, IconHistory, IconChevron } from './icons';
import { ObservedProviderIcon } from './ProviderIcon';
import '../styles/usage-dashboard.css';
import CacheReuseMetric, {type CacheReuse} from './CacheReuseMetric';

type Summary = { calls:number; reportedCalls:number; totalTokens:number|null; recordedCostUsd:number|null; coverage:{totalTokens:number;recordedCostUsd:number};cacheReuse?:CacheReuse };
type Day = {date:string;summary:Summary};
export type UsageDashboardData = {
  days:Day[]; timezone:string; rangeDays:number; undatedCalls:number; futureCalls:number;
  recent:{id:string;sessionId:string;timestamp:string;model:string;provider:string;channelName?:string;totalTokens:number|null;recordedCostUsd:number|null;engine?:string}[];
  recentLimit:number; models:{channelId:string;channelName:string;provider:string;model:string;summary:Summary}[]; modelCount:number;
};
type Metric = 'totalTokens'|'calls'|'recordedCostUsd';
const METRICS = [{id:'totalTokens',label:'Token'},{id:'calls',label:'调用记录'},{id:'recordedCostUsd',label:'记录费用'}] as const;
const number = (value:number|null, metric:Metric='totalTokens') => value === null ? '未上报' : metric === 'recordedCostUsd' ? `$${value.toLocaleString('en-US',{maximumFractionDigits:6})}` : value.toLocaleString('zh-CN');
const valueOf = (day:Day, metric:Metric) => day.summary.calls === 0 ? 0 : day.summary[metric];
const shortDate = (date:string) => date.slice(5).replace('-','/');
const COLORS = ['mint','blue','violet','amber','pink','cyan','mint','blue'];

export default function ProjectUsageDashboard({data,summary,sessionTitles,onInspectSession}:{data?:UsageDashboardData;summary:Summary;sessionTitles:Record<string,string>;onInspectSession?:(id:string)=>void}) {
  const [range,setRange] = useState(7);
  const [metric,setMetric] = useState<Metric>('totalTokens');
  const [selectedDate,setSelectedDate] = useState('');
  const gradientId = useId();
  const days = data?.days.slice(-range) || [];
  const activeIndex = Math.max(0,days.findIndex(day=>day.date===selectedDate));
  const active = days.find(day=>day.date===selectedDate) || days.at(-1);
  const values = days.map(day=>valueOf(day,metric));
  const known = values.filter((value):value is number=>value!==null);
  const max = Math.max(0,...known) || 1;
  const hasReportedValue = metric==='calls'||days.some(day=>day.summary.calls>0&&day.summary[metric]!==null);
  const sum = days.some(day=>day.summary.calls>0)&&!hasReportedValue ? null : known.length ? known.reduce((a,b)=>a+b,0) : null;
  const partial = metric!=='calls' && days.some(day=>day.summary.coverage[metric]<day.summary.calls);
  const x = (i:number) => 46+i/Math.max(1,days.length-1)*660;
  const y = (value:number) => 222-value/max*174;
  // Split at unknown values. Connecting them would imply measured usage.
  const segments:{i:number;v:number}[][]=[];
  values.forEach((v,i)=>{if(v===null)return;if(i===0||values[i-1]===null)segments.push([]);segments.at(-1)!.push({i,v});});
  const coverage = summary.calls ? Math.round(summary.reportedCalls/summary.calls*100) : 0;
  const peak = Math.max(1,...(data?.models.map(row=>row.summary.totalTokens||0)||[]));
  return <div className="usage-dashboard">
    <div className="usage-visual-grid">
      <section className="usage-chart-card" aria-label="项目每日用量趋势">
        <header><div><span className="usage-visual-eyebrow"><IconChart size={15}/>用量趋势</span><h3>{number(sum,metric)}<small>{metric==='totalTokens'?'Token':metric==='calls'?'条记录':'USD'}</small></h3><p>近 {range} 天{partial?' · 已知部分合计':''} · 北京时间</p></div>
          <div className="usage-range-switch" role="group" aria-label="趋势时间范围">{[7,30].map(n=><button type="button" key={n} aria-pressed={range===n} onClick={()=>{setRange(n);setSelectedDate('');}}>近{n}天</button>)}</div>
        </header>
        <div className="usage-chart-tabs" role="group" aria-label="趋势统计指标">{METRICS.map(item=><button type="button" key={item.id} aria-pressed={metric===item.id} onClick={()=>setMetric(item.id)}>{item.label}</button>)}</div>
        {!data ? <div className="usage-chart-empty">当前服务未提供每日记录，请更新后端后刷新；累计用量仍可在上方查看。</div> : !days.some(day=>day.summary.calls>0) ? <div className="usage-chart-empty">近 {range} 天没有已记录的调用。<small>上方累计包含更早记录。</small></div> : <>
          <div className="usage-chart-inspection" aria-live="polite">{active && <><span>{active.date}</span><strong>{number(valueOf(active,metric),metric)}</strong><small>{active.summary.calls} 条记录{metric!=='calls'&&active.summary.coverage[metric]<active.summary.calls?' · 部分未上报':''}</small></>}</div>
          <svg className="usage-area-chart" viewBox="0 0 740 260" role="img" aria-label={`近${range}天每日${METRICS.find(m=>m.id===metric)?.label}，可通过下方日期按钮查看数值`} onPointerMove={event=>{
            const bounds=event.currentTarget.getBoundingClientRect();
            if(bounds.width) setSelectedDate(days[Math.max(0,Math.min(days.length-1,Math.round(((event.clientX-bounds.left)/bounds.width*740-46)/660*(days.length-1))))].date);
          }}>
            <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="currentColor" stopOpacity=".25"/><stop offset="100%" stopColor="currentColor" stopOpacity="0"/></linearGradient></defs>
            {[0,.5,1].map(t=><g key={t}><line x1="46" x2="706" y1={y(max*t)} y2={y(max*t)} className="usage-chart-gridline"/><text x="4" y={y(max*t)-7}>{metric==='recordedCostUsd'?number(max*t,metric):(max*t).toLocaleString('zh-CN',{notation:'compact',maximumFractionDigits:1})}</text></g>)}
            {segments.map((segment,j)=>{const line=segment.map((p,i)=>`${i?'L':'M'}${x(p.i)},${y(p.v)}`).join(' ');return <g key={j}><path d={`${line} L${x(segment.at(-1)!.i)},222 L${x(segment[0].i)},222 Z`} fill={`url(#${gradientId})`}/><path d={line} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round"/>{segment.length===1&&<circle cx={x(segment[0].i)} cy={y(segment[0].v)} r="3" fill="currentColor"/>}</g>;})}
            {active&&valueOf(active,metric)!==null&&<g><line className="usage-chart-cursor" x1={x(days.indexOf(active))} x2={x(days.indexOf(active))} y1="30" y2="222"/><circle cx={x(days.indexOf(active))} cy={y(valueOf(active,metric)!)} r="4.5" fill="currentColor"/></g>}
            {[0,Math.floor((days.length-1)/2),days.length-1].map(i=><text key={i} x={x(i)} y="250" textAnchor="middle">{shortDate(days[i].date)}</text>)}
          </svg>
          <div className="usage-day-strip" role="group" aria-label="按日期查看用量" onKeyDown={event=>{
            if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
            event.preventDefault();const current=selectedDate?activeIndex:days.length-1;
            const next=event.key==='Home'?0:event.key==='End'?days.length-1:Math.max(0,Math.min(days.length-1,current+(event.key==='ArrowRight'?1:-1)));
            setSelectedDate(days[next].date);event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
          }}>{days.map((day,i)=><button type="button" key={day.date} aria-label={`${day.date}：${number(valueOf(day,metric),metric)}，${day.summary.calls}条记录`} aria-pressed={active?.date===day.date} tabIndex={active?.date===day.date?0:-1} onFocus={()=>setSelectedDate(day.date)} onMouseEnter={()=>setSelectedDate(day.date)} onClick={()=>setSelectedDate(day.date)} className={`${day.summary.calls?'has-usage':''}${valueOf(day,metric)===null?' is-unknown':''}`} style={{'--usage-intensity':String(.15+(values[i]||0)/max*.85)} as CSSProperties}/>)}</div>
          <p className="usage-chart-footnote">每日已记录消耗 · 空白日期为无记录；未上报处断开，未知费用不补 0。</p>
        </>}
        {data&&Boolean(data.undatedCalls||data.futureCalls)&&<p className="usage-chart-footnote">{data.undatedCalls} 条缺少时间、{data.futureCalls} 条时间在未来，未纳入趋势及最近列表；累计仍保留。</p>}
      </section>

      <div className="usage-visual-side">
        <section className="usage-coverage-card" aria-label="Token上报覆盖率">
          <div className="usage-coverage-ring" style={{'--usage-coverage':`${coverage}%`} as CSSProperties} role="img" aria-label={`${coverage}%的记录上报了Token，${summary.reportedCalls}/${summary.calls}`}><strong>{coverage}<small>%</small></strong></div>
          <div><h3>Token 上报覆盖</h3><p><i/>{summary.reportedCalls} 条已上报</p><p><i className="is-muted"/>{Math.max(0,summary.calls-summary.reportedCalls)} 条未上报</p><small>有上报不代表字段全部完整</small></div>
        </section>
        <section className="usage-recent-card" aria-label="最近用量记录"><header><h3><IconHistory size={16}/>最近调用</h3><span>最近 {data?.recent.length||0} 条</span></header>
          <div className="usage-recent-list">{data?.recent.length ? data.recent.map(row=>{
            const content=<><span className="usage-log-marker">{row.engine==='codex'?'CODEX':'调用'}</span><span className="usage-log-content"><strong>{row.model||'模型未记录'}</strong><small>{row.channelName||row.provider||'渠道未记录'} · {new Date(row.timestamp).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}</small></span><span className="usage-log-amount">{number(row.totalTokens)}<small>Token</small></span></>;
            return onInspectSession ? <button type="button" key={row.id} title={`查看会话：${sessionTitles[row.sessionId]||row.sessionId}`} onClick={()=>onInspectSession(row.sessionId)}>{content}</button> : <div key={row.id}>{content}</div>;
          }):<p className="usage-chart-empty">{data?'没有带有效时间的调用记录':'服务尚未提供最近记录'}</p>}</div>
          <p className="usage-chart-footnote">最多 {data?.recentLimit||20} 条用量记录 · 包含未上报数据</p>
        </section>
      </div>
    </div>
    <section className="usage-model-ranking" aria-label="模型消耗排行"><header><div><h3><IconCoins size={16}/>模型消耗</h3><p>项目累计 · 按已记录 Token 排序，跨渠道同名模型分别统计</p></div><span>前 {data?.models.length||0} / {data?.modelCount||0} 项</span></header>
      {data?.models.length ? <div className="usage-model-grid">{data.models.map((row,i)=><article key={`${row.channelId}/${row.model}`} className={`usage-model-card is-${COLORS[i]}`}>
        <div className="usage-model-top"><span className="usage-model-icon"><ObservedProviderIcon provider={row.provider} model={row.model} size={23}/></span><span>#{i+1}</span></div><h4 title={row.model}>{row.model||'模型未记录'}</h4><p>{row.channelName||row.provider||'渠道未记录'} · {row.summary.calls} 条记录</p>
        <strong>{number(row.summary.totalTokens)}<small> Token</small></strong><div className="usage-model-track"><span style={{width:`${(row.summary.totalTokens||0)/peak*100}%`}}/></div><small>{row.summary.coverage.totalTokens<row.summary.calls?'部分上报 · ':''}记录费用 {number(row.summary.recordedCostUsd,'recordedCostUsd')}</small><CacheReuseMetric value={row.summary.cacheReuse}/>
      </article>)}</div>:<p className="usage-chart-empty">{data?'暂无模型用量记录':'服务尚未提供模型汇总；已有渠道明细见下方'}</p>}
      <p className="usage-chart-footnote"><IconChevron size={12}/>完整渠道、模型与会话统计见下方明细</p>
    </section>
  </div>;
}
