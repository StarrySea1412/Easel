import { NativeSelect as Select } from './ui/Select';
import { useCallback, useEffect, useRef, useState } from 'react';
import AccountAnalysisInsights from './AccountAnalysisInsights';
import AnalysisCapabilities from './AnalysisCapabilities';
import ProfessionalAnalysisPanel from './ProfessionalAnalysisPanel';
import { createIdea } from '../lib/api';
import { analysisRequest, analysisUrl, validateAnalysisReport, topicEvidence, topicIdeaNote, type AnalysisAccount, type AnalysisContent, type AnalysisReport, type AnalysisTopic, type AnalysisSyncState, type TopicEvidence, type ExperimentMetric, type MetricKey } from '../lib/contentAnalysis';

export type AnalysisSection = 'review'|'works'|'themes'|'experiments'|'method';
const METRICS: Record<MetricKey,string> = {views:'阅读 / 播放',likes:'点赞',comments:'评论',collects:'收藏',shares:'分享'};
const keys = Object.keys(METRICS) as MetricKey[];
const EXPERIMENT_METRICS:Record<ExperimentMetric,string>={...METRICS,impressions:'曝光次数',completions:'完播次数',averageWatchSeconds:'平均观看秒数',durationSeconds:'视频长度秒数',followersAttributed:'归因新增关注',coins:'投币',danmaku:'弹幕'};
const advancedKeys=['impressions','completions','averageWatchSeconds','durationSeconds','followersAttributed','coins','danmaku'] as const;
const show = (v: number|null|undefined) => v == null ? '—' : v.toLocaleString('zh-CN');
const date = (v?:string) => v ? new Date(v).toLocaleString('zh-CN') : '未提供';
const safeUrl = (url?:string) => { try { const value = new URL(url || ''); return ['http:','https:'].includes(value.protocol) ? value.href : undefined; } catch { return undefined; } };

