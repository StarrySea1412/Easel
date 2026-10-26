import {useEffect,useState} from 'react';
import {goalElapsed,taskRequest,taskStatus,type TaskGoal,type TaskRun} from '../lib/tasks';
import '../styles/chat-goal.css';
import TaskStageBoard from './TaskStageBoard';

function duration(seconds:number){const s=Math.floor(seconds);return s>=3600?`${Math.floor(s/3600)}小时${Math.floor(s%3600/60)}分` : s>=60?`${Math.floor(s/60)}分${s%60}秒`:`${s}秒`;}
export default function ChatGoalPanel({goal,runs,onChanged,onEdit,onWorkspace}:{goal:TaskGoal;runs:TaskRun[];onChanged:()=>void;onClose?:()=>void;onEdit:()=>void;onWorkspace?:()=>void}){
  const [now,setNow]=useState(()=>Date.now()/1000),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(!runs.some(r=>r.state==='running'))return;const timer=setInterval(()=>setNow(Date.now()/1000),1000);return()=>clearInterval(timer);},[runs]);
  const live=runs.some(r=>['queued','running','unconfirmed'].includes(r.state));
  const unknown=runs.some(r=>r.state==='unconfirmed');const active=goal.status==='active';
  const terminal=['completed','cancelled'].includes(goal.status),steps=goal.steps||[];
  const done=steps.filter(s=>s.status==='completed').length,checked=goal.checks.filter(c=>c.state==='passed').length;
  const elapsed=goalElapsed(goal,runs,now);
  const status=unknown?'等待核实':!terminal&&goal.phase==='waiting_input'?'等待你的输入':!terminal&&goal.phase==='review'?'等待验收':!terminal&&goal.phase==='budget'?'已达执行上限':taskStatus[goal.status]||goal.status;
  async function action(value:string){setBusy(true);setError('');try{await taskRequest(`/goals/${goal.id}/action`,{action:value});onChanged();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}}
  return <section className="chat-goal-panel" aria-label="当前对话目标">
    <header><span className={`chat-goal-state ${goal.status}`}>{status}</span><time>{duration(elapsed)}</time><div>
      {(active||live)&&<button aria-label="暂停目标" disabled={busy} onClick={()=>void action('stop')}>Ⅱ</button>}
      {!terminal&&!active&&!live&&goal.phase!=='review'&&<button aria-label={goal.status==='draft'?'启动目标':'继续目标'} disabled={busy} onClick={()=>void action(goal.status==='draft'?'start':'resume')}>▷</button>}
    </div></header>
    <div className="chat-goal-panel-body">
      <section className="chat-goal-target"><h3>{goal.objective}</h3></section>
      {!!goal.stages?.length&&<TaskStageBoard stages={goal.stages} compact/>}
      {(!goal.stages?.length||steps.length>0)&&<section className="chat-goal-progress" aria-label="目标进展"><div className="chat-goal-section-heading"><span>{goal.stages?.length?'当前阶段步骤':'进展'}</span><span>{steps.length?`${done}/${steps.length}`:'尚无步骤'}</span></div>
        {steps.length?<ol>{steps.map(s=><li className={s.status} key={s.id}><span className="chat-goal-step-mark" aria-label={{pending:'待处理',in_progress:'进行中',completed:'已完成',blocked:'被阻塞'}[s.status]}>{s.status==='completed'?'✓':s.status==='in_progress'?'◉':s.status==='blocked'?'!':'○'}</span><div><p>{s.title}</p>{s.detail&&<small>{s.detail}</small>}</div></li>)}</ol>:<p className="chat-goal-no-steps">暂无步骤</p>}
      </section>}
      {goal.reason&&!steps.some(s=>s.detail===goal.reason)&&<p className="chat-goal-reason" role="status">{goal.reason}</p>}
      {active&&!live&&<p className="chat-goal-reason" role="status">等待下一轮</p>}
      {live&&!active&&<p className="chat-goal-reason" role="status">{unknown?'等待核实':'正在结束本轮'}</p>}
      {error&&<p role="alert" className="task-error">{error}</p>}
      <div className="chat-goal-inline-actions">{!terminal&&goal.phase==='review'&&!live&&<button className="btn btn-sm" disabled={busy} onClick={()=>void action('approve')}>验收并完成目标</button>}{!live&&!active&&<button disabled={busy} onClick={onEdit}>{terminal?'设置新目标':'修改目标'}</button>}{!!goal.currentTurnId&&!live&&goal.status!=='cancelled'&&<button disabled={busy} onClick={()=>void action('recheck')}>重新核验结果</button>}</div>
      <p className="chat-goal-quality">验收 {checked}/{goal.criteria.length}</p>
    </div>
    {onWorkspace&&<footer><button type="button" onClick={onWorkspace}>任务详情 ↗</button></footer>}
  </section>;
}
