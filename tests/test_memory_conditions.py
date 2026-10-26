"""Isolated applicability and replacement lifecycles; no model/platform calls."""
import json
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from easel.profile_memory import MemoryStore, Conflict, conditions, digest
from web.profile_memory_routes import create_router


@pytest.fixture
def store(tmp_path):
    for name in ('one', 'two'):
        (tmp_path / 'profiles' / name).mkdir(parents=True)
    value = MemoryStore(tmp_path)
    for name in ('one', 'two'):
        value.import_legacy(name, {'hash': digest(''), 'profileRevision': 0, 'scope': {'kind': 'profile'}})
    return value


def propose(store, text='摄影教程先演示成品', **extra):
    return store.propose('one', {'text': text, 'scope': {'kind': 'profile'}, **extra})


def binding(entry):
    return {key: entry[key] for key in ('id', 'revision', 'contentHash', 'scopeHash', 'conditionsHash')}


def confirmation(store, entry):
    return {'profileRevision': store.state('one')['revision'], **{key: entry.get(key) for key in (
        'revision', 'contentHash', 'scopeHash', 'conditionsHash', 'replacementHash')}}


def change(store, entry, action, **extra):
    return store.change('one', entry['id'], action, {**confirmation(store, entry), **extra})


def active(store, text='摄影教程先演示成品', **extra):
    return change(store, propose(store, text, **extra), 'accept')


def current(store, entry):
    return next(row for row in store.state('one')['entries'] if row['id'] == entry['id'])


def test_conditions_normalize_and_match_literal_text_not_expressions(store):
    rule = {'taskTypes': ['writing', 'writing'], 'allKeywords': ['摄影', 'Camera', 'camera'], 'excludeKeywords': ['直播']}
    entry = active(store, conditions=rule)
    assert entry['conditions'] == {'version': 1, 'taskTypes': ['writing'], 'allKeywords': ['camera', '摄影'], 'excludeKeywords': ['直播']}
    assert not store.context('one', '摄影 CAMERA')['entries']  # unknown task
    assert not store.context('one', '摄影 CAMERA', task_type='account-analysis')['entries']
    assert not store.context('one', '摄影', task_type='writing')['entries']
    assert not store.context('one', '摄影 camera 直播', task_type='writing')['entries']
    selected = store.context('one', '摄影 CAMERA', task_type='writing')
    assert selected['entries'][0]['id'] == entry['id']
    assert entry['text'] not in (store.directory('one') / 'memory.md').read_text(encoding='utf-8')
    assert store.record_use('one', 's', 't', selected)
    receipt = store.usage('one', 's')[0]
    assert receipt['entries'][0]['conditionsHash'] == entry['conditionsHash']
    assert receipt['recall']['taskType'] == 'writing'
    assert 'CAMERA' not in json.dumps(receipt) and entry['text'] not in json.dumps(receipt, ensure_ascii=False)


@pytest.mark.parametrize('value', [[], {'taskTypes': ['unknown']}, {'allKeywords': 'word'}, {'version': 2}, {'allKeywords': ['same'], 'excludeKeywords': ['SAME']}, {'excludeKeywords': ['x'] * 13}, {'expression': 'x'}])
def test_invalid_condition_documents_are_rejected(store, value):
    with pytest.raises(ValueError):
        propose(store, conditions=value)
    assert store.state('one')['entries'] == []


def test_account_scope_conditions_relevance_and_budget_compose(store):
    entry = active(store, scope={'kind': 'account', 'platform': 'douyin', 'accountId': 'A'}, conditions={'taskTypes': ['writing']})
    assert not store.context('one', '摄影', 'douyin', 'B', task_type='writing')['entries']
    assert not store.context('one', '摄影', 'douyin', 'A', budget=1, task_type='writing')['entries']
    assert store.context('one', '摄影', 'douyin', 'A', task_type='writing')['entries'][0]['id'] == entry['id']
    assert not store.context('two', task_type='writing')['entries']


def test_old_json_and_candidate_identity_keep_compatibility(store):
    old = active(store)
    with store.connect() as db:
        raw = {key: value for key, value in old.items() if key not in ('conditions', 'conditionsHash')}
        db.execute('UPDATE entries SET data=? WHERE id=?', (json.dumps(raw), old['id']))
    assert propose(store)['id'] == old['id']
    assert store.context('one')['entries'][0]['conditions'] == conditions()
    assert old['text'] in (store.directory('one') / 'memory.md').read_text(encoding='utf-8')
    writing = propose(store, conditions={'taskTypes': ['writing']})
    assert writing['id'] != old['id']
    assert propose(store, conditions={'taskTypes': ['writing', 'writing']})['id'] == writing['id']
    changed = change(store, writing, 'edit', text='摄影新修订', conditions={'taskTypes': ['coding']})
    assert propose(store, changed['text'], conditions={'taskTypes': ['coding']})['id'] == changed['id']
    change(store, changed, 'delete')
    for text, rule in [(old['text'], {'taskTypes': ['writing']}), (changed['text'], {'taskTypes': ['coding']})]:
        with pytest.raises(Conflict):
            propose(store, text, conditions=rule)
    assert propose(store)['id'] == old['id']


