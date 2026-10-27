"""Semantic judgments are synthetic; version/transaction/source rules are real."""
from concurrent.futures import ThreadPoolExecutor
import json

import pytest

from easel.profile_memory import Conflict, MemoryStore, digest
from tests.test_run_experience import env, bind, finish, QUOTE, LESSON


def act(store, entry, action, **extra):
    return store.change('one', entry['id'], action, {
        **{key: entry.get(key) for key in ('revision', 'contentHash', 'scopeHash', 'conditionsHash',
                                         'replacementHash', 'consolidationHash')},
        'profileRevision': store.state('one')['revision'], **extra})


def add(store, text, **extra):
    row = store.propose('one', {'text': text, 'scope': {'kind': 'profile'}, **extra})
    return act(store, row, 'accept')


def reference(row):
    return {key: row[key] for key in ('id', 'revision', 'contentHash', 'scopeHash', 'conditionsHash')}


def proposal(rows, kind='merge'):
    return {'kind': kind, 'reason': '两条经验分别约束交付与核验；保留否定、数值及验证边界。',
            'entries': [reference(row) for row in rows]}


def candidate(store, rows, **extra):
    return store.propose('one', {'text': LESSON, 'scope': rows[0]['scope'], 'conditions': rows[0]['conditions'],
                                'consolidation': proposal(rows), **extra})


def originals(env):
    return [add(env.memory, '交付前检查文件实际存在，不能仅凭路径断言已完成。'),
            add(env.memory, '交付后核对文件内容；HTTP 200不能代替业务验收。')]


def test_pending_comparison_atomic_confirmation_recall_and_idempotent_retry(env):
    store = env.memory; old = originals(env)
    new = candidate(store, old)
    assert new['status'] == 'pending'
    assert {e['id'] for e in store.context('one')['entries']} == {e['id'] for e in old}
    assert not any(e['text'] in json.dumps(new['consolidation'], ensure_ascii=False) for e in old)
    with pytest.raises(Conflict): act(store, new, 'accept', consolidationHash='forged')
    accepted = act(store, new, 'accept')
    assert store.context('one')['entries'][0]['id'] == new['id']
    assert [e['status'] for e in store.state('one')['entries']] == ['active', 'superseded', 'superseded']
    assert act(store, new, 'accept') == accepted
    assert candidate(store, list(reversed(old)))['id'] == new['id']
    with store.connect() as db:
        assert db.execute('SELECT count(*) FROM consolidation_links').fetchone()[0] == 2
    reloaded = MemoryStore(env.root)
    assert reloaded.context('one')['entries'][0]['id'] == new['id']


@pytest.mark.parametrize('field,value', [('conditions', {'taskTypes': ['writing']}),
    ('scope', {'kind': 'account', 'platform': 'douyin', 'accountId': 'other'})])
def test_scope_and_conditions_cannot_be_broadened(env, field, value):
    old = originals(env)
    with pytest.raises(Conflict): candidate(env.memory, old, **{field: value})
    new = candidate(env.memory, old)
    with pytest.raises(Conflict): act(env.memory, new, 'edit', text=LESSON, conditions={'taskTypes': ['coding']})
    assert len(env.memory.context('one')['entries']) == 2


@pytest.mark.parametrize('mutate', ['edit', 'invalidate', 'delete'])
def test_stale_member_blocks_every_replacement(env, mutate):
    store = env.memory; old = originals(env); new = candidate(store, old)
    act(store, old[1], mutate, **({'text': '用户修改后的新结论。'} if mutate == 'edit' else {}))
    with pytest.raises(Conflict): act(store, new, 'accept')
    assert next(e for e in store.state('one')['entries'] if e['id'] == old[0]['id'])['status'] == 'active'
    with store.connect() as db:
        assert not db.execute('SELECT 1 FROM consolidation_links').fetchone()


def test_acceptance_transaction_rolls_back_every_entry_and_link(env, monkeypatch):
    store = env.memory; old = originals(env); new = candidate(store, old)
    save = store._save
    def fail(db, row):
        save(db, row)
        if row['id'] == old[1]['id']: raise OSError('synthetic persistence failure')
    monkeypatch.setattr(store, '_save', fail)
    with pytest.raises(OSError): act(store, new, 'accept')
    assert {e['id'] for e in store.context('one')['entries']} == {e['id'] for e in old}
    with store.connect() as db:
        assert not db.execute('SELECT 1 FROM consolidation_links').fetchone()
    monkeypatch.setattr(store, '_save', save)
    act(store, new, 'accept')


