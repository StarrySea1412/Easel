export type OperationStatus = 'running'|'returned'|'completed'|'failed'|'unconfirmed'|'stopped'|'denied';
export interface Operation {
  id: string; name: string; kind?: 'command'|'read'|'file_change'|'search'|'browser'|'tool'; status: OperationStatus;
  command: string; path: string; output: string; diff: string; cwd?: string; query?: string; url?: string; action?: string;
  startedAt?: string; finishedAt?: string; elapsedSeconds?: number; exitCode?: number; exitSignal?: string;
  processSessionId?: string; added?: number; removed?: number; changeKind?: string; artifactPath?: string;
  contentHidden?: boolean; source?: string; truncated?: Record<string, boolean>; order?: number;
}
export interface ExecutionEntry { id:string; type:'progress'|'operation'; order:number; text?:string; operationId?:string; }
export interface ExecutionSnapshot {
  sessionId: string; turnId: string; operations: Operation[]; warnings: string[];
  total?: number; nextBefore?: number|null; source?: string; plan?: {step:string;status:string}[]; progress?: string[]; timeline?:ExecutionEntry[];
}
const statuses = new Set(['running','returned','completed','failed','unconfirmed','stopped','denied']);
export function decodeExecution(value: unknown): ExecutionSnapshot|null {
  if(!value || typeof value!=='object')return null;
  const data=value as ExecutionSnapshot;
  if(typeof data.sessionId!=='string'||typeof data.turnId!=='string'||!Array.isArray(data.operations)||data.operations.length>100)return null;
  if(data.operations.some(row=>!row||typeof row.id!=='string'||typeof row.name!=='string'||!statuses.has(row.status)||['command','path','output','diff'].some(key=>typeof row[key as keyof Operation]!=='string')))return null;
  const plan=Array.isArray(data.plan)?data.plan.filter(x=>x&&typeof x.step==='string'&&['pending','inProgress','completed','blocked','failed'].includes(x.status)).slice(0,100):[];
  const progress=Array.isArray(data.progress)?data.progress.filter(x=>typeof x==='string').slice(-50):[];
  const timeline=Array.isArray(data.timeline)?data.timeline.filter(entry=>entry&&typeof entry.id==='string'&&Number.isSafeInteger(entry.order)&&entry.order>=0&&(entry.type==='progress'?typeof entry.text==='string':entry.type==='operation'&&typeof entry.operationId==='string')).slice(-500):undefined;
  return {...data,plan,progress,timeline,warnings:Array.isArray(data.warnings)?data.warnings.filter(x=>typeof x==='string'):[]};
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
  return [...map.values()].sort((a,b)=>a.order!==undefined&&b.order!==undefined?a.order-b.order:(Date.parse(a.startedAt||'')||0)-(Date.parse(b.startedAt||'')||0));
}
export function mergeTimeline(previous:ExecutionEntry[]|undefined,incoming:ExecutionEntry[]|undefined) {
  if(!incoming)return previous;
  const entries=new Map((previous||[]).map(entry=>[entry.id,entry]));
  for(const entry of incoming)entries.set(entry.id,entry);
  return [...entries.values()].sort((a,b)=>a.order-b.order).slice(-500);
}
const kinds:Record<string,string>={command:'终端',read:'读取',file_change:'文件',search:'搜索',browser:'浏览器',tool:'工具'};
export function operationKind(row:Operation){return kinds[row.kind||'tool']||'工具';}
export function operationTitle(row:Operation){
  const filename=row.path.split(/[\\/]/).pop();
  if(row.kind==='file_change')return `${({add:'新增文件',delete:'删除文件',modify:'修改文件',write:'写入文件',update:'修改文件'} as Record<string,string>)[row.changeKind||'']||'修改文件'}${filename?' · '+filename:''}`;
  if(row.kind==='read')return `${filename==='SKILL.md'?'读取技能指南':/imageView|view_image/.test(row.name)?'查看图片':'读取文件'}${filename?' · '+filename:''}`;
  if(row.kind==='search')return `${row.name==='web_fetch'?'读取网页':/grep|glob/.test(row.name)?'搜索文件':'搜索内容'}${row.query||row.url?' · '+(row.query||row.url):''}`;
  if(row.kind==='browser'){
    const action=({navigate:'打开网页',open:'打开网页',browser_navigate:'打开网页',click:'点击页面元素',browser_click:'点击页面元素',snapshot:'读取页面',browser_snapshot:'读取页面',screenshot:'截取页面',browser_screenshot:'截取页面',type:'填写页面',fill:'填写页面',scroll:'滚动页面'} as Record<string,string>)[row.action||row.name]||'浏览网页';
    return `${action}${row.url?' · '+row.url:''}`;
  }
  if(row.kind==='command')return `${row.name==='process'?'读取进程状态':'执行命令'}${row.command.trim()?' · '+row.command.trim().split(/\s+/)[0]:''}`;
  if(row.path)return `访问文件 · ${filename}`;
  if(row.command)return `执行命令 · ${row.command.trim().split(/\s+/)[0]}`;
  return ['tool_call','tool','mcpToolCall','dynamicToolCall'].includes(row.name)?'调用工具 · 操作详情未记录':`调用工具 · ${row.name}`;
}