def test_replacement_is_atomic_versioned_and_retry_does_not_mutate(store):
    old = active(store)
    draft = propose(store, '摄影教程按新顺序演示', replaces=binding(old))
    payload = confirmation(store, draft)
    assert store.context('one')['entries'][0]['id'] == old['id']
    new = store.change('one', draft['id'], 'accept', payload)
    assert current(store, old)['status'] == 'superseded'
    assert current(store, old)['supersededBy'] == {'id': new['id'], 'revision': new['revision']}
    assert store.context('one')['entries'][0]['id'] == new['id']
    assert store.history('one', old['id'])[-1]['status'] == 'pending'
    assert store.history('one', new['id'])[-1]['replaces'] == binding(old)
    before = store.state('one')['revision']
    assert store.change('one', draft['id'], 'accept', payload) == new
    assert store.state('one')['revision'] == before
    assert propose(store, draft['text'], replaces=binding(old))['id'] == new['id']
    new = change(store, new, 'edit', text='摄影教程的后续修订')
    with pytest.raises(Conflict):
        store.change('one', draft['id'], 'accept', payload)
    assert current(store, new)['text'] == new['text']


def test_stale_predecessor_and_parallel_candidates_keep_one_active(store):
    old = active(store)
    first = propose(store, '摄影候选一', replaces=binding(old))
    second = propose(store, '摄影候选二', replaces=binding(old))
    payloads = [confirmation(store, item) for item in (first, second)]
    def accept(index):
        item = (first, second)[index]
        try:
            store.change('one', item['id'], 'accept', payloads[index])
            return 'accepted'
        except Conflict:
            return 'conflict'
    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(accept, (0, 1))) == ['accepted', 'conflict']
    assert len(store.context('one')['entries']) == 1
    pending = next(row for row in store.state('one')['entries'] if row['status'] == 'pending')
    with pytest.raises(Conflict):
        change(store, pending, 'accept')


@pytest.mark.parametrize('patch', [
    {'scope': {'kind': 'account', 'platform': 'douyin', 'accountId': 'A'}},
    {'conditions': {'taskTypes': ['writing']}},
])
def test_replacement_cannot_remove_a_broader_or_other_account_rule(store, patch):
    old = active(store)
    with pytest.raises(Conflict):
        propose(store, '摄影条件不同的新候选', replaces=binding(old), **patch)
    assert current(store, old)['status'] == 'active'


def test_predecessor_edit_invalidates_pending_replacement_and_confirmation(store):
    old = active(store, conditions={'taskTypes': ['writing']})
    draft = propose(store, '摄影新方案', conditions=old['conditions'], replaces=binding(old))
    changed = change(store, old, 'edit', text='摄影旧经验已修改')
    with pytest.raises(Conflict):
        change(store, draft, 'accept')
    assert current(store, draft)['status'] == 'pending'
    assert current(store, changed)['status'] == 'active'
    with pytest.raises(Conflict):
        change(store, changed, 'invalidate', profileRevision=0)


def test_condition_edits_require_a_new_confirmation_identity(store):
    draft = propose(store)
    changed = change(store, draft, 'edit', conditions={'taskTypes': ['writing']}, text=draft['text'])
    with pytest.raises(Conflict):
        change(store, changed, 'accept', conditionsHash=draft['conditionsHash'])
    assert change(store, changed, 'accept')['status'] == 'active'
    assert not store.context('one')['entries']


def test_failure_between_two_saves_rolls_back_both_entries_and_relation(store, monkeypatch):
    old = active(store)
    draft = propose(store, '摄影新方法', replaces=binding(old))
    save = store._save
    def fail(db, entry):
        if entry['id'] == draft['id']:
            raise OSError('isolated interrupted transaction')
        save(db, entry)
    monkeypatch.setattr(store, '_save', fail)
    with pytest.raises(OSError):
        change(store, draft, 'accept')
    assert current(store, old)['status'] == 'active'
    assert current(store, draft)['status'] == 'pending'
    with store.connect() as db:
        assert db.execute('SELECT count(*) FROM replacements').fetchone()[0] == 0


def test_replacement_invalidation_never_auto_restores_and_explicit_restore_is_exclusive(store):
    old = active(store)
    new = active(store, '摄影新版本', replaces=binding(old))
    with pytest.raises(Conflict):
        change(store, current(store, old), 'restore')
    invalid = change(store, new, 'invalidate')
    assert not store.context('one')['entries']
    restored = change(store, current(store, old), 'restore')
    assert restored['status'] == 'active'
    with pytest.raises(Conflict):
        change(store, invalid, 'restore')


