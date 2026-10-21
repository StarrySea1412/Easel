export type CacheReuse = {ratio:number|null;eligibleRecords:number;totalRecords:number;missingRecords:number;invalidRecords:number;zeroInputRecords:number;inputTokens:number;readTokens:number;unit:string};

export default function CacheReuseMetric({value}:{value?:CacheReuse}) {
  const unit=value?.unit==='usage_events'?'用量事件':'请求记录';
  const description=value ? `按有效样本求和：缓存读取 ${value.readTokens.toLocaleString()} / 输入 ${value.inputTokens.toLocaleString()} Token。缺字段 ${value.missingRecords}，异常 ${value.invalidRecords}，零输入 ${value.zeroInputRecords}。这不是账单节省比例。` : '服务尚未提供有效缓存统计。';
  return <div className="usage-metric secondary" title={description}>
    <span>缓存读取占比{value&&value.eligibleRecords<value.totalRecords?' · 已上报样本':''}</span>
    <strong>{value?.ratio==null?'未上报':`${(value.ratio*100).toLocaleString('zh-CN',{maximumFractionDigits:1})}%`}</strong>
    <small>{value?`${value.eligibleRecords}/${value.totalRecords} 条有效${unit}`:'没有可用记录'}</small>
    <details><summary>统计口径</summary><small>{description}</small></details>
  </div>;
}
