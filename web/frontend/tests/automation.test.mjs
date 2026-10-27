import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act,createElement} from 'react';
import {loadTsModule} from './load-ts.mjs';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://easel.test/',pretendToBeVisual:true});
globalThis.window=dom.window;globalThis.document=window.document;globalThis.HTMLElement=window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(globalThis,'navigator',{configurable:true,value:window.navigator});
const {createRoot}=await import('react-dom/client');
const {default:AutomationPage}=await loadTsModule('../src/components/AutomationPage.tsx');
const {matchesPlan,planState,nextRunLabel,scheduleLabel}=await loadTsModule('../src/lib/automation.ts');
const schedule={kind:'workdays',timezone:'Asia/Shanghai',time:'18:30',minutes:60,weekdays:[0],day:1};
const goal={objective:'隔离合成：根据已有内容整理选题',modelRef:'fixture/model',criteria:[{type:'review',label:'人工检查',value:''}],maxIterations:5,maxSeconds:1200,maxTools:40,maxImages:0};
const first={id:'p1',title:'隔离合成 · 每日选题',enabled:true,nextAt:4600,schedule,goal,history:[],triggerCount:129,launchedCount:120,activeCount:0};
const complete={...first,id:'p2',title:'隔离合成 · 单次已完成',enabled:false,nextAt:null,schedule:{...schedule,kind:'once'},history:[{at:1000,goalId:'g2',sessionId:'s2',trigger:'manual',status:'queued'}],lastGoal:{id:'g2',sessionId:'s2',status:'completed',reason:''}};
const review={...first,id:'p3',title:'隔离合成 · 等待验收',enabled:false,lastGoal:{id:'g3',status:'blocked',phase:'review',reason:'请检查交付质量'},history:[{at:1000,goalId:'g3',trigger:'manual',status:'queued'}]};
const running={...first,id:'p4',title:'隔离合成 · 暂停排期仍运行',enabled:false,activeCount:1};
const snapshot={plans:[first,complete,review,running],goals:[],runs:[],serverTime:1000};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('plan lifecycle separates repeating success, completed once, review and paused active work',()=>{
  assert.equal(matchesPlan({...first,lastGoal:complete.lastGoal},[],'completed'),false);
  assert.equal(matchesPlan(complete,[],'completed'),true);
  assert.equal(matchesPlan(review,[],'attention'),true);
  assert.equal(matchesPlan(running,[],'running'),true);
  assert.equal(planState(running,[]).label,'运行中');
  assert.equal(nextRunLabel(running,1000),'排期已暂停');
  assert.equal(nextRunLabel(first,5000),'等待触发');
  assert.equal(nextRunLabel(first,1000),'1 小时后');
  assert.equal(scheduleLabel({...schedule,kind:'weekly',weekdays:[4,0]}),'每周一、五 18:30');
});

async function setup(t,snapshotValue=snapshot,powerOptions={}){
  const h={reads:0,requests:[],failRead:false,failSave:false,preview:null,action:null,opened:[],powerEnabled:powerOptions.enabled??false,powerSupported:powerOptions.supported??true,powerReason:powerOptions.reason??''};
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    const path=String(url),body=options.body?JSON.parse(options.body):undefined;h.requests.push({path,body,method:options.method});
    let value;
    if(path==='/api/tasks'){h.reads++;if(h.failRead)throw new Error('隔离读取失败');value=snapshotValue;}
    else if(path.startsWith('/api/agent-office/models'))value={available:true,scope:'next_turn',options:[{id:'fixture/model',provider:'fixture',model:'model',label:'隔离模型',configured:true}],reason:''};
    else if(path==='/api/tasks/capability')value={ready:powerOptions.openReady??true,reason:powerOptions.openReady===false?'OpenClaw离线':''};
    else if(path==='/api/tasks/capability?engine=codex')value={ready:powerOptions.nativeReady??true,reason:''};
    else if(path==='/api/codex/runtime')value=powerOptions.nativeRuntime??{available:true,auth:'authenticated',options:[{id:'codex/fixture',provider:'codex',model:'fixture',configured:true,label:'隔离原生模型'}]};
    else if(path==='/api/tasks/runtime'){if(options.method==='POST')h.powerEnabled=body.keepAwake;value={supported:h.powerSupported,enabled:h.powerEnabled,active:false,reason:h.powerReason};}
    else if(path==='/api/tasks/preview')value=h.preview?await h.preview(body):{times:[2000,3000,4000]};
    else if(path==='/api/tasks/plans'||/^\/api\/tasks\/plans\/[^/]+$/.test(path)){if(h.failSave)return new Response(JSON.stringify({detail:'隔离保存失败'}),{status:409});value={id:'new-plan'};}
    else if(path.endsWith('/action'))value=h.action?await h.action():{};
    else throw new Error('Unexpected fixture route '+path);
    return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  });
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  await act(async()=>root.render(createElement(AutomationPage,{sessions:powerOptions.sessions??[],sessionId:powerOptions.sessionId??null,onOpen:id=>h.opened.push(id)})));
  t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  const button=text=>[...host.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
  const click=async text=>act(async()=>{assert.ok(button(text),text);button(text).click();});
  const choose=async(label,text)=>{
    await act(async()=>host.querySelector(`button[aria-label="${label}"]`).click());
    const option=[...document.querySelectorAll('[role=option]')].find(el=>el.textContent.includes(text));assert.ok(option,text);
    await act(async()=>option.click());
  };
  return {h,host,button,click,choose};
}