def test_competing_proposals_cannot_both_activate(env):
    store = env.memory; old = originals(env)
    candidates = [candidate(store, old, text=LESSON + suffix) for suffix in ('方案甲', '方案乙')]
    def accept(row):
        try: return act(store, row, 'accept')['status']
        except Conflict: return 'conflict'
    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(accept, candidates)) == ['active', 'conflict']
    assert len(store.context('one')['entries']) == 1


def test_deleted_source_disables_recall_projection_and_cannot_resurrect_candidate(env):
    store = env.memory; old = originals(env); new = candidate(store, old); act(store, new, 'accept')
    original = next(e for e in store.state('one')['entries'] if e['id'] == old[0]['id'])
    act(store, original, 'delete')
    assert not store.context('one')['entries']
    assert LESSON not in (env.root / 'profiles/one/memory.md').read_text(encoding='utf-8')
    current = next(e for e in store.state('one')['entries'] if e['id'] == new['id'])
    assert current['sourceStatus'] == 'missing'
    act(store, current, 'delete')
    with pytest.raises(Conflict): candidate(store, old)
    with store.connect() as db:
        bodies = json.dumps([r[0] for r in db.execute('SELECT data FROM revisions')], ensure_ascii=False)
    assert old[0]['text'] not in bodies


def test_deleted_intermediate_keeps_restore_exclusion_across_multi_source_graph(env):
    store = env.memory; old = originals(env); new = act(store, candidate(store, old), 'accept')
    third = add(store, '文件链接与内容都应复核；一次检查不能证明持续可用。')
    newest = act(store, candidate(store, [new, third], text=LESSON+'完整修订'), 'accept')
    middle = next(e for e in store.state('one')['entries'] if e['id'] == new['id'])
    act(store, middle, 'delete')
    first = next(e for e in store.state('one')['entries'] if e['id'] == old[0]['id'])
    with pytest.raises(Conflict): act(store, first, 'restore')
    act(store, newest, 'invalidate')
    assert act(store, first, 'restore')['status'] == 'active'
    second = next(e for e in store.state('one')['entries'] if e['id'] == old[1]['id'])
    with pytest.raises(Conflict): act(store, second, 'restore')


def test_changed_original_run_source_suspends_merged_context_and_projection(env, monkeypatch):
    store=env.memory
    bind(env);store.queue_run('s','t',{'text':LESSON,'quote':QUOTE});finish(env)
    receipt=store.settle_run('s','t')
    row=next(item for item in store.state('one')['entries'] if item['id'] in receipt['entryIds'])
    original=act(store,row,'accept')
    other=add(store,'交付文件须人工验收，不应将工具执行成功等同于内容正确。')
    merged=act(store,candidate(store,[original,other],text=LESSON+'保留人工验收。'),'accept')
    resolve=store.resolve_run_source
    monkeypatch.setattr(store,'resolve_run_source',lambda *args:{**resolve(*args),'sourceHash':'changed-source'})
    assert not store.context('one')['entries']
    assert merged['text'] not in (env.root/'profiles/one/memory.md').read_text(encoding='utf-8')
    assert next(item for item in store.state('one')['entries'] if item['id']==merged['id'])['sourceStatus']=='changed'


@pytest.mark.parametrize('engine', ['openclaw', 'codex'])
def test_original_agent_can_only_propose_recalled_versions_and_waits_for_final_source(env, engine):
    store = env.memory; old = originals(env); bind(env, engine=engine)
    data = {'text': LESSON, 'quote': QUOTE, 'consolidation': proposal(old)}
    with pytest.raises(Conflict, match='实际读取'): store.queue_run('s', 't', data)
    assert store.record_use('one', 's', 't', store.context('one'))
    assert store.queue_run('s', 't', data)['status'] == 'queued'
    assert len(store.context('one')['entries']) == 2
    finish(env, engine=engine)
    receipt = store.settle_run('s', 't')
    assert receipt['createdCount'] == 1 and receipt['modelRequests'] == 0
    new = next(e for e in store.state('one')['entries'] if e['id'] in receipt['entryIds'])
    assert new['status'] == 'pending' and new['source']['type'] == 'run'
    act(store, new, 'accept')
    assert store.context('one')['entries'][0]['id'] == new['id']


def test_stale_queued_consolidation_is_not_downgraded_or_retried_after_restart(env):
    store = env.memory; old = originals(env); bind(env)
    store.record_use('one', 's', 't', store.context('one'))
    data = {'text': LESSON, 'quote': QUOTE, 'consolidation': proposal(old)}
    store.queue_run('s', 't', data)
    act(store, old[0], 'edit', text='用户已纠正，不能按旧版本归并。')
    finish(env)
    receipt = MemoryStore(env.root).settle_run('s', 't')
    assert receipt['staleCount'] == 1 and receipt['createdCount'] == 0
    assert store.queue_run('s', 't', data) == receipt
    assert len(store.state('one')['entries']) == 2


