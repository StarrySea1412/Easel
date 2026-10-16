import {useEffect,useState} from 'react';
import {goalElapsed,taskRequest,taskStatus,type TaskGoal,type TaskRun} from '../lib/tasks';
import '../styles/chat-goal.css';

function duration(seconds:number){const s=Math.floor(seconds);return s>=3600?`${Math.floor(s/3600)}小时${Math.floor(s%3600/60)}分` : s>=60?`${Math.floor(s/60)}分${s%60}秒`:`${s}秒`;}
export default function ChatGoalPanel({goal,runs,onChanged,onClose,onEdit}:{goal:TaskGoal;runs:TaskRun[];onChanged:()=>void;onClose:()=>void;onEdit:()=>void}){
  const [now,setNow]=useState(()=>Date.now()/1000),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(!runs.some(r=>r.state==='running'))return;const timer=setInterval(()=>setNow(Date.now()/1000),1000);return()=>clearInterval(timer);},[runs]);
  const live=runs.some(r=>['queued','running','unconfirmed'].includes(r.state));
  const unknown=runs.some(r=>r.state==='unconfirmed');const active=goal.status==='active';
  const terminal=['completed','cancelled'].includes(goal.status),steps=goal.steps||[];
  const done=steps.filter(s=>s.status==='completed').length,checked=goal.checks.filter(c=>c.state==='passed').length;
  const elapsed=goalElapsed(goal,runs,now);
  const status=unknown?'等待核实':goal.phase==='waiting_input'?'等待你的输入':goal.phase==='review'?'等待验收':taskStatus[goal.status]||goal.status;
  async function action(value:string){setBusy(true);setError('');try{await taskRequest(`/goals/${goal.id}/action`,{action:value});onChanged();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}}
  return <aside className="chat-goal-panel" aria-label="当前对话目标">
    <header><strong>目标</strong><time>{duration(elapsed)}</time><div>
      {(active||live)&&<button aria-label="暂停目标" disabled={busy} onClick={()=>void action('stop')}>Ⅱ</button>}
      {!terminal&&!active&&!live&&goal.phase!=='review'&&<button aria-label={goal.status==='draft'?'启动目标':'继续目标'} disabled={busy} onClick={()=>void action(goal.status==='draft'?'start':'resume')}>▷</button>}
      <button aria-label="收起目标面板" onClick={onClose}>↗</button>
    </div></header>
    <div className="chat-goal-panel-body">
      <section className="chat-goal-target"><div><span className="goal-symbol" aria-hidden="true">◎</span><h3>{goal.objective}</h3></div><span className={`chat-goal-state ${goal.status}`}>{status}</span></section>
      <section className="chat-goal-progress" aria-label="目标进展"><div className="chat-goal-section-heading"><span>进展</span><span>{steps.length?`${done}/${steps.length}`:'尚无步骤'}</span></div>
        {steps.length?<ol>{steps.map(s=><li className={s.status} key={s.id}><span className="chat-goal-step-mark" aria-label={{pending:'待处理',in_progress:'进行中',completed:'已完成',blocked:'被阻塞'}[s.status]}>{s.status==='completed'?'✓':s.status==='in_progress'?'◉':s.status==='blocked'?'!':'○'}</span><div><p>{s.title}</p>{s.detail&&<small>{s.detail}</small>}</div></li>)}</ol>:<p className="chat-goal-no-steps">尚未收到步骤更新。工作开始后，助手会在这里报告实际进展。</p>}
      </section>
      {goal.reason&&!steps.some(s=>s.detail===goal.reason)&&<p className="chat-goal-reason" role="status">{goal.reason}</p>}
      {live&&!active&&<p className="chat-goal-reason" role="status">正在核实后台是否结束，确认前不会续跑。</p>}
      {error&&<p role="alert" className="task-error">{error}</p>}
      <div className="chat-goal-inline-actions">{goal.phase==='review'&&!live&&<button className="btn btn-sm" disabled={busy} onClick={()=>void action('approve')}>验收并完成目标</button>}{!live&&!active&&<button disabled={busy} onClick={onEdit}>{terminal?'设置新目标':'修改目标'}</button>}</div>
      <details className="chat-goal-panel-details"><summary>验收与执行记录</summary><p>验收 {checked}/{goal.criteria.length} · 工作步骤由助手报告，最终验收单独确认。</p><ul>{goal.criteria.map((c,i)=><li key={i}>{goal.checks[i]?.state==='passed'?'✓':'○'} {c.label}{goal.checks[i]?.detail&&<small>{goal.checks[i].detail}</small>}</li>)}</ul><p>{goal.iterations}/{goal.maxIterations}轮 · 工具{goal.toolsUsed}/{goal.maxTools} · 生图{goal.imagesUsed}/{goal.maxImages} · 上限{goal.maxSeconds}秒</p><p className="task-model">{goal.modelRef}</p>{runs.slice().reverse().map(r=><p key={r.id}>第{r.iteration}轮 · {taskStatus[r.state]||r.state}</p>)}
        {!!goal.currentTurnId&&!live&&goal.status!=='cancelled'&&<button disabled={busy} onClick={()=>void action('recheck')}>重新核验结果</button>}
        {!terminal&&!live&&!active&&<button disabled={busy} onClick={()=>void action('cancel')}>清除当前目标</button>}
      </details>
    </div>
    <footer><span>{active?'持续推进':status}</span><span>{goal.iterations}轮 · {done}/{steps.length}步骤</span></footer>
  </aside>;
}
