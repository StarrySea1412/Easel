import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveCodeRoot } from './code-root.mjs';

export function stageDeliveredImage(session, source, env=process.env) {
  const root=resolveCodeRoot(import.meta.url, env);
  return new Promise((resolve,reject)=>{
    const child=spawn(env.EASEL_PYTHON||(process.platform==='win32'?'python':'python3'),
      [path.join(root,'skills/shared/scripts/stage_inspection.py'),'--session',session,'--path',source],
      {cwd:root,windowsHide:true,env:{...env,PYTHONIOENCODING:'utf-8',EASEL_CODE_ROOT:root}});
    let output='';let overflow=false;
    const timer=setTimeout(()=>child.kill(),5000);
    child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>8192){overflow=true;child.kill();}});
    child.stderr.resume();
    child.on('error',()=>{clearTimeout(timer);reject(new Error('Image inspection staging unavailable'));});
    child.on('close',code=>{
      clearTimeout(timer);
      if(code!==0||overflow)return reject(new Error('Image inspection ownership validation failed'));
      try{const value=JSON.parse(output);if(typeof value.path!=='string'||!path.isAbsolute(value.path))throw new Error();resolve(value.path);}
      catch{reject(new Error('Image inspection staging receipt invalid'));}
    });
  });
}
