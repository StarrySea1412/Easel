import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';
const { deriveOfficeWorkflow } = await loadTsModule('../src/lib/officeWorkflow.ts');
const agent = (id, state = 'working', parentId, source = 'live') => ({ id, name:id, role:'成员', task:'等待另一个人的结果', state, parentId, source });
test('live workflow uses confirmed parent relations without inventing dependencies from task prose', () => {
  const flow = deriveOfficeWorkflow([agent('root'),agent('child','waiting','root'),agent('orphan','unknown','missing'),agent('self','error','self')], [], 'live', 48);
  assert.deepEqual(flow.links,[{from:'root',to:'child',label:'协作上级 → 成员',kind:'parent'}]);
  assert.equal(flow.lanes.attention.length,2); assert.equal(flow.lanes.waiting.length,1);
});
test('returned tool results do not finish tasks or cross source/identity boundaries', () => {
  const flow = deriveOfficeWorkflow([agent('root'),agent('demo','done',undefined,'demo')], [
    {id:'r',agentId:'root',kind:'result',status:'returned',source:'live'},
    {id:'d',agentId:'root',kind:'result',source:'demo'}, {id:'x',agentId:'missing',kind:'call',source:'live'},
  ],'live');
  assert.equal(flow.lanes.active.length,1); assert.equal(flow.lanes.finished.length,0);
  assert.deepEqual(flow.records.map(x=>x.id),['r']);
});
test('demo handoffs follow seek time, never leak into live data, and reverse on replay', () => {
  const members = ['coordinator','researcher','designer','writer','tester','reviewer'].map(id=>agent(id,'working',undefined,'demo'));
  const links = t=>deriveOfficeWorkflow(members,[],'demo',t).links;
  assert.equal(links(16).filter(x=>x.delivered).length,0);
  assert.equal(links(17).filter(x=>x.delivered).length,2);
  assert.equal(links(48).filter(x=>x.delivered).length,5);
  assert.equal(links(0).filter(x=>x.delivered).length,0);
  assert.equal(deriveOfficeWorkflow(members,[],'live',48).links.length,0);
});
