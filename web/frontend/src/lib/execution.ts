export type OperationStatus = 'running'|'returned'|'completed'|'failed'|'unconfirmed'|'stopped'|'denied';
export interface Operation {
  id: string; name: string; kind?: 'command'|'read'|'file_change'|'search'|'browser'|'tool'; status: OperationStatus;
  command: string; path: string; output: string; diff: string; cwd?: string; query?: string; url?: string; action?: string;
  startedAt?: string; finishedAt?: string; elapsedSeconds?: number; exitCode?: number; exitSignal?: string;
  processSessionId?: string; added?: number; removed?: number; changeKind?: string; artifactPath?: string;
  contentHidden?: boolean; source?: string; truncated?: Record<string, boolean>;
}
export interface ExecutionSnapshot {
  sessionId: string; turnId: string; operations: Operation[]; warnings: string[];
  total?: number; nextBefore?: number|null; source?: string; plan?: {step:string;status:string}[]; progress?: string[];
}
const statuses = new Set(['running','returned','completed','failed','unconfirmed','stopped','denied']);
export function decodeExecution(value: unknown): ExecutionSnapshot|null {
  if(!value || typeof value!=='object')return null;
  const data=value as ExecutionSnapshot;
  if(typeof data.sessionId!=='string'||typeof data.turnId!=='string'||!Array.isArray(data.operations)||data.operations.length>100)return null;
  if(data.operations.some(row=>!row||typeof row.id!=='string'||typeof row.name!=='string'||!statuses.has(row.status)||['command','path','output','diff'].some(key=>typeof row[key as keyof Operation]!=='string')))return null;
  const plan=Array.isArray(data.plan)?data.plan.filter(x=>x&&typeof x.step==='string'&&['pending','inProgress','completed'].includes(x.status)).slice(0,100):[];
  const progress=Array.isArray(data.progress)?data.progress.filter(x=>typeof x==='string').slice(-50):[];
  return {...data,plan,progress,warnings:Array.isArray(data.warnings)?data.warnings.filter(x=>typeof x==='string'):[]};
}
export function publishExecution(value: unknown) {
  const data=decodeExecution(value);
  if(data)window.dispatchEvent(new CustomEvent('easel:execution',{detail:data}));
}
export function mergeOperations(previous: Operation[], incoming: Operation[]) {
  const map=new Map(previous.map(row=>[row.id,row]));
  for(const row of incoming){
    const old=map.get(row.id);
    if(old&&['returned','completed','failed','stopped','denied'].includes(old.status)&&['running','unconfirmed'].includes(row.status))continue;
    map.set(row.id,{...old,...row});
  }
  return [...map.values()].sort((a,b)=>(Date.parse(a.startedAt||'')||0)-(Date.parse(b.startedAt||'')||0));
}
const kinds:Record<string,string>={command:'终端',read:'读取',file_change:'文件',search:'搜索',browser:'浏览器',tool:'工具'};
export function operationKind(row:Operation){return kinds[row.kind||'tool']||'工具';}
export function operationTitle(row:Operation){
  if(row.kind==='file_change')return `${({add:'新增',delete:'删除',modify:'修改',write:'写入',update:'修改'} as Record<string,string>)[row.changeKind||'']||'文件变化'} · ${row.path.split(/[\\/]/).pop()||row.name}`;
  if(row.kind==='read')return row.path.split(/[\\/]/).pop()||row.name;
  if(row.kind==='search')return row.query||row.url||row.name;
  if(row.kind==='browser')return `${row.action||'页面操作'}${row.url?' · '+row.url:''}`;
  if(row.kind==='command')return `${row.name==='process'?'读取进程状态':'运行命令'} · ${row.command.trim().split(/\s+/)[0]||row.name}`;
  return row.name;
}
