import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './load-ts.mjs';

const { officeZoneForAgent, searchOfficeTeam, createTeamDemoOfficeAgents, createTeamDemoOfficeEvents } = await loadTsModule('../src/lib/officeTeams.ts');

for (const count of [9, 12, 20, 50]) test(`${count} observed identities remain searchable while every zone contains at most eight`, () => {
  const agents = Array.from({ length: count }, (_, index) => ({ id: `worker-${index + 1}`, name: `成员 ${index + 1}`, role: '研究', task: `任务 ${index + 1}`, state: 'working', source: 'live' }));
  const reached = new Set();
  for (const agent of agents) {
    const zone = officeZoneForAgent(agents, agent.id);
    assert.ok(zone.agents.length <= 8);
    assert.ok(zone.agents.includes(agent));
    zone.agents.forEach(item => reached.add(item.id));
  }
  assert.equal(reached.size, count);
  assert.equal(agents.length, count);
  assert.deepEqual(searchOfficeTeam(agents, `worker-${count}`), [agents.at(-1)]);
  assert.equal(searchOfficeTeam(agents, '研究 工作中').length, count);
  assert.equal(officeZoneForAgent(agents, 'removed-identity').index, 0);
});

test('the 50-person demo has unique identities and matching synthetic events without altering the six-person story', () => {
  const small = createTeamDemoOfficeAgents(20, 6);
  const large = createTeamDemoOfficeAgents(20, 50);
  assert.deepEqual(large.slice(0, 6), small);
  assert.equal(new Set(large.map(agent => agent.id)).size, 50);
  assert.equal(new Set(large.map(agent => agent.name)).size, 50);
  assert.ok(large.every(agent => agent.source === 'demo'));
  const events = createTeamDemoOfficeEvents(48, createTeamDemoOfficeAgents(48, 50));
  assert.ok(events.every(event => event.source === 'demo' && large.some(agent => agent.id === event.agentId)));
  assert.equal(new Set(events.map(event => event.id)).size, events.length);
  assert.ok(large.every(agent => events.some(event => event.agentId === agent.id)));
});
