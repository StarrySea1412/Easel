import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveCodeRoot } from './code-root.mjs';

export function registerXhsCards(api) {
  if (typeof api.registerTool !== 'function') return;
  const checks = ['readableText','consistentSubject','consistentStyle','distinctContent','truthfulClaims','safeMargins'];
  const root = resolveCodeRoot(import.meta.url);
  api.registerTool(ctx => {
    const session = ctx.sessionKey?.replace(/^agent:main:/, '');
    if (!session || !/^[A-Za-z0-9_.-]{1,200}$/.test(session)) return null;
    return { name: 'easel_xhs_cards', label: '制作与验收小红书三图卡组',
      description: 'submit一次登记封面/卖点/场景收尾3张独立3:4图片；style统一主体和风格。固定requestId防重发，排队不换标识。status只读。三图保存不代表质量通过，必须逐张查看实际图片后review，提交当前sha256、逐图审图依据和全部质量检查。review不生图不发布；失败不自动重生。',
      parameters: { type:'object', additionalProperties:false, required:['ticket','requestId','action'], properties: {
        ticket:{type:'string',pattern:'^[a-f0-9]{48}$'},requestId:{type:'string',pattern:'^[A-Za-z0-9_.-]{1,100}$'},
        referenceId:{type:'string',pattern:'^[a-f0-9]{32}$'},
        action:{type:'string',enum:['submit','status','review']},style:{type:'string',minLength:1,maxLength:500},
        prompts:{type:'array',minItems:3,maxItems:3,items:{type:'string',minLength:1,maxLength:1200}},
        reviews:{type:'array',minItems:3,maxItems:3,items:{type:'object',additionalProperties:false,
          required:['sha256','evidence',...checks],properties:{sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
            evidence:{type:'string',minLength:10,maxLength:600},...Object.fromEntries(checks.map(k=>[k,{type:'boolean'}]))}}},
      }},
      async execute(call,args,signal) {
        if (!args || !/^[a-f0-9]{48}$/.test(args.ticket) || !/^[A-Za-z0-9_.-]{1,100}$/.test(args.requestId)
          || !['submit','status','review'].includes(args.action)) throw new Error('无效卡组参数');
        return new Promise((resolve,reject)=>{
          const child=spawn(process.env.EASEL_PYTHON||(process.platform==='win32'?'python':'python3'),
            [path.join(root,'skills/shared/scripts/image_job.py'),'cards','--ticket',args.ticket,'--session',session,'--payload',JSON.stringify(args)],
            {cwd:root,windowsHide:true,signal,env:{...process.env,PYTHONIOENCODING:'utf-8',EASEL_CODE_ROOT:root}});
          let output='',overflow=false;
          const timer=setTimeout(()=>child.kill(),30000);
          child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>262144){overflow=true;child.kill();}});
          child.stderr.resume();
          child.on('error',()=>{clearTimeout(timer);reject(new Error('卡组执行端不可用；先查看现有任务，不换标识重试'));});
          child.on('close',code=>{clearTimeout(timer);
            if(code!==0||overflow)return reject(new Error('卡组未通过登记或质量校验；保留现有图，查看原任务状态，不换标识重生'));
            try {const result=JSON.parse(output);if(!result.ok)throw new Error();
              resolve({content:[{type:'text',text:JSON.stringify(result)}],details:result});
            } catch {reject(new Error('卡组回执不可读，先查看现有任务'));}
          });
        });
      },
    };
  },{name:'easel_xhs_cards'});
}
