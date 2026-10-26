import {useRef,useState} from 'react';
import {taskRequest, stageReworkStages, type TaskGoal, type TaskRun, type StageReworkReceipt} from '../lib/tasks';
import TaskStageBoard from './TaskStageBoard';

export default function TaskStageRecovery({goal,runs,disabled,onChanged}:{goal:TaskGoal;runs:TaskRun[];disabled:boolean;onChanged:()=>void}) {
  const [draft,setDraft]=useState<{stageId:string;revision:number;reason:string;requestId:string}|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [receipts,setReceipts]=useState<StageReworkReceipt[]|null>(null),[historyBusy,setHistoryBusy]=useState(false);
  const returnFocus=useRef<HTMLElement|null>(null);
  const stages=goal.stages||[];
  const live=runs.some(run=>['queued','running','unconfirmed'].includes(run.state));
  const unavailable=disabled||busy||live||goal.status==='active'||!goal.revision;
  const terminal=goal.sessionDeleted||['completed','cancelled'].includes(goal.status);
  const versionChanged=!!draft&&draft.revision!==goal.revision;
  function select(stageId:string) {
    if(unavailable)return;
    returnFocus.current=document.activeElement as HTMLElement|null;
    setDraft({stageId,revision:goal.revision!,reason:'',requestId:crypto.randomUUID()});setError('');setNotice('');
  }
  async function confirm() {
    if(!draft||unavailable||versionChanged||draft.reason.trim().length<3)return;
    setBusy(true);setError('');
    try {
      await taskRequest(`/goals/${goal.id}/rework`,{...draft,reason:draft.reason.trim()});
      setDraft(null);setReceipts(null);setNotice('已准备重做，前往“验收与控制”继续目标。');onChanged();
    } catch(e) {setError(e instanceof Error?e.message:'保存失败，请重试');}
    finally {setBusy(false);}
  }
  async function history() {
    if(historyBusy)return;
    setHistoryBusy(true);setError('');
    try {setReceipts((await taskRequest<{receipts:StageReworkReceipt[]}>(`/goals/${goal.id}/reworks`)).receipts);}
    catch(e) {setError(e instanceof Error?e.message:'读取失败，请重试');}
    finally {setHistoryBusy(false);}
  }
  return <>
    <TaskStageBoard stages={stages} onRework={terminal?undefined:select} disabled={unavailable}/>
    {draft&&!terminal&&<form className="task-stage-rework" aria-label="确认阶段重做" onSubmit={event=>{event.preventDefault();void confirm();}}>
      <p>{stages.find(stage=>stage.id===draft.stageId)?.planGate?'将重新拆解任务，现有工作阶段移入旧回执。':stageReworkStages(stages,draft.stageId).map(stage=>stage.title).join(' → ')+' 将重新执行。'}旧回执保留，累计预算不变。</p>
      <label>重做原因<textarea autoFocus value={draft.reason} maxLength={1200} rows={2} disabled={busy} onChange={event=>setDraft({...draft,reason:event.target.value,requestId:crypto.randomUUID()})}/></label>
      {versionChanged&&<p role="status">目标版本已变化，请取消后重新选择阶段。</p>}
      <div className="task-actions"><button type="submit" className="btn btn-sm btn-primary" disabled={unavailable||versionChanged||draft.reason.trim().length<3}>{busy?'保存中…':'确认重做'}</button><button type="button" className="btn btn-sm" disabled={busy} onClick={()=>{setDraft(null);setError('');returnFocus.current?.focus();}}>取消</button></div>
    </form>}
    {notice&&<p className="task-stage-feedback" role="status">{notice}</p>}
    {error&&<p className="task-error" role="alert">{error}</p>}
    {goal.lastRework&&<details className="task-stage-history" onToggle={event=>{if(event.target===event.currentTarget&&event.currentTarget.open)void history();}}><summary>阶段重做记录</summary>
      {historyBusy?<p role="status">正在读取…</p>:receipts?<ul>{receipts.map(receipt=><li key={receipt.id}>
        <strong>版本 {receipt.fromRevision} → {receipt.toRevision} · {receipt.stages[0]?.title}{receipt.source==='reviewer'?' · 自动审查返工':''}</strong><p>{receipt.request.reason}</p>
        {receipt.stages.map(stage=><details key={stage.id}><summary>{stage.title} · 原回执</summary>{!stage.review&&!stage.planGate&&<p>{stage.handoff||'当时尚无已核验交接正文'}</p>}{stage.plan&&<p>{stage.plan.nodeCount} 项任务 · {stage.plan.groupCount} 个分组</p>}{stage.review&&<><p>{stage.review.summary}</p><ul>{stage.review.findings.map((finding,i)=><li key={i}>{finding}</li>)}</ul></>}<ul>{stage.checks.map((check,i)=><li key={i}>{check.label} · {({passed:'已核验',failed:'未通过',pending:'待核验',error:'核验异常'})[check.state]}{check.detail&&<small>{check.detail}</small>}</li>)}</ul></details>)}
      </li>)}</ul>:<button type="button" className="btn btn-sm" onClick={()=>void history()}>重试读取</button>}
    </details>}
  </>;
}
