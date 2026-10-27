import type { ChatSession, ChatMessage } from './store';

export interface TaskCriterion { type:'file'|'text'|'review'; label:string; value:string }
export interface TaskCheck extends TaskCriterion { state:'pending'|'passed'|'failed'|'error'; detail?:string; evidence?:string }
export interface GoalSpec { engine?:'openclaw'|'codex'; toolBudgetMode?:'admission'|'observed'; objective:string; modelRef:string; criteria:TaskCriterion[]; maxIterations:number; maxSeconds:number; maxTools:number; maxImages:number; workflow?:'research-delivery'|'reviewed-delivery'|'parallel-reviewed-delivery'|'planned-reviewed-delivery'|null }
export interface TaskStage { id:string; title:string; objective:string; roleId:string; role?:{name:string;shortName:string}; status:'pending'|'running'|'completed'|'blocked'|'unconfirmed'; attempts:number; dependsOn?:string[]; access?:'read'|'write'; groupPath?:string[]; planGate?:{schemaVersion:number}; plan?:{nodeCount:number;groupCount:number}; steps?:GoalStep[]; criteria:TaskCriterion[]; checks:TaskCheck[]; turnId?:string; completedAt?:number; handoff?:string; review?:{decision:'pass'|'revise'|'blocked';summary:string;findings:string[]} }
export interface GoalStep { id:string; title:string; status:'pending'|'in_progress'|'completed'|'blocked'; detail?:string }
export interface TaskGoal extends GoalSpec { id:string; sessionId:string; title:string; status:string; phase:string; iterations:number; activeSeconds:number; toolsUsed:number; imagesUsed:number; reason:string; checks:TaskCheck[]; currentTurnId?:string; steps?:GoalStep[]; stages?:TaskStage[]; currentStageId?:string; progressUpdatedAt?:number; createdAt?:number; updatedAt?:number; sessionDeleted?:boolean; revision?:number; lastRework?:{id:string;title:string;reason:string;fromRevision:number;toRevision:number} }
export interface StageReworkReceipt { id:string; goalId:string; fromRevision:number; toRevision:number; at:number; request:{stageId:string;revision:number;reason:string}; stages:TaskStage[];source?:'human'|'reviewer' }
export interface TaskRun { id:string; goalId:string; sessionId:string; turnId:string; state:string; iteration:number; startedAt:number; finishedAt?:number; reason?:string; text?:string; stageId?:string;roleId?:string;parentSessionId?:string;maxRunSeconds?:number }
export interface TaskSchedule { kind:'once'|'interval'|'daily'|'workdays'|'weekly'|'monthly'; timezone:string; at?:number; minutes:number; time:string; weekdays:number[]; day?:number }
export interface PlanSpec { title:string; sessionId?:string; goal:GoalSpec; schedule:TaskSchedule; missedPolicy:'skip'|'coalesce'; freshnessSeconds:number }
export interface PlanTrigger { at:number; status:string; reason:string; goalId?:string; sessionId?:string; trigger:string }
export interface TaskPlan extends PlanSpec { id:string; enabled:boolean; nextAt:number|null; history?:PlanTrigger[]; lastResult?:PlanTrigger|null; triggerCount?:number; launchedCount?:number; activeCount?:number; lastGoal?:Pick<TaskGoal,'id'|'sessionId'|'status'|'phase'|'reason'|'sessionDeleted'>|null; reason?:string }
export interface SessionTombstone {id:string;at:number;revision:number}
export interface TaskSessionState {sessions:ChatSession[];deletedSessions?:SessionTombstone[]}
export interface TaskSnapshot { goals:TaskGoal[]; runs:TaskRun[]; plans:TaskPlan[]; serverTime:number; revision?:number; deletedSessions?:SessionTombstone[] }

