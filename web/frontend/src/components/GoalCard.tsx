import { useState } from 'react';
import { taskRequest, taskStatus, type TaskGoal, type TaskRun } from '../lib/tasks';
import '../styles/automation.css';

export default function GoalCard({goal,runs,onChange,onOpen}:{goal:TaskGoal;runs:TaskRun[];onChange:()=>void;onOpen?:(id:string)=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const live=runs.some(r=>r.goalId===goal.id&&['running','unconfirmed'].includes(r.state));
  const terminal=['completed','cancelled'].includes(goal.status);
  async function action(action:string){setBusy(true);setError('');try{await taskRequest(`/goals/${goal.id}/action`,{action});onChange();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}}
  const passed=goal.checks.filter(c=>c.state==='passed').length;
  return <section className="goal-card" aria-label={`目标：${goal.title}`}>
    <div className="task-card-heading"><div><span className="task-eyebrow">对话目标</span><h3>{goal.title}</h3></div><span className={`task-status ${goal.status}`}>{taskStatus[goal.status]||goal.status}</span></div>
    <p className="goal-objective">{goal.objective}</p>
    <div className="task-evidence-heading"><strong>验收 {passed} / {goal.criteria.length}</strong><span>以实际证据为准</span></div>
    <ul className="goal-checks">{goal.criteria.map((c,i)=>{const check=goal.checks[i];return <li key={i}><span className={`goal-check-mark ${check?.state||'pending'}`} aria-hidden="true">{check?.state==='passed'?'✓':check?.state==='failed'||check?.state==='error'?'!':'○'}</span><div><strong>{c.label}</strong><small>{check?.detail||(c.type==='review'?'由你检查质量后确认':c.type==='file'?c.value:'本轮输出需包含：'+c.value)}</small></div></li>;})}</ul>
    <dl className="goal-limits"><div><dt>执行轮次</dt><dd>{goal.iterations} / {goal.maxIterations}</dd></div><div><dt>已结算时长</dt><dd>{Math.round(goal.activeSeconds)} / {goal.maxSeconds} 秒</dd></div><div><dt>工具</dt><dd>{goal.toolsUsed||0} / {goal.maxTools}</dd></div><div><dt>生图</dt><dd>{goal.imagesUsed||0} / {goal.maxImages}</dd></div></dl>
    <p className="task-model">锁定模型 · {goal.modelRef}</p>
    {goal.reason&&<p className="task-reason" role="status">{goal.reason}</p>}
    {live&&goal.status!=='active'&&<p className="task-reason">后台结算中，确认结束后才可恢复或发送消息。</p>}
    {error&&<p className="task-error" role="alert">{error}</p>}
    <div className="task-actions">
      {onOpen&&<button className="btn btn-sm" onClick={()=>onOpen(goal.sessionId)}>打开对话</button>}
      {!terminal&&!live&&goal.status!=='active'&&goal.phase!=='review'&&<button className="btn btn-sm btn-primary" disabled={busy} onClick={()=>void action(goal.status==='draft'?'start':'resume')}>{goal.status==='draft'?'启动目标':'继续目标'}</button>}
      {(goal.status==='active'||live)&&<button className="btn btn-sm" disabled={busy} onClick={()=>void action('stop')}>停止目标</button>}
      {!!goal.currentTurnId&&!live&&goal.status!=='cancelled'&&<button className="btn btn-sm" disabled={busy} onClick={()=>void action('recheck')}>重新核验</button>}
      {goal.phase==='review'&&!live&&<button className="btn btn-sm btn-primary" disabled={busy} onClick={()=>void action('approve')}>我已检查，确认通过</button>}
      {!terminal&&goal.status!=='active'&&!live&&<button className="btn btn-sm" disabled={busy} onClick={()=>void action('cancel')}>取消目标</button>}
      {busy&&<span role="status">正在保存…</span>}
    </div>
  </section>;
}
