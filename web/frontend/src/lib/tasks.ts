import type { ChatSession } from './store';

export interface TaskCriterion { type:'file'|'text'|'review'; label:string; value:string }
export interface TaskCheck extends TaskCriterion { state:'pending'|'passed'|'failed'|'error'; detail?:string; evidence?:string }
export interface GoalSpec { objective:string; modelRef:string; criteria:TaskCriterion[]; maxIterations:number; maxSeconds:number; maxTools:number; maxImages:number }
export interface TaskGoal extends GoalSpec { id:string; sessionId:string; title:string; status:string; phase:string; iterations:number; activeSeconds:number; toolsUsed:number; imagesUsed:number; reason:string; checks:TaskCheck[]; currentTurnId?:string }
export interface TaskRun { id:string; goalId:string; sessionId:string; turnId:string; state:string; iteration:number; startedAt:number; finishedAt?:number; reason?:string; text?:string }
export interface TaskSchedule { kind:'once'|'interval'|'daily'|'workdays'|'weekly'; timezone:string; at?:number; minutes:number; time:string; weekdays:number[] }
export interface PlanSpec { title:string; sessionId?:string; goal:GoalSpec; schedule:TaskSchedule; missedPolicy:'skip'|'coalesce'; freshnessSeconds:number }
export interface TaskPlan extends PlanSpec { id:string; enabled:boolean; nextAt:number|null; history?:{at:number; status:string; reason:string; goalId?:string; sessionId?:string; trigger:string}[] }
export interface TaskSnapshot { goals:TaskGoal[]; runs:TaskRun[]; plans:TaskPlan[]; serverTime:number }
const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
export async function taskRequest<T>(path='', body?:unknown, method='POST', signal?:AbortSignal):Promise<T> {
  const response=await fetch(`${base}/api/tasks${path}`,{method:body===undefined?'GET':method,cache:'no-store',signal,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  const result=await response.json();
  if(!response.ok)throw new Error(typeof result.detail==='string'?result.detail:Array.isArray(result.detail)?result.detail.map((r:{msg:string})=>r.msg).join('；'):'任务请求失败，请重试');
  return result as T;
}
export const taskStatus:Record<string,string>={draft:'待启动',active:'进行中',paused:'已暂停',blocked:'需要处理',completed:'已完成',cancelled:'已取消',running:'运行中',unconfirmed:'等待核实',failed:'失败',stopped:'已停止',queued:'排队中',skipped:'已跳过'};
export function mergeTaskSessions(local:ChatSession[], remote:ChatSession[]):ChatSession[]{
  let changed=false;const result=[...local];
  for(const incoming of remote){
    const index=result.findIndex(s=>s.id===incoming.id);
    if(index<0){result.push(incoming);changed=true;continue;}
    const existing=result[index];if(existing.importedFromBackup)continue;
    const known=new Set(existing.messages.map(m=>m.turnId));
    const added=incoming.messages.filter(m=>m.turnId&&!known.has(m.turnId));
    const updated=existing.messages.map(m=>{const replacement=incoming.messages.find(r=>r.turnId&&r.turnId===m.turnId&&r.taskRunId&&r.taskRunId===m.taskRunId);return replacement&&replacement.content!==m.content?replacement:m;});
    if(added.length||updated.some((m,i)=>m!==existing.messages[i])){result[index]={...existing,messages:[...updated,...added]};changed=true;}
  }
  return changed?result:local;
}
