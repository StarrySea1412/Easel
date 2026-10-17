import type {ChatSession} from './store';
import type {TaskSnapshot} from './tasks';

export type SessionStatusKind='running'|'stopping'|'queued'|'unconfirmed'|'completed'|'failed'|'stopped'|'review'|'waiting'|'blocked'|'paused';
export interface SessionStatus {kind:SessionStatusKind;label:string;detail:string}
const states:Record<SessionStatusKind,SessionStatus>={
  running:{kind:'running',label:'运行中',detail:'正在对话'},
  stopping:{kind:'stopping',label:'停止中',detail:'正在停止，等待后台确认'},
  queued:{kind:'queued',label:'排队中',detail:'已排队，尚未开始执行'},
  unconfirmed:{kind:'unconfirmed',label:'待核实',detail:'后台状态尚未确认，未计入正在运行'},
  completed:{kind:'completed',label:'已完成',detail:'最近一轮已结束；结果质量仍需自行检查'},
  failed:{kind:'failed',label:'失败',detail:'最近一轮执行失败'},
  stopped:{kind:'stopped',label:'已停止',detail:'最近一轮已停止'},
  review:{kind:'review',label:'待验收',detail:'目标等待你验收，尚未完成'},
  waiting:{kind:'waiting',label:'待输入',detail:'目标等待你的输入'},
  blocked:{kind:'blocked',label:'需处理',detail:'目标遇到阻塞，需要处理'},
  paused:{kind:'paused',label:'已暂停',detail:'目标已暂停'},
};

/** Never infer success from old text, an imported backup or a disconnected stream. */
export function sessionStatus(session:ChatSession,running:ReadonlySet<string>,stopping:ReadonlySet<string>,tasks?:TaskSnapshot):SessionStatus|undefined {
  if(session.importedFromBackup)return;
  if(stopping.has(session.id))return states.stopping;
  if(running.has(session.id))return states.running;
  const runs=tasks?.runs.filter(r=>r.sessionId===session.id)||[];
  if(runs.some(r=>r.state==='unconfirmed'))return states.unconfirmed;
  if(runs.some(r=>r.state==='running'))return states.running;
  if(runs.some(r=>r.state==='queued'))return states.queued;
  const active=tasks?.goals.find(g=>g.sessionId===session.id&&g.status==='active');
  if(active)return states.running;
  if(session.pendingTurnId)return {...states.unconfirmed,detail:'正在恢复上一轮，等待后台确认'};
  const last=session.messages.at(-1);
  if(!last||last.role!=='assistant')return;
  const goal=tasks?.goals.find(g=>g.id===last.taskGoalId||runs.some(r=>r.id===last.taskRunId&&r.goalId===g.id));
  const run=runs.find(r=>r.id===last.taskRunId);
  if(last.error||run?.state==='failed')return {...states.failed,detail:last.error?.message||run?.reason||states.failed.detail};
  if(last.stopped||run?.state==='stopped')return states.stopped;
  if(goal){
    if(goal.status==='completed')return {...states.completed,detail:'目标已完成并通过验收'};
    if(goal.status==='cancelled')return states.stopped;
    if(goal.phase==='review')return states.review;
    if(goal.phase==='waiting_input')return states.waiting;
    if(goal.status==='blocked')return {...states.blocked,detail:goal.reason||states.blocked.detail};
    if(goal.status==='paused')return states.paused;
    // Goal creation and a finished work iteration are not goal completion.
    return;
  }
  if(last.taskGoalId||last.taskRunId){
    // A finished task run is a real outcome worth a green dot; a plain chat
    // turn simply ending is not — those rows stay clean.
    if(run?.state==='completed')return {...states.completed,detail:'本轮任务已完成'};
    return;
  }
}

export function sessionStatuses(sessions:ChatSession[],runningIds:string[]=[],stoppingIds:string[]=[],tasks?:TaskSnapshot):Map<string,SessionStatus> {
  const running=new Set(runningIds),stopping=new Set(stoppingIds),result=new Map<string,SessionStatus>();
  for(const session of sessions){const state=sessionStatus(session,running,stopping,tasks);if(state)result.set(session.id,state);}
  return result;
}
