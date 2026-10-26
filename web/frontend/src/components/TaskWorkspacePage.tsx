import {useState} from 'react';
import type {ChatSession} from '../lib/store';
import {taskStatus, type TaskGoal, type TaskSnapshot, type TaskRun} from '../lib/tasks';
import {taskBucket, taskBuckets, type TaskBucket} from '../lib/taskWorkspace';
import type {TaskSync} from '../hooks/useTaskSnapshot';
import GoalCard from './GoalCard';
import TaskStageRecovery from './TaskStageRecovery';
import '../styles/task-workspace.css';

interface Props {
  data:TaskSnapshot; sessions:ChatSession[]; sync:TaskSync; selectedId?:string;
  onSelect:(id?:string)=>void; onRefresh:()=>void; onOpenChat:(id:string)=>void;
  onOpenActivity:(sessionId:string,turnId?:string)=>void; onOpenOffice:(sessionId:string)=>void;
  onNew:()=>void; onSchedules:()=>void;
}
const stamp = (at?:number) => at ? new Date(at*1000).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '时间未记录';

function TaskDetail({goal,runs,stale,onRefresh,onOpenChat,onOpenActivity,onOpenOffice}: {
  goal:TaskGoal; runs:TaskRun[]; stale:boolean;
  onRefresh:Props['onRefresh']; onOpenChat:Props['onOpenChat']; onOpenActivity:Props['onOpenActivity']; onOpenOffice:Props['onOpenOffice'];
}) {
  const [tab,setTab] = useState<'progress'|'checks'|'runs'>('progress');
  const currentStage = goal.stages?.find(stage => stage.status!=='completed');
  return <article className="task-workspace-detail" aria-label={`任务详情：${goal.title}`}>
    <header><div><span className="task-eyebrow">{goal.stages?.length?'分工协作':'持续目标'} · {taskStatus[goal.status]||goal.status}</span><h2>{goal.title}</h2></div>
      {goal.sessionDeleted?<span className="task-eyebrow">原对话已删除</span>:<button type="button" className="btn btn-sm" onClick={()=>onOpenChat(goal.sessionId)}>回到对话 ↗</button>}
    </header>
    <div className="task-workspace-context"><span>{currentStage?`当前阶段 · ${currentStage.title}`:goal.stages?.length?'阶段已交接，查看最终验收':'按目标步骤推进'}</span><span>{goal.iterations}/{goal.maxIterations}轮</span></div>
    <div className="task-workspace-tabs" role="group" aria-label="任务详情视图">{([['progress','进展与交接'],['checks','验收与控制'],['runs','执行记录']] as const).map(([id,label])=><button type="button" key={id} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}{id==='runs'&&<span>{runs.length}</span>}</button>)}</div>
    {tab==='progress'&&<div className="task-workspace-progress">
      <p className="task-workspace-objective">{goal.objective}</p>
      {goal.reason&&!(goal.sessionDeleted&&goal.reason==='原对话已删除')&&<p className="task-workspace-reason" role="status">{goal.reason}</p>}
      {goal.stages?.length?<TaskStageRecovery goal={goal} runs={runs} disabled={stale} onChanged={onRefresh}/>:<section aria-label="目标工作步骤"><h3>工作步骤</h3>{goal.steps?.length?<ol className="task-workspace-steps">{goal.steps.map(step=><li key={step.id}><span>{({completed:'✓',in_progress:'◉',blocked:'!',pending:'○'})[step.status]}</span><div><strong>{step.title}</strong><small>{step.detail||({completed:'助手已报告完成',in_progress:'正在推进',blocked:'需要处理',pending:'待开始'})[step.status]}</small></div></li>)}</ol>:<p className="task-workspace-empty-note">尚未收到步骤更新。执行后会显示实际进展。</p>}</section>}
      <div className="task-workspace-next"><button type="button" className="btn btn-sm" onClick={()=>setTab('checks')}>查看验收</button></div>
    </div>}
    {tab==='checks'&&<GoalCard goal={goal} runs={runs} onChange={onRefresh} disabled={stale}/>}
    {tab==='runs'&&<section className="task-workspace-runs" aria-label="任务执行记录">
      {goal.workflow!=='parallel-reviewed-delivery'&&<div className="task-actions"><button type="button" className="btn btn-sm" onClick={()=>onOpenOffice(goal.sessionId)}>查看角色与工具</button><button type="button" className="btn btn-sm" onClick={()=>onOpenActivity(goal.sessionId)}>查看会话运行记录</button></div>}
      {runs.length?<ol>{runs.slice().sort((a,b)=>b.iteration-a.iteration).map(run=><li key={run.id}><div><strong>第{run.iteration}轮 · {taskStatus[run.state]||run.state}</strong><time>{stamp(run.finishedAt||run.startedAt)}</time></div>
        {(run.stageId||run.roleId)&&<p>{goal.stages?.find(stage=>stage.id===run.stageId)?.title||run.stageId} · {goal.stages?.find(stage=>stage.roleId===run.roleId)?.role?.shortName||run.roleId}</p>}
        {run.reason&&<p>{run.reason}</p>}{run.text&&<details><summary>本轮回执</summary><pre>{run.text}</pre></details>}
        <button type="button" className="btn btn-sm" onClick={()=>onOpenActivity(run.sessionId,run.turnId)}>查看本轮核验</button>
        {run.parentSessionId&&<button type="button" className="btn btn-sm" onClick={()=>onOpenOffice(run.sessionId)}>查看角色与工具</button>}
      </li>)}</ol>:<p className="task-workspace-empty-note">还没有派发执行轮次。</p>}
    </section>}
  </article>;
}

