import fs from 'node:fs';
import ts from 'typescript';
const modules=new Map();
export async function tsModuleUrl(url){
 const href=String(url);if(modules.has(href))return modules.get(href);
 let code=ts.transpileModule(fs.readFileSync(new URL(href),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 const imports=[...code.matchAll(/from\s*['"](\.[^'"]+)['"]/g)];
 for(const match of imports){const dependency=new URL(match[1]+(/\.[cm]?[jt]sx?$/.test(match[1])?'':'.ts'),href);const target=await tsModuleUrl(dependency);code=code.replace(match[0],`from '${target}'`);}
 const result=`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;modules.set(href,result);return result;
}
export async function loadTsModule(path,base=import.meta.url){return import(await tsModuleUrl(new URL(path,base)));}
