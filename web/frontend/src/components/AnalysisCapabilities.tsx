import { ANALYSIS_RESEARCH, emptyCapabilities, RESEARCH_CHECKED_AT } from '../lib/analysisPlatforms';
import type { AnalysisReport } from '../lib/contentAnalysis';

export default function AnalysisCapabilities({platform,report,onAdd}:{platform:string;report:AnalysisReport|null;onAdd:()=>void}) {
 const research=ANALYSIS_RESEARCH[platform] || ANALYSIS_RESEARCH.xiaohongshu;
 const capabilities=report?.professional?.capabilities || emptyCapabilities(platform);
 return <div className="ca-capability-workspace">
  <section className="ca-paper" aria-labelledby="ca-capability-title">
   <div className="ca-card-heading"><div><p className="ca-kicker">WHAT YOU CAN LEARN / {research.label}</p><h3 id="ca-capability-title">我能分析作品的什么问题？</h3></div><button className="btn btn-sm" onClick={onAdd}>补充作品材料</button></div>
   <p className="ca-caption">先看材料是否足够，再读结论。没有账号记录时，下面列出你可以准备的材料；不会填入演示数字。</p>
   <div className="ca-capability-grid">{capabilities.map(item=><article className="ca-capability-card" key={item.id}><div className="ca-card-heading"><span className="ca-evidence-label">可诊断问题</span><span className={`ca-capability-status ${item.available>0?'is-available':''}`}>{item.available>0 ? `${item.available}/${item.total} 篇有材料` : '需补充材料'}</span></div><h4>{item.question}</h4><p><strong>所需：</strong>{item.required.join(' · ')}</p><p className="ca-caption">{item.limitation}</p></article>)}</div>
   {report&&!report.professional&&<p className="ca-bench-notice" role="status">当前报告尚未提供专业证据字段。原作品功能仍可用，请更新服务后重新读取；这里不推算样本或建议。</p>}
  </section>
  <section className="ca-paper ca-research-card" aria-label={`${research.label}官方资料与算法边界`}>
   <p className="ca-kicker">PLATFORM SOURCES / 核对日期 {RESEARCH_CHECKED_AT}</p><h3>{research.label}：公开资料能说明什么</h3>
   <div className="ca-research-grid"><article><span className="ca-evidence-label">官方资料入口</span><p><a href={research.source} target="_blank" rel="noreferrer">{research.sourceLabel} ↗</a></p><p className="ca-caption">入口可能要求登录或账号权限，不能替代对你账号实际返回字段的核验。</p></article><article><span className="ca-evidence-label">资料未披露</span><p>{research.limitation}</p></article><article><span className="ca-evidence-label">本账号待验证假设</span><p>{research.focus}</p><p className="ca-caption">同龄作品的相关模式仍可能受到流量来源、投放和样本选择影响。</p></article></div>
   <p className="ca-caption">编辑建议依据当前真实文字材料；未提供封面图、视频、音频或留存曲线时，不评价视觉、镜头或具体流失位置。</p>
  </section>
 </div>;
}
