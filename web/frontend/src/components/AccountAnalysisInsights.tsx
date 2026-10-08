import type { AccountInsight, AnalysisContent, AnalysisReport } from '../lib/contentAnalysis';
import '../styles/account-analysis-insights.css';

export default function AccountAnalysisInsights({ report, busy, onRequest, onChoose, onPlan }: {
 report: AnalysisReport;
 busy: boolean;
 onRequest: () => void;
 onChoose: (content: AnalysisContent) => void;
 onPlan: (insight: AccountInsight, contentIds: string[]) => void;
}) {
 const profile = report.platformProfile;
 const saved = report.accountInsights;
 const materialCount = report.contents.filter(c => [c.body,c.transcript,c.coverText,c.title].some(value => value?.trim() && value.trim() !== '未提供标题') || c.comments?.some(value => value.trim())).length;
 return <div className="ca-account-insights">
  {profile && <section className="ca-paper ca-platform-profile" aria-label="平台分析重点">
   <p className="ca-kicker">PLATFORM / {profile.label}</p><h3>{profile.label}的复盘重点</h3>
   <ul>{profile.focus.map(item => <li key={item}>{item}</li>)}</ul>
   <details><summary>需要补充的材料与分析边界</summary><h4>建议准备</h4><ul>{profile.materialNeeds.map(item => <li key={item}>{item}</li>)}</ul><h4>当前不能判断</h4><ul>{profile.limitations.map(item => <li key={item}>{item}</li>)}</ul></details>
  </section>}
  <section className="ca-paper" aria-label="跨作品 AI 解读" aria-busy={busy}>
   <div className="ca-card-heading"><h3>跨作品 AI 解读</h3><button className="btn btn-sm" disabled={busy || materialCount < 2} onClick={onRequest}>{busy ? '正在分析当前账号…' : saved ? '重新生成账号解读' : '生成账号解读'}</button></div>
   <p className="ca-caption">点击会将当前账号已保存作品的文字材料与事实发送至已配置的模型服务。事实由程序整理，模型建议仍是待验证假设。</p>
   {materialCount < 2 && <p className="ca-caption">至少保存两篇含文字材料的作品后才能生成跨作品解读。</p>}
   {saved ? <>
    <p className="ca-caption">已保存结果 · {saved.model} · {new Date(saved.at).toLocaleString('zh-CN')}</p>
    <p className="ca-caption">材料或指标更新后，旧解读失效并移除；刷新记录可读取当前有效结果。</p>
    {saved.insights.map((insight, index) => {
     const facts = saved.facts.filter(f => insight.factIds.includes(f.id));
     const contentIds = Array.from(new Set(facts.flatMap(f => f.contentIds))).filter(id => report.contents.some(c => c.id === id));
     return <article className="ca-diagnostic" key={index}>
      <h4>{insight.observation}</h4>
      <div className="ca-insight-facts" aria-label="引用的事实">{facts.map(fact => <div className="ca-insight-fact" key={fact.id}><strong>事实 {saved.facts.indexOf(fact) + 1}</strong><p>{fact.text}</p><div className="ca-bench-actions">{fact.contentIds.map(id => { const content = report.contents.find(c => c.id === id); return content ? <button className="ca-text-button" key={id} onClick={() => onChoose(content)}>查看作品：{content.title} →</button> : null; })}</div></div>)}</div>
      <p><strong>可尝试：</strong>{insight.action}</p><button className="ca-text-button" disabled={!contentIds.length} onClick={() => onPlan(insight, contentIds)}>建立验证实验 →</button>
     </article>;
    })}
    <p className="ca-caption">{saved.notice}</p>
   </> : <p className="ca-caption">当前没有有效的已保存解读。尚未生成或材料更新导致旧结果失效时，需要重新生成。</p>}
  </section>
 </div>;
}