/** Deletion is monotonic even when independent reads arrive out of order. */
export function mergeSessionTombstones(...sources:(SessionTombstone[]|undefined)[]):SessionTombstone[]{
  const rows=new Map<string,SessionTombstone>();
  for(const source of sources)for(const row of source||[]){
    if(!row||!/^[A-Za-z0-9_.-]{1,120}$/.test(row.id)||!Number.isFinite(row.at)||!Number.isSafeInteger(row.revision)||row.revision<1)continue;
    if(!rows.has(row.id)||rows.get(row.id)!.revision<row.revision)rows.set(row.id,row);
  }
  return [...rows.values()].sort((a,b)=>a.revision-b.revision);
}
const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
export async function taskRequest<T>(path='', body?:unknown, method='POST', signal?:AbortSignal):Promise<T> {
  const response=await fetch(`${base}/api/tasks${path}`,{method:body===undefined?'GET':method,cache:'no-store',signal,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  const result=await response.json();
  if(!response.ok)throw new Error(typeof result.detail==='string'?result.detail:Array.isArray(result.detail)?result.detail.map((r:{msg:string})=>r.msg).join('；'):'任务请求失败，请重试');
  return result as T;
}
export const taskStatus:Record<string,string>={draft:'待启动',active:'进行中',paused:'已暂停',blocked:'需要处理',completed:'已完成',cancelled:'已取消',running:'运行中',unconfirmed:'等待核实',failed:'失败',stopped:'已停止',queued:'排队中',skipped:'已跳过'};

export function goalWorkflowOptions(current?:GoalSpec['workflow']) {
  return [{value:'',label:'直接推进'},{value:current==='research-delivery'?'research-delivery':'reviewed-delivery',label:'分工协作'},
    {value:'parallel-reviewed-delivery',label:'并行协作'},{value:'planned-reviewed-delivery',label:'任务拆解'}];
}
export function workflowIterations(workflow:GoalSpec['workflow']|'') {return workflow==='planned-reviewed-delivery'?16:workflow?8:5;}
export function graphWorkflow(goal:Pick<GoalSpec,'workflow'>) {return goal.workflow==='parallel-reviewed-delivery'||goal.workflow==='planned-reviewed-delivery';}

/** Parent chat summaries refer to the actual worker's native execution. */
export function taskMessageSession(sessionId:string,message:ChatMessage,runs:TaskRun[]=[]):string {
  const run=runs.find(row=>row.id===message.taskRunId&&row.turnId===message.turnId&&(row.parentSessionId===sessionId||row.sessionId===sessionId));
  return run?.sessionId||(message.taskRunId&&message.sourceSessionId)||sessionId;
}

/** Only inspection pages receive these contexts; sidebar and saved chats do not. */
export function taskInspectionSessions(sessions:ChatSession[], runs:TaskRun[], goals:TaskGoal[]):ChatSession[] {
  const workers=new Map<string,ChatSession>();
  for(const run of runs.slice().sort((a,b)=>a.iteration-b.iteration)) {
    const goal=goals.find(item=>item.id===run.goalId);
    if(!goal||!graphWorkflow(goal)||run.parentSessionId!==goal.sessionId
      ||run.sessionId===goal.sessionId||sessions.some(item=>item.id===run.sessionId))continue;
    let worker=workers.get(run.sessionId);
    if(!worker) {
      worker={id:run.sessionId,parentSessionId:goal.sessionId,taskWorker:true,engine:goal.engine||'openclaw',created:run.startedAt*1000,
        title:`${goal.title} · ${goal.stages?.find(stage=>stage.id===run.stageId)?.title||run.stageId||'工作阶段'}`,messages:[]};
      workers.set(run.sessionId,worker);
    }
    if(run.text)worker.messages.push({role:'assistant',content:run.text,turnId:run.turnId,taskRunId:run.id});
  }
  return workers.size?[...sessions,...workers.values()]:sessions;
}

export function stageReworkStages(stages:TaskStage[], stageId:string):TaskStage[] {
  const index=stages.findIndex(stage=>stage.id===stageId);
  if(index<0)return [];
  if(stages[index].dependsOn===undefined)return stages.slice(index);
  const affected=new Set([stageId]);
  for(let pass=0;pass<stages.length;pass++)for(const stage of stages) {
    if(stage.dependsOn?.some(id=>affected.has(id)))affected.add(stage.id);
  }
  return stages.filter(stage=>affected.has(stage.id));
}
export function goalElapsed(goal:TaskGoal, runs:TaskRun[], now=Date.now()/1000):number {
  return goal.activeSeconds + runs.filter(r=>r.goalId===goal.id&&r.state==='running'&&!r.finishedAt).reduce((sum,r)=>sum+Math.max(0,now-r.startedAt),0);
}
/** The plan's latest triggered run needs attention, like Codex's Scheduled inbox. */
export function planNeedsAttention(plan:TaskPlan, goals:TaskGoal[]):boolean {
  const last=plan.history?.at(-1);
  if(!last?.goalId)return false;
  const goal=goals.find(item=>item.id===last.goalId);
  return Boolean(goal&&goal.status==='blocked');
}
export function mergeTaskSessions(local:ChatSession[], remote:ChatSession[], deleted:(id:string)=>boolean=()=>false):ChatSession[]{
  const result=local.filter(session=>session.importedFromBackup||!deleted(session.id));
  let changed=result.length!==local.length;
  for(const incoming of remote){
    if(deleted(incoming.id))continue;
    const index=result.findIndex(s=>s.id===incoming.id);
    if(index<0){result.push(incoming);changed=true;continue;}
    const existing=result[index];if(existing.importedFromBackup)continue;
    const known=new Set(existing.messages.map(m=>m.turnId));
    const added=incoming.messages.filter(m=>m.turnId&&!known.has(m.turnId));
    const updated=existing.messages.map(m=>{const replacement=incoming.messages.find(r=>r.turnId&&r.turnId===m.turnId&&r.taskRunId&&r.taskRunId===m.taskRunId);return replacement&&(['content','sourceSessionId','thinking','thinkingStatus','startedAt','elapsedMs','stopped'] as const).some(key=>replacement[key]!==m[key])?replacement:m;});
    if(added.length||updated.some((m,i)=>m!==existing.messages[i])){result[index]={...existing,messages:[...updated,...added]};changed=true;}
  }
  return changed?result:local;
}