def test_deleted_intermediate_bodies_keep_only_topology_and_cannot_duplicate_active_rules(store):
    chain = [active(store)]
    for number in range(3):
        chain.append(active(store, f'摄影版本{number}', replaces=binding(chain[-1])))
    for item in chain[1:3]:
        change(store, current(store, item), 'delete')
    reopened = MemoryStore(store.root)
    with pytest.raises(Conflict):
        change(reopened, current(reopened, chain[0]), 'restore')
    with reopened.connect() as db:
        columns = [row['name'] for row in db.execute('PRAGMA table_info(replacements)')]
        assert columns == ['profile_id', 'old_id', 'new_id', 'old_revision', 'new_revision']
    change(reopened, chain[-1], 'invalidate')
    assert change(reopened, current(reopened, chain[0]), 'restore')['status'] == 'active'
    reopened.purge_profile('one')
    with reopened.connect() as db:
        assert db.execute('SELECT count(*) FROM replacements').fetchone()[0] == 0


def test_http_preview_and_cli_share_conditions(store, monkeypatch, capsys):
    app = FastAPI()
    app.include_router(create_router(lambda: store))
    client = TestClient(app)
    base = '/api/persona/one/memory'
    entry = active(store, conditions={'taskTypes': ['writing']})
    assert client.get(base + '/context').json()['entries'] == []
    assert client.get(base + '/context', params={'taskType': 'writing'}).json()['entries'][0]['id'] == entry['id']
    import easel.commands.memory as command
    import easel.persona as persona
    monkeypatch.setattr(command, 'data_root', lambda: store.root)
    monkeypatch.setattr(persona, 'PROFILES_DIR', store.profiles)
    command.run(SimpleNamespace(action='context', profile='one', query='摄影', platform=None, account=None, task_type='writing'))
    assert json.loads(capsys.readouterr().out)['entries'][0]['id'] == entry['id']
    assert persona.model_memory_context('one', '摄影')['entries'] == []
    assert entry['text'] in persona.model_turn_message('摄影', 'one', task_type='writing')
    assert entry['text'] not in persona.model_turn_message('摄影', 'one')


def test_writing_and_analysis_identity_use_saved_context_for_both_engines(store, monkeypatch):
    import web.app as web
    import easel.persona as persona
    monkeypatch.setattr(web, 'PROFILES_DIR', store.profiles)
    monkeypatch.setattr(persona, 'PROFILES_DIR', store.profiles)
    monkeypatch.setattr(web, 'OUTPUTS_DIR', store.root / 'outputs')
    monkeypatch.setattr(web, '_memory_store', lambda: store)
    writing = active(store, conditions={'taskTypes': ['writing']})
    analysis = active(store, '摄影分析规则', conditions={'taskTypes': ['account-analysis']})
    request = web.ChatRequest(message='摄影', persona='one', sessionId='experience-session', turnId='writing-turn', engine='codex')
    handoff = {'id': 'handoff', 'platform': 'douyin', 'accountId': 'A', 'analysis': {'markdown': '摄影来源'}}
    monkeypatch.setattr(web, '_writing_context', lambda _: handoff)
    message = web._codex_message(request)
    assert writing['text'] in message and analysis['text'] not in message
    assert store.usage('one', request.sessionId)[0]['recall']['taskType'] == 'writing'
    request.turnId = 'standalone-preview-turn'
    assert web._chat_memory_context(request, handoff)['entries'][0]['id'] == writing['id']
    from content_analysis import Store
    source = Store(web.OUTPUTS_DIR / '_analytics' / 'workbench')
    with source.connect() as db:
        db.execute('CREATE TABLE IF NOT EXISTS analysis_conversations(session_id TEXT,data TEXT)')
        db.execute('INSERT INTO analysis_conversations VALUES(?,?)', (request.sessionId, json.dumps({'platform': 'douyin', 'accountId': 'A'})))
    request.turnId = 'analysis-turn'
    context = web._chat_memory_context(request)
    assert context['entries'][0]['id'] == analysis['id']


def test_codex_builds_context_once_after_turn_deduplication(store, monkeypatch):
    from easel.codex_service import CodexService
    import easel.codex_service as module
    service = CodexService(store.root / 'outputs')
    model = {'id': 'codex/isolated', 'model': 'isolated', 'thinkingLevels': [], 'defaultEffort': 'low'}
    monkeypatch.setattr(service, 'runtime', lambda: {'available': True, 'auth': 'local_provider', 'defaultModelRef': model['id'], 'options': [model]})
    captured = []
    class Thread:
        def __init__(self, *, target, args, **kwargs): captured.append(args[1])
        def start(self): pass
    monkeypatch.setattr(module.threading, 'Thread', Thread)
    calls = []
    service.message_builder = lambda req: calls.append(req.message) or 'ISOLATED_SELECTED_EXPERIENCE'
    service.bind('isolated-session', 'codex')
    request = SimpleNamespace(sessionId='isolated-session', turnId='isolated-turn', selectedSkills=[], skillRequirements={}, message='原始请求', attachments=[], modelRef=None, thinkingLevel=None)
    assert service.start(request) == request.turnId
    service.message_builder = lambda _: pytest.fail('existing turn must not bind another context')
    assert service.start(request) == request.turnId
    assert calls == ['原始请求'] and captured == ['ISOLATED_SELECTED_EXPERIENCE']