def test_conflict_proposal_keeps_negation_and_requires_explicit_confirmation(env):
    store = env.memory; old = originals(env)
    new = candidate(store, [old[0]], consolidation=proposal([old[0]], 'conflict'),
                    text='不能只检查文件存在；还需检查正文且保留人工验收。')
    assert new['consolidation']['kind'] == 'conflict'
    assert len(store.context('one')['entries']) == 2
    act(store, new, 'accept')
    assert len(store.context('one')['entries']) == 2


@pytest.mark.parametrize('value', [
    {'kind':'merge','reason':'重复','entries':[]},
    {'kind':'automatic','reason':'重复','entries':[]},
    {'kind':'conflict','reason':'','entries':[]},
])
def test_invalid_relation_never_creates_an_entry(env, value):
    with pytest.raises(ValueError): env.memory.propose('one', {'text': LESSON, 'scope': {'kind':'profile'}, 'consolidation':value})
    assert not env.memory.state('one')['entries']


def test_http_confirmation_requires_ui_origin_and_exact_consolidation_hash(env):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from web.profile_memory_routes import create_router
    old = originals(env)
    app = FastAPI(); app.include_router(create_router(lambda: env.memory))
    with TestClient(app) as client:
        base = '/api/persona/one/memory'
        response = client.post(base+'/candidates', json={'text': LESSON, 'scope': {'kind':'profile'}, 'consolidation':proposal(old)})
        assert response.status_code == 200
        new = response.json()['entry']; version = response.json()['state']['revision']
        payload = {**{key:new.get(key) for key in ('revision','contentHash','scopeHash','conditionsHash','consolidationHash')}, 'profileRevision':version}
        url = base+'/entries/'+new['id']+'/accept'
        assert client.post(url, json=payload).status_code == 403
        headers={'Origin':'http://testserver','sec-fetch-site':'same-origin'}
        assert client.post(url, json={**payload,'consolidationHash':'wrong'}, headers=headers).status_code == 409
        accepted = client.post(url, json=payload, headers=headers)
        assert accepted.status_code == 200
        assert [e['status'] for e in accepted.json()['entries']] == ['active','superseded','superseded']


def test_native_protocol_receives_bound_references_and_only_queues_semantic_proposal(env, monkeypatch):
    import easel.persona as persona
    from tests.test_chat_model_selection import web
    from tests.test_codex_tasks import Harness
    store = env.memory; old = originals(env)
    monkeypatch.setattr(web, 'PROFILES_DIR', store.profiles)
    monkeypatch.setattr(persona, 'PROFILES_DIR', store.profiles)
    monkeypatch.setattr(web, 'OUTPUTS_DIR', env.outputs)
    monkeypatch.setattr(web, '_memory_store', lambda: store)
    monkeypatch.setattr(web, '_writing_context', lambda _: None)
    harness = Harness(env.outputs)
    harness.codex.budgeted_message_builder = lambda req, transported: web._codex_message(req, prompt_builder=transported)
    def emit(client, state, native_turn):
        for event in [
            {'id':77,'method':'item/tool/call','params':{'tool':'easel_memory_candidate','arguments':{'text':LESSON,'quote':QUOTE,'consolidation':proposal(old)}}},
            {'method':'item/completed','params':{'item':{'id':'reply','type':'agentMessage','text':QUOTE}}},
            {'method':'turn/completed','params':{'turn':{'id':native_turn,'status':'completed'}}},
        ]:
            event['params'].update(threadId='native-'+client.workspace.name, turnId=native_turn)
            client.events.put(event)
    harness.emit = emit
    harness.codex.bind('semantic-run','codex')
    request = web.ChatRequest(message='交付文件核验',sessionId='semantic-run',turnId='semantic-turn',persona='one',engine='codex',modelRef='codex/fixture')
    try:
        harness.codex.start(request)
        run = harness.codex.active.get(request.sessionId)
        if run: assert run['finished'].wait(10)
        assert harness.replies[0]['success'] is True
        prompt = next(params for method,params in harness.calls if method=='turn/start')['input'][0]['text']
        assert old[0]['id'] in prompt and old[0]['contentHash'] in prompt
        fresh = next(row for row in store.state('one')['entries'] if row.get('consolidation'))
        assert fresh['status'] == 'pending' and fresh['source']['turnId'] == 'semantic-turn'
        assert {row['id'] for row in store.context('one')['entries']} == {row['id'] for row in old}
        assert harness.dispatched == 1
    finally:
        harness.codex.close()
