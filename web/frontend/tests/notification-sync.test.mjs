import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { loadTsModule } from './load-ts.mjs';

globalThis.window = new Window({url:'http://127.0.0.1:7880/'});
globalThis.document = window.document;
globalThis.sessionStorage = window.sessionStorage;
const events = await loadTsModule('../src/lib/eventNotifications.ts', import.meta.url);

test('durable notification sync retries offline operations, preserves actions, respects server clears and does not toast replay', async t => {
  let offline = true;
  const server = new Map(); const seen = new Set(); const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init={}) => {
    requests.push({url, method:init.method||'GET'});
    if (offline) throw Error('offline');
    const body = init.body ? JSON.parse(init.body) : {};
    if (init.method === 'POST' && url.endsWith('/read')) {
      for (const [id, row] of server) if (!body.id || id === body.id) row.read = true;
    } else if (init.method === 'POST') {
      for (const row of body.notices) if (!seen.has(row.id)) {seen.add(row.id);server.set(row.id,row);}
    } else if (init.method === 'DELETE') server.clear();
    return new Response(JSON.stringify({notices:[...server.values()],seen:[...seen]}));
  });
  let actions = 0;
  events.recordEvent('done','success',{label:'open',run:()=>actions++},'done');
  await events.syncEvents();
  assert.equal(events.readEventSync(),'error');
  assert.equal(events.readEvents().length,1);
  offline = false;
  await events.syncEvents();
  assert.equal(server.size,1); assert.equal(events.readEventSync(),'saved');
  events.readEvents()[0].action.run(); assert.equal(actions,1);
  events.markEventsRead('done'); await events.syncEvents();
  assert.equal(server.get('done').read,true);
  server.clear(); // Another tab cleared history; tombstones remain authoritative.
  await events.syncEvents(); assert.equal(events.readEvents().length,0);
  assert.equal(events.recordEvent('duplicate','success',undefined,'done'),false);
  events.recordEvent('new','info',undefined,'new'); events.clearEvents();
  await events.syncEvents(); assert.equal(server.size,0);
  assert.ok(requests.every(request=>request.url.endsWith('/api/notifications')||request.url.endsWith('/api/notifications/read')));
  assert.equal(events.recordEvent('duplicate','success',undefined,'new'),false);
});

test('deleting a chat removes all its notices immediately, retries persistence and blocks late arrivals', async t => {
  let offline = true; const server = new Map(); const tombstones = new Set();
  t.mock.method(globalThis, 'fetch', async (_url, init={}) => {
    if (offline) throw Error('offline');
    const body=init.body?JSON.parse(init.body):{};
    if (String(_url).endsWith('/remove')) {
      tombstones.add(body.sessionId);
      for (const [id,row] of server) if(row.target?.sessionId===body.sessionId) server.delete(id);
    } else if(init.method==='POST') {
      for(const row of body.notices||[]) if(!tombstones.has(row.target?.sessionId)) server.set(row.id,row);
    }
    return new Response(JSON.stringify({notices:[...server.values()],seen:[...server.keys()]}));
  });
  events.recordEvent('gone','success',undefined,'gone-1',{page:'chat',sessionId:'gone-chat'});
  events.recordEvent('keep','success',undefined,'keep-1',{page:'chat',sessionId:'keep-chat'});
  events.removeSessionEvents('gone-chat');
  assert.deepEqual(events.readEvents().map(x=>x.id),['keep-1']);
  assert.equal(events.recordEvent('late','error',undefined,'gone-late',{page:'chat',sessionId:'gone-chat'}),false);
  await events.syncEvents(); assert.equal(events.readEventSync(),'error');
  offline=false; await events.syncEvents();
  assert.ok(tombstones.has('gone-chat'));
  assert.deepEqual([...server.keys()],['keep-1']);
});

test('deleting a chat also removes legacy completion events without targets and blocks their replay', async t => {
  const events = await loadTsModule('../src/lib/eventNotifications.ts', import.meta.url);
  events.recordEvent('legacy completion','success',undefined,'chat:legacy-gone:turn-1:已完成');
  events.recordEvent('other completion','success',undefined,'chat:legacy-keep:turn-1:已完成');
  events.removeSessionEvents('legacy-gone');
  assert.ok(!events.readEvents().some(row=>row.id==='chat:legacy-gone:turn-1:已完成'));
  assert.ok(events.readEvents().some(row=>row.id==='chat:legacy-keep:turn-1:已完成'));
  assert.equal(events.recordEvent('late legacy completion','success',undefined,'chat:legacy-gone:turn-2:已完成'),false);
});
