// A local receipt tool: no model call, no automatic goal creation or completion.
export function registerPlan(api) {
  api.registerTool({
    name: 'easel_plan_update', label: '更新本轮任务计划',
    description: '复杂任务执行前建立计划，每次阶段变化提交完整清单。仅更新本轮可见进度；不创建持续目标，不代表用户验收。',
    parameters: {type:'object',additionalProperties:false,required:['plan'],properties:{plan:{type:'array',minItems:1,maxItems:32,items:{type:'object',additionalProperties:false,required:['step','status'],properties:{step:{type:'string',minLength:1,maxLength:500},status:{type:'string',enum:['pending','in_progress','completed','blocked','failed']}}}}}},
    async execute(_call, args) {
      const rows = args?.plan;
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > 32 || rows.some(row =>
        !row || typeof row.step !== 'string' || !row.step.trim() || row.step.length > 500 ||
        !['pending','in_progress','completed','blocked','failed'].includes(row.status)) ||
        rows.filter(row => row.status === 'in_progress').length > 1) {
        return {isError:true,content:[{type:'text',text:'计划格式无效：提供1至32项步骤，同时最多一项进行中。'}]};
      }
      const details = {plan:rows.map(row => ({step:row.step.trim(),status:row.status}))};
      return {content:[{type:'text',text:'EASEL_PLAN ' + JSON.stringify(details)}],details};
    },
  });
}