test('native schedules remain runnable when OpenClaw is offline and save explicit observation mode',async t=>{
  const native={...first,enabled:false,goal:{...goal,engine:'codex',toolBudgetMode:'observed',modelRef:'codex/fixture'}};
  const v=await setup(t,{...snapshot,plans:[native]},{openReady:false,sessions:[{id:'native-chat',title:'原生对话',engine:'codex'},{id:'open-chat',title:'旧引擎对话',engine:'openclaw'}]});
  assert.equal(v.button('立即运行一次').disabled,false);
  assert.equal(v.host.querySelector('.automation-service summary').textContent,'执行设置');
  await v.click('新建计划');await v.choose('计划执行引擎','Codex');
  await v.choose('指定执行模型','隔离原生模型');
  await act(async()=>v.host.querySelector('[aria-label="任务对话"]').click());
  assert.ok([...document.querySelectorAll('[role=option]')].some(el=>el.textContent.includes('原生对话')));
  assert.ok(![...document.querySelectorAll('[role=option]')].some(el=>el.textContent.includes('旧引擎对话')));
  await act(async()=>[...document.querySelectorAll('[role=option]')].find(el=>el.textContent.includes('原生对话')).click());
  const input=v.host.querySelector('textarea');
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(input,'隔离原生计划');input.dispatchEvent(new window.Event('input',{bubbles:true}));});
  assert.match(v.host.textContent,/并行操作可能超额/);
  await v.click('保存为暂停计划');
  const saved=v.h.requests.find(row=>row.path==='/api/tasks/plans');
  assert.equal(saved.body.goal.engine,'codex');assert.equal(saved.body.goal.toolBudgetMode,'observed');assert.equal(saved.body.sessionId,'native-chat');
  assert.ok(!v.h.requests.some(row=>row.path.endsWith('/action')));
});

test('native authentication failure prevents saving without substituting an OpenClaw model',async t=>{
  const v=await setup(t,snapshot,{nativeRuntime:{available:true,auth:'login_required',options:[]},nativeReady:false});
  await v.click('新建计划');await v.choose('计划执行引擎','Codex');
  assert.match(v.host.querySelector('[role=alert]').textContent,/请先登录/);
  assert.equal(v.button('保存为暂停计划').disabled,true);
  assert.ok(!v.host.querySelector('[aria-label="指定执行模型"]').textContent.includes('fixture/model'));
});

test('keep-awake switch is off by default and persists an explicit preference',async t=>{
  const v=await setup(t),control=v.host.querySelector('[role="switch"][aria-label="任务运行时保持后端主机唤醒"]');
  assert.equal(control.getAttribute('aria-checked'),'false');
  await act(async()=>control.click());
  assert.equal(control.getAttribute('aria-checked'),'true');
  assert.deepEqual(v.h.requests.find(row=>row.path==='/api/tasks/runtime'&&row.method==='POST').body,{keepAwake:true});
  assert.match(v.host.textContent,/任务运行时保持后端主机唤醒/);
});

test('keep-awake system failures remain visible without changing the saved preference',async t=>{
  const v=await setup(t);v.h.powerReason='系统未能启用防休眠。';
  await act(async()=>v.host.querySelector('[role="switch"][aria-label="任务运行时保持后端主机唤醒"]').click());
  assert.equal(v.host.querySelector('[role="switch"][aria-label="任务运行时保持后端主机唤醒"]').getAttribute('aria-checked'),'true');
  assert.match(v.host.querySelector('[role="alert"]').textContent,/系统未能启用防休眠/);
});

test('an unsupported host can clear a previously enabled preference',async t=>{
  const v=await setup(t,snapshot,{supported:false,enabled:true,reason:'此后端主机不支持防休眠。'});
  const control=v.host.querySelector('[role="switch"][aria-label="任务运行时保持后端主机唤醒"]');
  assert.equal(control.disabled,false);
  assert.equal(control.getAttribute('aria-checked'),'true');
  await act(async()=>control.click());
  assert.equal(control.getAttribute('aria-checked'),'false');
  assert.deepEqual(v.h.requests.find(row=>row.path==='/api/tasks/runtime'&&row.method==='POST').body,{keepAwake:false});
});