export default function TaskWorkspacePage({data,sessions,sync,selectedId,onSelect,onRefresh,onOpenChat,onOpenActivity,onOpenOffice,onNew,onSchedules}:Props) {
  const [filter,setFilter] = useState<TaskBucket|'all'>('all');
  const [query,setQuery] = useState('');
  const counts = {attention:0,active:0,history:0};
  for (const goal of data.goals) counts[taskBucket(goal,data.runs)]++;
  const text = query.trim().toLocaleLowerCase();
  const goals = data.goals.filter(goal => (filter==='all'||taskBucket(goal,data.runs)===filter) && (!text||[goal.title,goal.objective,goal.modelRef,sessions.find(session=>session.id===goal.sessionId)?.title||''].some(value=>value.toLocaleLowerCase().includes(text))));
  const priority = {attention:0,active:1,history:2};
  goals.sort((a,b)=>priority[taskBucket(a,data.runs)]-priority[taskBucket(b,data.runs)] || (b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0));
  const selected = selectedId ? data.goals.find(goal=>goal.id===selectedId) : goals[0];
  return <section className="task-workspace-page" aria-label="任务工作区">
    <div className="task-workspace-content">
    <header className="task-workspace-header"><h1>任务工作区</h1><div className="task-actions"><button type="button" className="btn btn-sm" onClick={onSchedules}>定时计划</button><button type="button" className="btn btn-primary" onClick={onNew}>新建目标</button></div></header>
    <div className="task-workspace-sync"><span role={sync.error?'alert':'status'}>{sync.loading?'正在读取…':sync.error||`${sync.readAt?new Date(sync.readAt).toLocaleTimeString('zh-CN'):''} 更新`}</span><button type="button" className="btn btn-sm" onClick={onRefresh} disabled={sync.refreshing}>{sync.refreshing?'读取中…':'刷新'}</button></div>
    <div className="task-workspace-layout"><aside className="task-workspace-index" aria-label="任务列表">
      <label className="task-workspace-search">搜索任务<input type="search" value={query} placeholder="目标、对话或模型" onChange={event=>setQuery(event.target.value)}/></label>
      <div className="task-workspace-filters" role="group" aria-label="任务筛选">{(['all','attention','active','history'] as const).map(id=><button type="button" key={id} aria-pressed={filter===id} onClick={()=>{setFilter(id);onSelect();}}>{id==='all'?'全部':taskBuckets[id]}<span>{id==='all'?data.goals.length:counts[id]}</span></button>)}</div>
      {!goals.length?<p className="task-workspace-empty-note">{sync.loading?'正在读取…':data.goals.length?'没有匹配任务':'暂无任务'}</p>:<ul>{goals.map(goal=>{const stage=goal.stages?.find(item=>item.status!=='completed');const unconfirmed=data.runs.some(run=>run.goalId===goal.id&&run.state==='unconfirmed');return <li key={goal.id}><button type="button" aria-current={selected?.id===goal.id?'true':undefined} onClick={()=>onSelect(goal.id)}><span className={`task-workspace-list-status ${taskBucket(goal,data.runs)}`}>{unconfirmed?'等待核实':goal.phase==='review'&&!['completed','cancelled'].includes(goal.status)?'等待验收':taskStatus[goal.status]||goal.status}</span><strong>{goal.title}</strong><small>{stage?.title||sessions.find(session=>session.id===goal.sessionId)?.title||'查看目标记录'}</small></button></li>;})}</ul>}
    </aside>
      {selected?<TaskDetail key={selected.id} goal={selected} runs={data.runs.filter(run=>run.goalId===selected.id)} stale={Boolean(sync.error)||sync.loading} onRefresh={onRefresh} onOpenChat={onOpenChat} onOpenActivity={onOpenActivity} onOpenOffice={onOpenOffice}/>:<div className="task-workspace-empty"><h2>{sync.loading?'正在读取…':selectedId?'未找到这条任务':'暂无任务'}</h2>{!sync.loading&&<button type="button" className="btn" onClick={selectedId?()=>onSelect():onNew}>{selectedId?'返回列表':'新建目标'}</button>}</div>}
    </div>
    </div>
  </section>;
}