export default function ContentAnalysisWorkbench({platform,section,onSection,onNavigateIdeas,connected=false,sessionReady=false,onNavigateAccounts,onSyncHandled}: {platform:string;section:AnalysisSection;onSection:(section:AnalysisSection)=>void;onNavigateIdeas:()=>void;connected?:boolean;sessionReady?:boolean;onNavigateAccounts?:()=>void;onSyncHandled?:()=>void}) {
 const [accounts,setAccounts] = useState<AnalysisAccount[]>([]);
 const [accountId,setAccountId] = useState('');
 const [savedReport,setReport] = useState<AnalysisReport|null>(null);
 const report=savedReport?.account.platform===platform&&savedReport.account.accountId===accountId?savedReport:null;
 const [loading,setLoading] = useState(false);
 const [busy,setBusy] = useState(false);
 const [insightsBusy,setInsightsBusy] = useState(false);
 const [insightsError,setInsightsError] = useState('');
 const [insightsOpen,setInsightsOpen] = useState(false);
 const [error,setError] = useState('');
 const [notice,setNotice] = useState('');
 const [importOpen,setImportOpen] = useState(false);
 const [newAccount,setNewAccount] = useState('');
 const [accountName,setAccountName] = useState('');
 const [json,setJson] = useState('');
 const [title,setTitle] = useState('');
 const [body,setBody] = useState('');
 const [comments,setComments] = useState('');
 const [coverText,setCoverText] = useState('');
 const [transcript,setTranscript] = useState('');
 const [preview,setPreview] = useState<{platform:string;accountId:string;name:string;contents:unknown[]}|null>(null);
 const [draftText,setDraftText] = useState<Record<string,string>>({});
 const [tags,setTags] = useState('');
 const [contentId,setContentId] = useState('');
 const [publishedAt,setPublishedAt] = useState('');
 const [format,setFormat] = useState('图文');
 const [query,setQuery] = useState('');
 const [selected,setSelected] = useState('');
 const [hypothesis,setHypothesis] = useState('');
 const [action,setAction] = useState('');
 const [experimentTitle,setExperimentTitle] = useState('');
 const [metric,setMetric] = useState<ExperimentMetric>('collects');
 const [experimentEvidence,setExperimentEvidence] = useState<TopicEvidence|null>(null);
 const [reviewAt,setReviewAt] = useState('');
 const [experimentContents,setExperimentContents] = useState<string[]>([]);
 const [conclusions,setConclusions] = useState<Record<string,string>>({});
 const [syncState,setSyncState]=useState<AnalysisSyncState|null>(null);
 const [syncBusy,setSyncBusy]=useState(false);
 const [question,setQuestion]=useState<'promise'|'interaction'|'topics'>('promise');
 const syncGeneration=useRef(0);
 const startedSync=useRef('');
 const syncHandled=useRef(onSyncHandled);
 syncHandled.current=onSyncHandled;
 const generation = useRef(0);
 const scopeVersion = useRef(0);
 const refresh = useCallback(async (preferred?:string) => {
  const n = ++generation.current; setInsightsBusy(false); setInsightsError(''); setLoading(true); setError('');setReport(null);
  try {
   const data = await analysisRequest<{accounts:AnalysisAccount[]}>('/accounts');
   if (n !== generation.current) return;
   const list = data.accounts.filter(a=>a.platform===platform); setAccounts(list);
   const id = preferred && list.some(a=>a.accountId===preferred) ? preferred : list[0]?.accountId || '';
   setAccountId(id);
   if (!id) { setReport(null); return; }
   const result = await analysisRequest<AnalysisReport>(`/report?platform=${encodeURIComponent(platform)}&accountId=${encodeURIComponent(id)}`);
   if (n===generation.current) setReport(validateAnalysisReport(result,platform,id));
  } catch(e) { if(n===generation.current) { setError(e instanceof Error ? e.message : '读取失败'); setReport(null); } }
  finally {if(n===generation.current)setLoading(false);}
 },[platform]);
 useEffect(()=>{scopeVersion.current+=1;setReport(null);setAccountId('');setSelected('');setQuery('');setNotice('');setImportOpen(false);setNewAccount('');setAccountName('');setJson('');setPreview(null);setExperimentContents([]);setExperimentEvidence(null);setExperimentTitle('');setHypothesis('');setAction('');setReviewAt('');setDraftText({});setConclusions({});setTitle('');setBody('');setTags('');setComments('');setCoverText('');setTranscript('');setContentId('');setPublishedAt('');setBusy(false);void refresh();return()=>{generation.current+=1;scopeVersion.current+=1;};},[refresh]);
 const syncPlatform=useCallback(async(force=false,targetId?:string)=>{
  const n=++syncGeneration.current;const version=scopeVersion.current;
  setSyncBusy(true);setSyncState(previous=>previous?{...previous,status:'syncing',message:'正在读取当前登录账号的作品…'}:null);
  try{
   const result=await analysisRequest<AnalysisSyncState>('/sync','POST',{platform,...(targetId?{accountId:targetId}:{}),force});
   if(n!==syncGeneration.current||version!==scopeVersion.current)return;
   if(result.scope.platform!==platform)throw new Error('同步结果平台不一致，已阻止展示。');
   if(result.report&&result.scope.accountId){
    if(targetId&&result.scope.accountId!==targetId)throw new Error('同步结果账号不一致，已阻止展示。');
    validateAnalysisReport(result.report,platform,result.scope.accountId);
    await refresh(result.scope.accountId);
    if(n!==syncGeneration.current||version!==scopeVersion.current)return;
   }else if(result.status==='empty'&&result.scope.accountId){
    const id=result.scope.accountId;
    if(targetId&&id!==targetId)throw new Error('同步结果账号不一致，已阻止展示。');
    setAccountId(id);setReport(null);
    setAccounts(previous=>previous.some(item=>item.accountId===id)?previous:[...previous,{platform,accountId:id,name:result.accountName||id,contentCount:0}]);
   }
   setSyncState(result);
  }catch(reason){if(n===syncGeneration.current&&version===scopeVersion.current)setSyncState({scope:{platform,accountId:targetId||null},status:'error',supported:true,loadedCount:0,totalCount:null,totalKnown:false,complete:false,fetchedAt:null,message:reason instanceof Error?reason.message:'作品读取失败，请重试。',retryable:true});}
  finally{if(n===syncGeneration.current&&version===scopeVersion.current){setSyncBusy(false);syncHandled.current?.();}}
 },[platform,refresh]);
 useEffect(()=>{
  if(!sessionReady)return;
  const key=`${platform}:${connected}`;if(startedSync.current===key)return;startedSync.current=key;
  const n=++syncGeneration.current;const version=scopeVersion.current;
  setSyncBusy(false);setSyncState(null);
  void(async()=>{
   try{
    const state=await analysisRequest<AnalysisSyncState>(`/sync/status?platform=${encodeURIComponent(platform)}`);
    if(n!==syncGeneration.current||version!==scopeVersion.current)return;
    if(state.scope.platform!==platform)throw new Error('作品来源与当前平台不一致，已阻止展示。');
    setSyncState(state);
    if(connected&&state.supported){
     if(state.report&&state.scope.accountId){validateAnalysisReport(state.report,platform,state.scope.accountId);await refresh(state.scope.accountId);syncHandled.current?.();}
     else await syncPlatform();
    }else syncHandled.current?.();
   }catch(reason){if(n===syncGeneration.current&&version===scopeVersion.current)setSyncState({scope:{platform,accountId:null},status:'error',supported:false,loadedCount:0,totalCount:null,totalKnown:false,complete:false,fetchedAt:null,message:reason instanceof Error?reason.message:'同步状态读取失败。',retryable:true});}
  })();
  return()=>{syncGeneration.current+=1;if(startedSync.current===key)startedSync.current='';};
 },[platform,connected,sessionReady,refresh,syncPlatform]);
 const run = async (task:(isCurrent:()=>boolean)=>Promise<void>) => {const token=scopeVersion.current;const isCurrent=()=>token===scopeVersion.current;setBusy(true);setError('');setNotice('');try{await task(isCurrent);}catch(e){if(isCurrent())setError(e instanceof Error?e.message:'操作失败');}finally{if(isCurrent())setBusy(false);}};
 const requestInsights = async () => {
  const n = generation.current;
  setInsightsOpen(true); setInsightsBusy(true); setInsightsError(''); setError(''); setNotice('');
  try {
   await analysisRequest('/insights','POST',{platform,accountId});
   if (n !== generation.current) return;
   await refresh(accountId);
  } catch(e) { if(n === generation.current) setInsightsError(e instanceof Error ? e.message : '账号解读失败'); }
  finally { if(n === generation.current) setInsightsBusy(false); }
 };
 const importData = () => run(async()=>{
  const id = newAccount.trim() || accountId;
  if(!id)throw new Error('请填写记录所属的账号 ID。');
  const parsed = json.trim() ? JSON.parse(json) : {contents:[{id:contentId.trim(),title:title.trim(),body,comments:comments.split('\n').map(c=>c.trim()).filter(Boolean),coverText,transcript,tags:tags.split(/[,，\n]/).map(t=>t.trim()).filter(Boolean),format,publishedAt:publishedAt?new Date(publishedAt).toISOString():report?.contents.find(c=>c.id===contentId.trim())?.publishedAt||null}]};
  if(!parsed||typeof parsed!=='object')throw new Error('JSON 必须为作品数组或含 contents 的对象。');
  const contents = Array.isArray(parsed) ? parsed : parsed.contents;
  if(!Array.isArray(contents)||!contents.length)throw new Error('文件需包含非空 contents 数组。');
  const ids = new Set<string>();
  for(const item of contents){
   if(!item||typeof item!=='object'||typeof item.id!=='string'||!item.id.trim())throw new Error('每篇作品必须提供非空的稳定 id。');
   if(ids.has(item.id))throw new Error(`作品 ID 重复：${item.id}`);ids.add(item.id);
   if(item.accountId && item.accountId!==id)throw new Error(`作品 ${item.id} 的账号与当前选择不一致。`);
   for(const key of keys){const value=item.metrics?.[key];if(value!=null&&(typeof value!=='number'||!Number.isFinite(value)||value<0))throw new Error(`${item.id} 的 ${METRICS[key]} 必须是非负数字或 null。`);}
   for(const key of advancedKeys){const value=item.advancedMetrics?.[key];if(value!=null&&(typeof value!=='number'||!Number.isFinite(value)||value<0))throw new Error(`${item.id} 的 ${EXPERIMENT_METRICS[key]} 必须是非负数字或 null。`);}
   if(item.paid!=null&&typeof item.paid!=='boolean')throw new Error(`${item.id} 的投放状态 paid 必须为 true、false 或 null。`);
  }
  if(parsed.platform && parsed.platform!==platform)throw new Error('文件平台与所选平台不一致，请切换平台。');
  if(parsed.accountId && parsed.accountId!==id)throw new Error('文件账号与所填账号 ID 不一致。');
  setPreview({platform,accountId:id,name:accountName.trim()||accounts.find(a=>a.accountId===id)?.name||id,contents});
 });
 const confirmImport = () => run(async(isCurrent)=>{if(!preview)return;if(preview.platform!==platform)throw new Error('导入预览所属平台已变化，请重新校验。');await analysisRequest('/import','POST',preview);if(!isCurrent())return;await refresh(preview.accountId);if(!isCurrent())return;setPreview(null);setImportOpen(false);setJson('');setTitle('');setBody('');setComments('');setCoverText('');setTranscript('');setContentId('');setNotice('记录已保存，诊断基于本次提供的真实材料生成。');});
 const filtered = report?.contents.filter(c=>`${c.title} ${c.tags.join(' ')} ${c.format}`.toLowerCase().includes(query.trim().toLowerCase())) || [];
 const content = filtered.find(c=>c.id===selected);
 const choose = (item:AnalysisContent) => {setQuery('');setSelected(item.id);onSection('works');};
 const plan = (item:AnalysisContent, suggestion:string) => {setExperimentEvidence(null);setExperimentTitle(`验证：${item.title}`);setHypothesis('');setAction(suggestion);setExperimentContents([item.id]);onSection('experiments');};
 const addIdea = (item:AnalysisContent,suggestion:string) => run(async(isCurrent)=>{await createIdea({title:item.title,note:`内容复盘建议：${suggestion}\n依据作品：${item.id}\n平台：${platform}\n账号：${accountId}\n此建议为待验证假设。`,source:'内容分析',status:'pending'});if(isCurrent())setNotice('已加入选题库。');});
 const planTopic=(topic:AnalysisTopic)=>{if(!report)return;setExperimentEvidence(topicEvidence(report,topic));setExperimentTitle(`验证题材：${topic.label}`);setHypothesis(topic.hypothesis);setAction(topic.action);setMetric(topic.metric);setExperimentContents([...topic.evidenceIds]);setReviewAt(topic.reviewAt.slice(0,10));onSection('experiments');};
 const saveTopic=(topic:AnalysisTopic)=>run(async(isCurrent)=>{if(!report)return;const evidence=topicEvidence(report,topic);await createIdea({title:topic.label,note:topicIdeaNote(evidence),source:'内容分析 · 证据题材',status:'pending'});if(isCurrent())setNotice('题材与当前证据快照已加入选题库；后续采集不会改写此版本。');});
 const currentSync=syncState?.scope.platform===platform&&(!syncState.scope.accountId||!accountId||syncState.scope.accountId===accountId)?syncState:null;
 const questions=[{id:'promise' as const,label:'标题和内容哪里不清楚？',description:'打开实际文字材料，检查承诺、步骤与读者理解。'},{id:'interaction' as const,label:'为什么播放或互动表现不同？',description:'核对时间和指标；缺少同条件作品时先说明缺什么。'},{id:'topics' as const,label:'下一篇写什么更有依据？',description:'从真实主题和评论追问里找候选，保存一项验证。'}];
 const questionHelp=question==='promise'?'需要至少一篇真实标题和正文 / 逐字稿。只有标题时只能检查标题，不评价视频画面。':question==='interaction'?'需要至少两篇同条件作品和同窗口指标。只有累计播放或点赞时，不能解释表现差异的原因。':'需要至少两篇同主题作品，或真实评论问题。候选是待验证方向，不保证流量。';
 const firstFinding=report?.contents.flatMap(item=>item.diagnostics.map(finding=>({item,finding})))[0];
 const syncDate=currentSync?.fetchedAt?new Date(typeof currentSync.fetchedAt==='number'?currentSync.fetchedAt*1000:currentSync.fetchedAt).toLocaleString('zh-CN'):'尚未同步';
 return <section className="ca-bench" aria-label="内容分析工作台">
  <section className="ca-start-card ca-sync-card" aria-label="账号作品载入状态"><div className="ca-card-heading"><div><p className="ca-kicker">1 / 账号与作品</p><h2>{report?.account.name||currentSync?.accountName||'先读取你的作品'}</h2></div><span className="ca-caption">{accountId?`账号 ${accountId}`:'当前平台的登录账号'}</span></div>
  {accounts.length>0&&<div className="ca-account-filter"><label>记录所属账号<Select value={accountId} disabled={loading||busy} onChange={e=>{scopeVersion.current+=1;setExperimentEvidence(null);setBusy(false);setSelected('');setPreview(null);setNewAccount('');setAccountName('');setImportOpen(false);setExperimentContents([]);setQuery('');setDraftText({});setConclusions({});setExperimentTitle('');setHypothesis('');setAction('');setReviewAt('');setJson('');setTitle('');setBody('');setTags('');setComments('');setCoverText('');setTranscript('');setContentId('');setPublishedAt('');setNotice('');const target=e.target.value;syncGeneration.current+=1;setSyncBusy(false);setSyncState(null);void(async()=>{await refresh(target);if(connected&&sessionReady)await syncPlatform(false,target);})();}}>{accounts.map(a=><option key={a.accountId} value={a.accountId}>{a.name} · {a.accountId}</option>)}</Select></label><span>{report?.quality.identity==='user_declared'?'归属由用户声明':'归属状态以采集证据为准'} · 最近入库 {date(report?.overview.lastImportedAt)}</span><button className="ca-text-button" disabled={loading} onClick={()=>void refresh(accountId)}>刷新记录</button></div>}
    <p role="status">{syncBusy?'正在读取作品，平台验证可能需要一些时间…':!sessionReady?'正在读取账号连接状态…':!connected?'尚未连接账号。可登录后自动读取，或导入你有权使用的作品记录。':currentSync?.message||'先读取已保存记录，再检查当前登录账号能否同步。'}</p>
    <div className="ca-sync-facts"><span>已载入 <strong>{report?.overview.contentCount??currentSync?.loadedCount??0}</strong> 篇</span><span>平台作品总量 <strong>{currentSync?.totalKnown&&currentSync.totalCount!=null?`${currentSync.totalCount} 篇`:'尚未确认'}</strong></span><span>数据时间 <strong>{syncDate}</strong></span></div>
    <p className="ca-caption">{currentSync?.complete?'覆盖范围以平台实际回执为准。':'已载入数是本机保存的记录，不代表全部历史。小红书与 B 站当前一次读取最近一页，最多 20 篇。'}</p>
    <div className="ca-bench-actions">{!connected&&onNavigateAccounts&&<button type="button" className="btn btn-primary btn-sm" onClick={onNavigateAccounts}>连接账号</button>}{connected&&(currentSync?.supported||currentSync?.retryable)&&<button type="button" className="btn btn-sm" disabled={syncBusy||busy||loading} onClick={()=>void syncPlatform(true,accountId||undefined)}>{syncBusy?'读取中…':currentSync?.status==='error'?'重试读取作品':'刷新平台作品'}</button>}{currentSync?.status==='account_mismatch'&&<button type="button" className="btn btn-primary btn-sm" disabled={syncBusy||busy||loading} onClick={()=>void syncPlatform(false)}>读取当前登录账号</button>}<button type="button" className="btn btn-sm" onClick={()=>setImportOpen(true)}>导入已有作品 / 补充材料</button></div>
  </section>
  {section==='review'&&<section className="ca-start-card" aria-label="选择复盘问题"><p className="ca-kicker">2 / 想解决什么问题</p><h2>先选一个问题，知道下一步看哪里</h2><div className="ca-question-grid">{questions.map(item=><button type="button" key={item.id} aria-pressed={question===item.id} onClick={()=>setQuestion(item.id)}><strong>{item.label}</strong><span>{item.description}</span></button>)}</div><p className="ca-caption">{questionHelp}</p></section>}
  {section==='review'&&<section className="ca-start-card" aria-label="当前结论与行动"><p className="ca-kicker">3 / 结论与行动</p><h2>{!report?'作品载入后，这里给出有依据的下一步':question==='promise'?'先核对一篇作品的真实材料':question==='interaction'?'先确认这些作品能不能公平比较':'从已有证据找下一篇方向'}</h2>
    {!report?<p>先在上方连接账号并读取作品，或导入记录。没有作品时不生成结论；文字诊断至少需要一篇，主题与表现比较通常需要两篇及以上。</p>:question==='promise'?<><p>{firstFinding?firstFinding.finding.observation:'当前记录尚没有可引用的文字诊断。请补充正文或逐字稿，再查看作品。'}</p>{firstFinding&&<p><strong>可以先做：</strong>{firstFinding.finding.action}</p>}<button type="button" className="btn btn-sm" onClick={()=>{if(firstFinding)choose(firstFinding.item);else onSection('works');}}>打开作品与依据</button></>:question==='interaction'?<><p>{report.professional?.quality.comparable?`当前 ${report.professional.quality.comparable} 篇具备已核验的比较条件。先看具体指标与排除原因；相关差异不能证明算法原因。`:'当前缺少同条件比较证据，暂时不能判断哪篇表现更好或解释原因。先补发布时间、观察时间、统计窗口和投放状态。'}</p><button type="button" className="btn btn-sm" onClick={()=>onSection('method')}>查看缺少哪些数据</button></>:<><p>{report.professional?.topics.length?`当前有 ${report.professional.topics.length} 个来自真实标签或评论的候选方向。核对作品依据，再挑一项改动。`:'暂未形成题材候选。补充至少两篇同主题作品或实际评论追问后再看。'}</p><button type="button" className="btn btn-sm" onClick={()=>onSection('themes')}>查看方向与验证计划</button></>}
  </section>}
  {(section==='review'||section==='method'||!report)&&<details className="ca-analysis-details" open={section==='method'||undefined}><summary>可选：分析能力、所需材料与平台资料</summary><AnalysisCapabilities platform={platform} report={report} onAdd={()=>setImportOpen(true)}/></details>}
  {report&&(section==='review'||section==='themes')&&<details className="ca-analysis-details" open={section==='themes'||undefined}><summary>查看专业证据、比较条件与题材建议</summary><ProfessionalAnalysisPanel report={report} busy={busy} onChoose={choose} onPlan={planTopic} onSave={topic=>void saveTopic(topic)}/></details>}
  <div className="ca-bench-toolbar"><div><p className="ca-kicker">YOUR CONTENT / 持续复盘</p><h2>让每次创作留下依据</h2><p>保存真实记录、细读作品材料，把发现变成下一次实验。</p></div><div className="ca-bench-actions"><button className="btn btn-primary btn-sm" onClick={()=>setImportOpen(v=>!v)}>{importOpen?'收起录入':'导入 / 录入作品'}</button>{accountId&&!loading&&<><a className="btn btn-sm" href={analysisUrl(`/export?platform=${encodeURIComponent(platform)}&accountId=${encodeURIComponent(accountId)}&format=markdown`)} download>导出复盘</a></>}</div></div>
  {error&&<div className="ca-error" role="alert">{error}<button className="ca-text-button" disabled={busy} onClick={()=>void refresh(accountId)}>重新读取</button></div>}
  {notice&&<div className="ca-bench-notice" role="status">{notice}<button className="ca-text-button" onClick={onNavigateIdeas}>选题库 →</button></div>}
  {importOpen&&<form className="ca-entry" onChange={()=>setPreview(null)} onSubmit={e=>{e.preventDefault();void importData();}}><div className="ca-section-intro"><h3>保存你拥有的作品记录</h3><p>账号归属由你声明；导入不会伪装成平台核验。重复 ID 更新同一篇作品，并保留观测记录。空指标保持缺失。</p></div><div className="ca-form-grid"><label>账号 ID<input value={newAccount||accountId} onChange={e=>setNewAccount(e.target.value)} placeholder="填写稳定的平台账号标识" required/></label><label>账号显示名称<input value={accountName} onChange={e=>setAccountName(e.target.value)} placeholder="便于区分的名称"/></label></div><details><summary>批量导入 JSON（含指标与快照时间）</summary><a className="ca-text-button" href={analysisUrl(`/template?platform=${encodeURIComponent(platform)}`)} download>下载字段模板</a><label className="ca-file-label">选择 JSON 文件<input type="file" accept=".json,application/json" onChange={e=>{const file=e.target.files?.[0];if(file){if(file.size>5*1024*1024){setError('文件请控制在 5 MB 内。');return;}const token=scopeVersion.current;void file.text().then(value=>{if(token!==scopeVersion.current)return;setJson(value);setPreview(null);}).catch(()=>{if(token===scopeVersion.current)setError('文件读取失败。');});}}}/></label><label>JSON 内容<textarea rows={6} value={json} onChange={e=>setJson(e.target.value)} placeholder={'{"contents": [{"id": "作品真实ID", "title": "作品标题", "metrics": {"views": 120}, "period": "lifetime"}]}'}/></label></details>{!json.trim()&&<><div className="ca-form-grid"><label>作品稳定 ID<input value={contentId} onChange={e=>setContentId(e.target.value)} required placeholder="原平台作品 ID 或稳定的本地记录编号"/></label><label>发布时间（可留空）<input type="datetime-local" value={publishedAt} onChange={e=>setPublishedAt(e.target.value)}/></label></div><label>真实标题<input value={title} onChange={e=>setTitle(e.target.value)} required maxLength={500}/></label><label>正文 / 视频口播转写<textarea value={body} onChange={e=>setBody(e.target.value)} rows={7} placeholder="粘贴实际发布材料；仅有标题时不生成正文结构诊断。"/></label><label>真实封面文字 / OCR 转写<textarea value={coverText} onChange={e=>setCoverText(e.target.value)} rows={2} placeholder="这里只诊断文字，不推测封面配色与构图"/></label><label>视频逐字稿<textarea value={transcript} onChange={e=>setTranscript(e.target.value)} rows={4} placeholder="可保留时间标记；未提供视频不会判断镜头或节奏"/></label><label>实际评论（一行一条）<textarea value={comments} onChange={e=>setComments(e.target.value)} rows={4} placeholder="只提供你有权使用的真实评论，建议先移除个人信息"/></label><div className="ca-form-grid"><label>主题标签（逗号分隔）<input value={tags} onChange={e=>setTags(e.target.value)}/></label><label>内容形式<Select value={format} onChange={e=>setFormat(e.target.value)}><option>图文</option><option>视频</option><option>文章</option><option>回答</option><option>其他</option></Select></label></div></>}<div className="ca-bench-actions"><button className="btn btn-primary" disabled={busy}>{busy?'校验中…':'校验并预览'}</button><button type="button" className="btn" onClick={()=>{setImportOpen(false);setPreview(null);}}>取消</button></div></form>}
  {preview&&<div className="ca-paper ca-import-preview" role="region" aria-label="导入预览"><p className="ca-kicker">IMPORT REVIEW / 核对后入库</p><h3>即将保存 {preview.contents.length} 篇作品</h3><p>平台：{preview.platform} · 账号：{preview.name}（{preview.accountId}）</p><p className="ca-caption">以下内容尚未写入。相同作品 ID 更新已有作品；指标快照保留历史。请核对归属和材料。</p><pre>{JSON.stringify(preview.contents,null,2)}</pre><div className="ca-bench-actions"><button className="btn btn-primary" disabled={busy} onClick={()=>void confirmImport()}>{busy?"正在写入…":"确认归属并保存"}</button><button className="btn" disabled={busy} onClick={()=>setPreview(null)}>返回修改</button></div></div>}
  {loading?<div className="ca-loading" role="status">正在读取作品与复盘记录…</div>:!report?<div className="ca-bench-empty"><span className="ca-empty-mark" aria-hidden="true">◫</span><h3>从第一篇真实作品开始</h3><p>录入标题与正文即可做材料诊断；导入带指标的记录，可继续分析主题、建立实验并回收结果。上方作品读取入口和文件导入都可使用。</p><button className="btn btn-primary" onClick={()=>setImportOpen(true)}>添加作品记录</button></div>:<>
   {section==='review'&&<><details className="ca-analysis-details" open={insightsOpen} onToggle={event=>setInsightsOpen(event.currentTarget.open)}><summary>可选：跨作品 AI 解读与平台重点</summary><AccountAnalysisInsights report={report} busy={insightsBusy||busy} error={insightsError} onRequest={()=>void requestInsights()} onChoose={choose} onPlan={(insight,ids)=>{setExperimentEvidence(null);setExperimentTitle('验证账号解读建议');setHypothesis(insight.observation);setAction(insight.action);setExperimentContents(ids);onSection('experiments');}}/></details><div className="ca-stat-grid"><article><span>本账号已保存作品</span><strong>{report.overview.contentCount}</strong><small>实际入库的样本</small></article><article><span>带正文的作品</span><strong>{report.contents.filter(c=>c.body?.trim()).length}</strong><small>支持材料结构诊断</small></article><article><span>主题标签</span><strong>{report.themes.length}</strong><small>仅来自提供的标签</small></article><article><span>待回收实验</span><strong>{report.experiments.filter(e=>e.status!=='reviewed').length}</strong><small>记录假设与观察结果</small></article></div><div className="ca-bench-columns"><div className="ca-paper"><div className="ca-card-heading"><h3>本次值得细读</h3><button className="ca-text-button" onClick={()=>{setQuery('');onSection('works');}}>全部作品 →</button></div><p className="ca-caption">按记录顺序展示，不用不同年龄作品的累计数据评优劣。</p>{report.contents.slice(0,4).map(c=><button className="ca-work-row" key={c.id} onClick={()=>choose(c)}><div><strong>{c.title}</strong><span>{c.format} · {c.diagnostics.length} 条材料观察</span></div><span aria-hidden="true">↗</span></button>)}</div><div className="ca-paper ca-next-step"><p className="ca-kicker">NEXT MOVE</p><h3>一篇作品，一个验证问题</h3><p>先打开作品读证据，再选择一项具体改动。记录目标指标和复盘日期，避免只看结果再解释原因。</p><button className="btn btn-sm" onClick={()=>onSection('experiments')}>制定实验</button><h4>样本指标覆盖</h4>{keys.map(k=><div className="ca-coverage" key={k}><span>{METRICS[k]}</span><strong>{show(report.overview.metricCoverage[k])} / {report.overview.contentCount} 篇</strong></div>)}</div></div></>}
   {section==='works'&&<div className="ca-works-layout"><div className="ca-paper"><label className="ca-search-label">查找作品<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索标题、标签或形式"/></label><p className="ca-caption">{filtered.length} 篇匹配作品</p>{filtered.map(c=><button key={c.id} className={`ca-work-row ${selected===c.id?'is-active':''}`} aria-pressed={selected===c.id} onClick={()=>setSelected(c.id)}><div><strong>{c.title}</strong><span>{c.format} · {c.tags.join(' / ')||'未标记主题'}</span></div></button>)}{!filtered.length&&<p className="ca-caption">没有匹配作品，请调整搜索。</p>}</div><article className="ca-paper ca-work-detail">{!content?<div className="ca-bench-empty"><h3>{filtered.length?"选择一篇作品，展开证据":"没有匹配的作品"}</h3><p>{filtered.length?"这里会显示原始材料、指标、诊断建议与下一步行动。":"请调整搜索条件，或清空搜索查看全部作品。"}</p>{query&&<button className="btn btn-sm" onClick={()=>setQuery('')}>清空搜索</button>}</div>:<><p className="ca-kicker">CONTENT DETAIL / 作品细读</p><h3>{content.title}</h3><p className="ca-caption">{content.format} · 发布 {date(content.publishedAt)} · 观测 {date(content.snapshotAt)}</p>{safeUrl(content.url)&&<a href={safeUrl(content.url)} target="_blank" rel="noreferrer" className="ca-text-button">查看原作品 ↗</a>}<div className="ca-metric-strip">{keys.map(k=><div key={k}><span>{METRICS[k]}</span><strong>{show(content.metrics[k])}</strong></div>)}</div><p className="ca-caption">{content.period==='lifetime'?'平台累计指标':'统计窗口未明确'}；— 表示缺失，不代表 0。</p><details className="ca-material"><summary>扩展指标与投放状态</summary><p>投放：{content.paid==null?'未知':content.paid?'有投放':'无投放'}</p><div className="ca-metric-strip">{advancedKeys.map(k=><div key={k}><span>{EXPERIMENT_METRICS[k]}</span><strong>{show(content.advancedMetrics?.[k])}</strong></div>)}</div><p className="ca-caption">次数与秒数按字段保存；未提供的字段不推算。扩展字段请通过带同窗口快照的 JSON 或平台实际返回值补充。</p></details><details className="ca-material"><summary>查看实际正文 / 转写材料</summary><p>{content.body||'尚未提供正文，以下诊断仅依据已有材料。'}</p></details><details className="ca-material"><summary>查看已保存观测历史（{content.snapshots?.length||0} 次）</summary>{content.snapshots?.map((s,i)=><p key={i}>{date(s.snapshotAt)} · {s.period} · {keys.map(k=>`${METRICS[k]} ${show(s.metrics[k])}`).join(" / ")}</p>)}</details><h4>有依据的材料观察</h4>{content.diagnostics.length?content.diagnostics.map(d=><section className="ca-diagnostic" key={d.id}><span className="ca-dimension">{d.dimension}</span><h4>{d.observation}</h4><blockquote>{d.evidence}</blockquote><p><strong>可尝试：</strong>{d.action}</p><p className="ca-caption">{d.limitation}</p><div className="ca-bench-actions"><button className="ca-text-button" onClick={()=>plan(content,d.action)}>建立验证实验 →</button><button className="ca-text-button" disabled={busy} onClick={()=>void addIdea(content,d.action)}>加入选题库</button></div></section>):<p className="ca-caption">当前材料没有触发可用诊断。可以补充真实正文后，用同一作品 ID 再次保存。</p>}<section className="ca-diagnostic"><div className="ca-card-heading"><h4>AI 深度解释</h4><button className="btn btn-sm" disabled={busy} onClick={()=>void run(async(isCurrent)=>{await analysisRequest('/interpret','POST',{platform,accountId,contentId:content.id});if(!isCurrent())return;await refresh(accountId);if(isCurrent())setNotice('已保存通过原文引用校验的模型解释。');})}>{busy?'处理中…':'请求模型解释'}</button></div><p className="ca-caption">点击将把当前作品的文字材料与指标发送至已配置的模型服务。默认规则诊断在本地完成；模型解释仍是待验证假设。</p>{content.aiReview&&<><p className="ca-caption">{content.aiReview.model} · {date(content.aiReview.at)}</p>{content.aiReview.findings.map((f,i)=><div key={i}><blockquote>{f.quote}</blockquote><p>{f.interpretation}</p><p><strong>可尝试：</strong>{f.action}</p><button className="ca-text-button" onClick={()=>plan(content,f.action)}>建立验证实验 →</button></div>)}<p className="ca-caption">{content.aiReview.notice}</p></>}</section>{content.draft&&<section className="ca-diagnostic"><h4>下一篇的写作起点</h4><p className="ca-caption">这是基于已有材料的待编辑提纲。请核对事实并补充证据后再使用。</p><label>修改标题方向与提纲<textarea rows={10} value={draftText[content.id]??[...content.draft.titleOptions,'',...content.draft.outline,'',content.draft.audienceQuestion].join('\n')} onChange={e=>setDraftText({...draftText,[content.id]:e.target.value})}/></label><button className="ca-text-button" disabled={busy} onClick={()=>void addIdea(content,draftText[content.id]??[...content.draft!.titleOptions,...content.draft!.outline,content.draft!.audienceQuestion].join('\n'))}>把编辑后的提纲加入选题库 →</button></section>}<button className="btn btn-sm" onClick={()=>{setContentId(content.id);setTitle(content.title);setBody(content.body||'');setTags(content.tags.join('，'));setFormat(content.format);setComments(content.comments?.join('\n')||'');setCoverText(content.coverText||'');setTranscript(content.transcript||'');setPublishedAt(content.publishedAt?new Date(new Date(content.publishedAt).getTime()-new Date(content.publishedAt).getTimezoneOffset()*60000).toISOString().slice(0,16):'');setJson('');setPreview(null);setNewAccount(accountId);setImportOpen(true);}}>补充 / 更新材料</button></>}</article></div>}
   {section==='themes'&&<><div className="ca-section-intro"><h3>主题与形式</h3><p>标签反映你提供的分类。样本合计不用于跨主题排名，作品年龄、付费流量和分母不齐时无法判断效果差异。</p></div><div className="ca-theme-grid">{report.themes.map(t=><article className="ca-paper" key={t.tag}><p className="ca-kicker">THEME / {t.count} 篇</p><h3>#{t.tag}</h3><p className="ca-caption">{keys.map(k=>`${METRICS[k]} ${show(t.metrics[k])}（${show(t.coverage?.[k])}/${t.count} 篇有值）`).join(' · ')}</p>{report.contents.filter(c=>t.contentIds.includes(c.id)).map(c=><button className="ca-work-row" key={c.id} onClick={()=>choose(c)}><div><strong>{c.title}</strong><span>{c.format}</span></div><span>→</span></button>)}</article>)}</div>{!report.themes.length&&<div className="ca-loading">还没有主题标签。打开作品补充标签，即可按真实分类复盘。</div>}<div className="ca-paper"><h3>内容形式分布</h3>{Array.from(new Set(report.contents.map(c=>c.format))).map(f=><div className="ca-format-row" key={f}><strong>{f}</strong><span>{report.contents.filter(c=>c.format===f).length} 篇</span><button className="ca-text-button" onClick={()=>{setQuery(f);onSection('works');}}>查看作品 →</button></div>)}</div></>}
   {section==='experiments'&&<div className="ca-bench-columns"><form className="ca-paper ca-entry" onSubmit={e=>{e.preventDefault();void run(async(isCurrent)=>{await analysisRequest('/experiments','POST',{platform,accountId,title:experimentTitle,hypothesis,action,metric,contentIds:experimentContents,reviewAt:reviewAt?new Date(reviewAt).toISOString():null,...(experimentEvidence?{evidence:experimentEvidence}:{})});if(!isCurrent())return;await refresh(accountId);if(!isCurrent())return;setExperimentEvidence(null);setExperimentTitle('');setHypothesis('');setAction('');setExperimentContents([]);setNotice('实验已建立，基线与题材证据已按当前真实记录保存。');});}}><p className="ca-kicker">NEW EXPERIMENT</p><h3>把建议写成可验证的改动</h3>{experimentEvidence&&<div className="ca-experiment-evidence" role="status"><strong>题材证据已固定：{experimentEvidence.topic.label}</strong><p>{experimentEvidence.topic.sampleCount}/{experimentEvidence.topic.totalCount} 篇 · {experimentEvidence.topic.period||"未形成可比窗口"} · 比较指标 {experimentEvidence.topic.metricLabel} · 实验主指标 {EXPERIMENT_METRICS[experimentEvidence.topic.metric]}</p><p>7 天回收停止规则：{experimentEvidence.topic.stopRule}</p><p className="ca-caption">引用作品与主指标随证据固定；保存时服务端再次核验题材。</p><button type="button" className="ca-text-button" onClick={()=>setExperimentEvidence(null)}>改为手动实验</button></div>}<label>实验名称<input required value={experimentTitle} onChange={e=>setExperimentTitle(e.target.value)} placeholder="例如：验证开头是否需要更快交代结论"/></label><label>待验证假设<textarea required rows={3} value={hypothesis} onChange={e=>setHypothesis(e.target.value)} placeholder="说明预期变化及理由，不预设成功"/></label><label>本次只改变什么<textarea required rows={3} value={action} onChange={e=>setAction(e.target.value)}/></label><div className="ca-form-grid"><label>观察指标<Select value={metric} disabled={Boolean(experimentEvidence)} onChange={e=>setMetric(e.target.value as ExperimentMetric)}>{(Object.keys(EXPERIMENT_METRICS) as ExperimentMetric[]).map(k=><option key={k} value={k}>{EXPERIMENT_METRICS[k]}</option>)}</Select></label><label>计划复盘日期<input type="date" value={reviewAt} onChange={e=>setReviewAt(e.target.value)}/></label></div><fieldset><legend>关联作品（至少一篇）</legend>{report.contents.map(c=><label className="ca-check" key={c.id}><input type="checkbox" disabled={Boolean(experimentEvidence)} checked={experimentContents.includes(c.id)} onChange={e=>setExperimentContents(ids=>e.target.checked?[...ids,c.id]:ids.filter(id=>id!==c.id))}/><span>{c.title}</span></label>)}</fieldset><p className="ca-caption">先导入新观测记录，再回收实验。累计值的自然增长不能证明改动有效。</p><button className="btn btn-primary" disabled={busy||!experimentContents.length}>保存实验与基线</button></form><div><h3>实验记录 · {report.experiments.length}</h3>{!report.experiments.length&&<div className="ca-paper"><p>还没有实验。左侧选择作品与指标，记录第一个假设。</p></div>}{report.experiments.map(e=><article className="ca-paper ca-experiment" key={e.id}><div className="ca-card-heading"><span className="ca-dimension">{{planned:'待执行',running:'进行中',reviewed:'已回收'}[e.status]}</span><small>{e.reviewAt?`复盘 ${date(e.reviewAt)}`:'未设复盘日'}</small></div><h3>{e.title}</h3><p><strong>假设：</strong>{e.hypothesis}</p><p><strong>改动：</strong>{e.action}</p><p className="ca-caption">观察 {EXPERIMENT_METRICS[e.metric]} · {e.contentIds.length} 篇作品</p>{e.evidence&&<details><summary>查看保存时的题材证据</summary><pre className="ca-fixed-evidence">{JSON.stringify(e.evidence,null,2)}</pre></details>}<details><summary>查看基线与回收证据</summary>{e.baseline?.map(b=><p key={b.contentId}>{b.contentId}：基线 {show(b.value)} · {date(b.snapshotAt)}</p>)}{e.reviews?.map((r,i)=><div key={i}><p>回收 {date(r.at)}：{r.note}</p>{r.observations.map(o=><p key={o.contentId}>{o.contentId}：{show(o.value)}（相对基线 {o.delta==null?'不可计算':`${o.delta>0?'+':''}${show(o.delta)}`}） · {o.note}</p>)}</div>)}</details><label>复盘结论<textarea rows={3} value={conclusions[e.id]??e.conclusion??''} onChange={v=>setConclusions({...conclusions,[e.id]:v.target.value})} placeholder="记录支持与反例、样本不足和下一步"/></label><div className="ca-bench-actions">{e.status==='planned'&&<button className="btn btn-sm" disabled={busy} onClick={()=>void run(async(isCurrent)=>{await analysisRequest(`/experiments/${encodeURIComponent(e.id)}`,'PATCH',{platform,accountId,status:'running'});if(isCurrent())await refresh(accountId);})}>开始执行</button>}<button className="btn btn-primary btn-sm" disabled={busy} onClick={()=>void run(async(isCurrent)=>{const conclusion=(conclusions[e.id]??e.conclusion??'').trim();if(!conclusion)throw new Error('请填写复盘结论，包括不确定性或数据不足。');await analysisRequest(`/experiments/${encodeURIComponent(e.id)}`,'PATCH',{platform,accountId,status:'reviewed',conclusion});if(!isCurrent())return;await refresh(accountId);if(isCurrent())setNotice('已记录本次回收快照与结论。');})}>保存结论并回收</button></div></article>)}</div></div>}
   {section==='method'&&<div className="ca-paper"><h3>当前记录的数据质量</h3><p className="ca-caption">账号 {accountId} · {report.overview.contentCount} 篇作品 · {report.quality.identity==='user_declared'?'用户声明归属':'查看采集身份依据'}</p>{report.quality.warnings.map((w,i)=><p key={i}>• {w}</p>)}<div className="ca-table-wrap"><table><thead><tr><th>指标</th><th>有值作品数</th><th>同口径样本合计</th></tr></thead><tbody>{keys.map(k=><tr key={k}><td>{METRICS[k]}</td><td>{show(report.overview.metricCoverage[k])} / {report.overview.contentCount}</td><td>{show(report.overview.totals[k])}</td></tr>)}</tbody></table></div><p className="ca-caption">合计仅覆盖有值且统计窗口一致的记录，不是完整账号总量。窗口未知或混合时不合计；阅读与播放沿用各平台定义，不跨平台相加。</p><a className="ca-text-button" href={analysisUrl(`/export?platform=${encodeURIComponent(platform)}&accountId=${encodeURIComponent(accountId)}&format=json`)} download>导出完整 JSON 证据与实验记录 →</a></div>}
  </>}
 </section>;
}