test('filters use live result metadata and total count, and open the original result',async t=>{
  const v=await setup(t);assert.equal(v.host.querySelectorAll('.plan-card').length,4);
  assert.match(v.host.textContent,/已触发 129 次/);
  await act(async()=>v.host.querySelector('[aria-label="计划筛选"] button:nth-child(4)').click());
  assert.equal(v.host.querySelectorAll('.plan-card').length,1);assert.match(v.host.querySelector('.plan-card').textContent,/等待验收/);
  await act(async()=>v.host.querySelector('[aria-label="计划筛选"] button:last-child').click());
  await v.click('查看对话与结果');assert.deepEqual(v.h.opened,['s2']);
});

test('template prefills a paused draft, polling and collapsing preserve it, save failure stays visible',async t=>{
  const v=await setup(t);await act(async()=>v.host.querySelector('[aria-label="计划模板"] button').click());
  assert.equal(v.host.querySelector('input[maxlength="100"]').value,'每日选题');
  const draftText=v.host.querySelector('textarea').value;
  assert.equal(v.host.querySelector('.automation-advanced').open,false);
  await v.choose('指定执行模型','隔离模型');
  v.h.failSave=true;await v.click('保存为暂停计划');
  assert.match(v.host.textContent,/隔离保存失败/);assert.equal(v.host.querySelector('textarea').value,draftText);
  await v.click('刷新');assert.match(v.host.textContent,/隔离保存失败/,'successful polling must not erase an action failure');
  await v.click('收起');assert.equal(v.host.querySelector('form'),null);await v.click('继续编辑');
  assert.equal(v.host.querySelector('input[maxlength="100"]').value,'每日选题');
  v.h.failSave=false;await v.click('保存为暂停计划');
  assert.equal(v.host.querySelector('form'),null);
  const saved=v.h.requests.filter(r=>r.path==='/api/tasks/plans').at(-1);assert.equal(saved.body.schedule.kind,'workdays');assert.equal(saved.body.goal.modelRef,'fixture/model');
  assert.equal(v.h.requests.filter(r=>r.path.endsWith('/action')).length,0,'a template never enables or launches work');
});

test('changing schedule invalidates the old preview until current time is checked',async t=>{
  const v=await setup(t);await v.click('新建计划');await v.choose('指定执行模型','隔离模型');
  assert.equal(v.button('保存为暂停计划').disabled,false);
  const gate=deferred();v.h.preview=()=>gate.promise;
  await v.choose('执行周期','每周');assert.equal(v.button('保存为暂停计划').disabled,true);
  await act(async()=>gate.resolve({times:[5000]}));assert.equal(v.button('保存为暂停计划').disabled,false);
});

test('failed reads preserve the last list and block new launches while pause stays available',async t=>{
  const v=await setup(t);v.h.failRead=true;await v.click('刷新');
  assert.equal(v.host.querySelectorAll('.plan-card').length,4);assert.match(v.host.textContent,/隔离读取失败/);
  assert.equal(v.button('暂停排期').disabled,false);
  assert.ok([...v.host.querySelectorAll('.plan-menu button')].filter(el=>el.textContent==='立即运行一次').every(el=>el.disabled));
});

test('manual run registers a request id once and leaves the saved schedule unchanged',async t=>{
  const v=await setup(t),gate=deferred();v.h.action=()=>gate.promise;
  const run=[...v.host.querySelectorAll('.plan-card')][0].querySelector('.plan-menu button:last-child');
  await act(async()=>{run.click();run.click();});
  const actions=v.h.requests.filter(r=>r.path.endsWith('/action'));assert.equal(actions.length,1);assert.equal(actions[0].body.action,'run');assert.ok(actions[0].body.requestId);
  assert.equal(actions[0].body.schedule,undefined);await act(async()=>gate.resolve({}));
});

test('template can use planned execution without enabling the schedule or multiplying budgets',async t=>{
  const v=await setup(t);await act(async()=>v.host.querySelector('[aria-label="计划模板"] button').click());
  await v.choose('指定执行模型','隔离模型');await v.choose('计划推进方式','任务拆解');
  await v.click('保存为暂停计划');
  const saved=v.h.requests.find(r=>r.path==='/api/tasks/plans').body;
  assert.equal(saved.goal.workflow,'planned-reviewed-delivery');assert.equal(saved.goal.maxIterations,16);
  assert.equal(saved.goal.maxSeconds,1200);assert.equal(saved.goal.maxTools,40);assert.equal(saved.goal.criteria[0].type,'review');
  assert.equal(v.h.requests.filter(r=>r.path.endsWith('/action')).length,0);
});

test('editing a planned schedule preserves its protocol and custom iteration limit',async t=>{
  const planned={...first,enabled:false,goal:{...goal,workflow:'planned-reviewed-delivery',maxIterations:13}};
  const v=await setup(t,{...snapshot,plans:[planned]});await v.click('编辑计划');
  assert.match(v.host.querySelector('[aria-label="计划推进方式"]').textContent,/任务拆解/);
  await v.click('保存为暂停计划');
  const saved=v.h.requests.find(r=>r.path==='/api/tasks/plans/p1').body;
  assert.equal(saved.goal.workflow,'planned-reviewed-delivery');assert.equal(saved.goal.maxIterations,13);
});
