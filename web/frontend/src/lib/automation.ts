import type { TaskGoal, TaskPlan, TaskSchedule } from './tasks';

export const planFilters = [['all','全部'],['enabled','已启用'],['running','运行中'],['attention','需处理'],['paused','已暂停'],['completed','已完成']] as const;
export type PlanFilter = typeof planFilters[number][0];

export function scheduleLabel(schedule:TaskSchedule):string {
  const time=schedule.time||'09:00';
  switch(schedule.kind){
    case 'once':return '仅一次';
    case 'interval':return `每 ${schedule.minutes} 分钟`;
    case 'daily':return `每天 ${time}`;
    case 'workdays':return `工作日 ${time}`;
    case 'weekly':return `每周${[...schedule.weekdays].sort((a,b)=>a-b).map(day=>'一二三四五六日'[day]).join('、')} ${time}`;
    case 'monthly':return `每月 ${schedule.day||1} 日 ${time}`;
  }
}
export function planState(plan:TaskPlan,goals:TaskGoal[]) {
  const last=plan.lastResult||plan.history?.at(-1);
  const goal=plan.lastGoal||goals.find(g=>g.id===last?.goalId);
  const running=plan.activeCount!==undefined?plan.activeCount>0:goal?.status==='active';
  const status=goal?.status||(!last?.goalId?last?.status:undefined);
  const attention=['blocked','unconfirmed','failed'].includes(status||'');
  const consumed=plan.schedule.kind==='once'&&!plan.enabled&&!plan.nextAt&&Boolean(last);
  const completed=consumed&&status==='completed';
  const label=running?'运行中':attention?'需处理':completed?'已完成':consumed?'已触发':plan.enabled?'已启用':'已暂停';
  return {last,goal,running,attention,completed,consumed,label,status,reason:goal?.reason||last?.reason||plan.reason||''};
}
export function matchesPlan(plan:TaskPlan,goals:TaskGoal[],filter:PlanFilter):boolean {
  const state=planState(plan,goals);
  return filter==='all'||(filter==='enabled'?plan.enabled:filter==='running'?state.running:filter==='attention'?state.attention:filter==='completed'?state.completed:!plan.enabled&&!state.consumed);
}
export function nextRunLabel(plan:TaskPlan,now:number):string {
  if(!plan.enabled)return plan.schedule.kind==='once'&&!plan.nextAt&&(plan.lastResult||plan.history?.length)?'单次已触发':'排期已暂停';
  if(!plan.nextAt)return '下次时间待确认';
  const seconds=plan.nextAt-now;
  if(seconds<=0)return '等待触发';
  if(seconds<60)return '不到 1 分钟后';
  if(seconds<3600)return `${Math.ceil(seconds/60)} 分钟后`;
  if(seconds<86400)return `${Math.ceil(seconds/3600)} 小时后`;
  return `${Math.ceil(seconds/86400)} 天后`;
}
export const scheduleTemplates = [
  {id:'topics',title:'每日选题',hint:'整理素材，准备下一轮选题',kind:'workdays',time:'09:00',objective:'根据本对话中已有的材料与创作画像，整理三个可执行的内容选题，写明标题、角度和所需素材，保存为选题草稿；材料不足时列出缺口，不编造数据，不发布内容。'},
  {id:'review',title:'创作复盘',hint:'回顾已有内容和待办',kind:'daily',time:'18:00',objective:'回顾本对话中已有的创作内容、交付文件和待办，整理今日进展、未完成项与下一步建议，保存为复盘草稿；仅使用已有记录，不编造平台表现，不发布内容。'},
  {id:'weekly',title:'内容周报',hint:'汇总本周进展与下周计划',kind:'weekly',time:'16:00',objective:'汇总本对话中本周已有的创作记录、交付文件与待办，整理完成事项、阻塞和下周建议，保存为内容周报草稿；缺少依据时注明，不编造数据，不发布内容。'},
  {id:'media',title:'素材清单',hint:'梳理已有素材和缺口',kind:'weekly',time:'10:00',objective:'根据本对话中已提供的素材和文件，整理可用素材清单、可复用方向与缺失项，保存为清单草稿；只整理与提出建议，不移动或删除文件，不发布内容。'},
] as const;
