import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

export const TASK_GUARD_VERSION = 2;

export function registerTasks(api) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dataRoot = path.resolve(process.env.EASEL_DATA_DIR || root);
  api.registerTool({
    name: 'easel_task_guard', label: '目标执行保护状态',
    description: '只读检查 Easel 目标执行保护是否已加载；不执行任务。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const details = { version: TASK_GUARD_VERSION, dataRoot };
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  });
  api.registerTool(ctx => {
    const session = ctx.sessionKey?.replace(/^agent:main:/, '');
    if (!session || !/^[A-Za-z0-9_.-]{1,120}$/.test(session)) return null;
    return {
      name: 'easel_goal_update', label: '更新当前对话目标进展',
      description: '将当前目标拆为步骤并更新真实进展。每次提交完整步骤列表，保留已完成项。completed仅为工作自报，不代表用户质量验收；需要用户输入时用blocked和detail说明。',
      parameters: {type:'object',additionalProperties:false,required:['steps'],properties:{steps:{type:'array',minItems:1,maxItems:32,items:{type:'object',additionalProperties:false,required:['id','title','status'],properties:{id:{type:'string',maxLength:80},title:{type:'string',maxLength:300},status:{type:'string',enum:['pending','in_progress','completed','blocked']},detail:{type:'string',maxLength:1200}}}}}},
      async execute(call, args, signal) {
        return await new Promise((resolve, reject) => {
          const child = spawn(process.env.EASEL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
            [path.join(root,'skills/shared/scripts/task_guard.py'),'--session',session,'--run','','--call',String(call),'--tool','__update_progress'],
            {cwd:root,windowsHide:true,signal,env:{...process.env,EASEL_DATA_DIR:dataRoot,PYTHONIOENCODING:'utf-8'}});
          let output='';const timer=setTimeout(()=>child.kill(),5000);
          child.stdin.end(JSON.stringify(args));child.stdin.on('error',()=>{});
          child.stdout.on('data',b=>{output+=b;if(output.length>8192)child.kill();});child.stderr.resume();
          child.on('error',()=>{clearTimeout(timer);reject(new Error('目标进展服务不可用'));});
          child.on('close',code=>{clearTimeout(timer);try{const result=JSON.parse(output);if(code!==0||!result.ok)throw new Error();resolve({content:[{type:'text',text:JSON.stringify(result)}],details:result});}catch{reject(new Error('目标进展未通过校验，请检查当前目标与运行状态'));}});
        });
      },
    };
  }, {name:'easel_goal_update'});
  api.on('before_tool_call', async (event, context) => {
    const session = context?.sessionKey?.replace(/^agent:main:/, '');
    if (!session || !/^[A-Za-z0-9_.-]{1,120}$/.test(session)) return;
    if (!existsSync(path.join(dataRoot, 'outputs/_automation/scopes', session))) return;
    try {
      const decision = await new Promise((resolve, reject) => {
        const child = spawn(process.env.EASEL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
          [path.join(root, 'skills/shared/scripts/task_guard.py'), '--session', session,
            '--run', String(event.runId || ''), '--call', String(event.toolCallId || ''), '--tool', event.toolName],
          { cwd: root, windowsHide: true, env: { ...process.env, EASEL_DATA_DIR: dataRoot, PYTHONIOENCODING: 'utf-8' } });
        let output = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 5000);
        child.stdout.on('data', b => { output += b; if (output.length > 8192) child.kill(); });
        child.stderr.resume();
        child.on('error', () => { clearTimeout(timer); reject(new Error('unavailable')); });
        child.on('close', code => { clearTimeout(timer); try { if (code !== 0) throw new Error(); resolve(JSON.parse(output)); } catch { reject(new Error('invalid')); } });
      });
      if (decision.allowed !== true) return { block: true, blockReason: decision.reason || '目标执行保护拒绝调用。' };
    } catch {
      return { block: true, blockReason: '目标执行保护暂不可用，请检查本地服务。' };
    }
  }, { priority: 200, timeoutMs: 7000 });
}
