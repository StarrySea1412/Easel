"""Ordinary isolated experience policy/recall lifecycle; no model calls."""
import json
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from easel.profile_memory import Conflict, MemoryStore, digest
from web.profile_memory_routes import create_router


@pytest.fixture
def store(tmp_path):
    for name in ('one', 'two'):
        (tmp_path / 'profiles' / name).mkdir(parents=True)
    value = MemoryStore(tmp_path)
    for name in ('one', 'two'):
        value.import_legacy(name, {'hash': digest(''), 'profileRevision': 0, 'scope': {'kind': 'profile'}})
    return value


def policy(store, name='one', **patch):
    return store.set_policy(name, {'profileRevision': store.state(name)['revision'], **patch})


def active(store, text='摄影教程先展示成品', selected=None, source=None):
    entry = store.propose('one', {'text': text, 'scope': selected or {'kind': 'profile'}, 'source': source or {'type': 'manual'}})
    return store.change('one', entry['id'], 'accept', {'revision': entry['revision'], 'profileRevision': store.state('one')['revision'],
                        'contentHash': entry['contentHash'], 'scopeHash': entry['scopeHash']})


def test_independent_controls_persist_without_removing_entries_or_drafts(store):
    entry = active(store)
    policy(store, readEnabled=False)
    assert store.context('one')['recall']['reason'] == 'read-disabled'
    candidate = store.propose('one', {'text': '新增候选', 'scope': {'kind': 'profile'}})
    assert candidate['status'] == 'pending'
    policy(store, readEnabled=True, candidatesEnabled=False)
    assert store.context('one')['entries'][0]['id'] == entry['id']
    with pytest.raises(Conflict, match='关闭保存候选'):
        store.propose('one', {'text': '暂停时的候选', 'scope': {'kind': 'profile'}})
    assert MemoryStore(store.root).state('one')['policy'] == {'readEnabled': True, 'candidatesEnabled': False}
    assert store.state('two')['policy'] == {'readEnabled': True, 'candidatesEnabled': True}
    assert store.history('one', candidate['id'])[0]['text'] == '新增候选'
    policy(store, candidatesEnabled=True)
    assert len(store.state('one')['entries']) == 2


def test_legacy_database_gets_default_controls_and_purge_resets_profile(store):
    with store.connect() as db:
        db.execute('DROP TABLE policies')
    reopened = MemoryStore(store.root)
    assert reopened.state('one')['policy'] == {'readEnabled': True, 'candidatesEnabled': True}
    policy(reopened, readEnabled=False, candidatesEnabled=False)
    old_id = reopened.state('one')['profileId']
    reopened.purge_profile('one')
    state = reopened.state('one')
    assert state['profileId'] != old_id
    assert state['policy'] == {'readEnabled': True, 'candidatesEnabled': True}


def test_parallel_setting_changes_conflict_and_noop_keeps_revision(store):
    revision = store.state('one')['revision']
    policy(store, readEnabled=True)
    assert store.state('one')['revision'] == revision
    def change(key):
        try:
            store.set_policy('one', {'profileRevision': revision, key: False})
            return 'saved'
        except Conflict:
            return 'conflict'
    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(change, ('readEnabled', 'candidatesEnabled'))) == ['conflict', 'saved']
    assert store.state('one')['revision'] == revision + 1


def test_budget_continues_after_first_eight_oversized_matches(store):
    for index in range(8):
        active(store, f'摄影教程分步操作和灯光布置{index}' + '长' * 60)
    compact = active(store, '摄影短结论')
    context = store.context('one', '摄影教程分步操作和灯光布置', budget=10)
    assert [row['id'] for row in context['entries']] == [compact['id']]
    receipt = context['recall']
    assert {key: receipt[key] for key in ('version', 'budgetChars', 'usedChars', 'maxEntries',
            'matchedCount', 'selectedCount', 'skippedBudgetCount', 'reason')} == {
            'version': 2, 'budgetChars': 10, 'usedChars': 5, 'maxEntries': 8,
            'matchedCount': 9, 'selectedCount': 1, 'skippedBudgetCount': 8, 'reason': 'selected'}
    assert receipt['skippedCharBudgetCount'] == 8 and receipt['usedTokens'] > 5
    assert store.context('one', '摄影', budget=-1)['recall']['reason'] == 'budget-exhausted'
    assert store.context('one', '旅游')['recall']['reason'] == 'no-match'


def test_recall_limits_and_account_source_lifecycle_remain_in_force(store):
    for index in range(10):
        active(store, f'摄影参考{index}')
    result = store.context('one', '摄影', budget=99999)
    assert len(result['entries']) == 8 and result['recall']['budgetChars'] == 12000
    assert result['recall']['usedChars'] == sum(len(row['text']) for row in result['entries'])
    assert store.context('two')['recall']['reason'] == 'empty'
    current = {'type': 'analysis', 'bindingId': 'binding', 'platform': 'douyin', 'accountId': 'A',
               'sourceHash': 'v1', 'markdown': '灯光配置结论'}
    store.resolve_source = lambda _: dict(current)
    entry = active(store, current['markdown'], {'kind': 'account', 'platform': 'douyin', 'accountId': 'A'}, {'type': 'analysis', 'bindingId': 'binding'})
    assert store.context('one', '灯光', 'douyin', 'B')['entries'] == []
    assert store.context('one', '灯光', 'douyin', 'A')['entries'][0]['id'] == entry['id']
    current['sourceHash'] = 'v2'
    assert store.context('one', '灯光', 'douyin', 'A')['entries'] == []


def test_receipts_pin_policy_and_budget_while_legacy_usage_stays_readable(store):
    entry = active(store)
    result = store.context('one')
    assert store.record_use('one', 'session', 'turn', result)
    assert store.record_use('one', 'session', 'turn', result)
    assert not store.record_use('one', 'session', 'turn', store.context('one', budget=4000))
    usage = store.usage('one', 'session')[0]
    assert usage['recall']['selectedCount'] == 1 and entry['text'] not in json.dumps(usage, ensure_ascii=False)
    policy(store, readEnabled=False)
    assert not store.record_use('one', 'session', 'late', result)
    assert store.record_use('one', 'session', 'disabled', store.context('one'))
    with store.connect() as db:
        db.execute('INSERT INTO uses VALUES(?,?,?,?)', (usage['profileId'], 'legacy-session', 'old', json.dumps({'entries': usage['entries']})))
    policy(store, readEnabled=True)
    assert store.record_use('one', 'legacy-session', 'old', store.context('one'))
    assert 'recall' not in store.usage('one', 'legacy-session')[0]


def test_http_policy_preview_and_candidate_resume(store):
    app = FastAPI()
    app.include_router(create_router(lambda: store))
    client = TestClient(app, base_url='http://local.test')
    headers = {'Origin': 'http://local.test', 'Sec-Fetch-Site': 'same-origin'}
    base = '/api/persona/one/memory'
    entry = active(store)
    state = client.get(base).json()
    changed = client.post(base + '/policy', json={'profileRevision': state['revision'], 'readEnabled': False, 'candidatesEnabled': False}, headers=headers)
    assert changed.status_code == 200
    assert not changed.json()['policy']['readEnabled']
    assert client.get(base + '/context').json()['recall']['reason'] == 'read-disabled'
    assert client.post(base + '/candidates', json={'text': '新经验', 'scope': {'kind': 'profile'}}).status_code == 409
    changed = client.post(base + '/policy', json={'profileRevision': changed.json()['revision'], 'readEnabled': True, 'candidatesEnabled': True}, headers=headers)
    assert changed.status_code == 200
    assert client.get(base + '/context').json()['entries'][0]['id'] == entry['id']


def test_shared_cli_and_persona_context_follow_policy(store, monkeypatch, capsys):
    import easel.persona as persona
    import easel.commands.memory as command
    monkeypatch.setattr(persona, 'PROFILES_DIR', store.profiles)
    monkeypatch.setattr(command, 'data_root', lambda: store.root)
    entry = active(store)
    args = SimpleNamespace(action='context', profile='one', query='摄影', platform=None, account=None)
    command.run(args)
    assert json.loads(capsys.readouterr().out)['entries'][0]['id'] == entry['id']
    policy(store, readEnabled=False, candidatesEnabled=False)
    assert persona.model_memory_context('one', '摄影')['entries'] == []
    assert '已关闭读取经验' in persona.persona_prefix('one')
    assert entry['text'] not in persona.load_profile_text('one', for_model=True, query='摄影')
    args.action, args.text = 'propose', '摄影新候选'
    with pytest.raises(Conflict):
        command.run(args)


def test_web_chat_context_records_scoped_receipt_without_dispatch(store, monkeypatch):
    import web.app as web
    import easel.persona as persona
    monkeypatch.setattr(web, 'PROFILES_DIR', store.profiles)
    monkeypatch.setattr(persona, 'PROFILES_DIR', store.profiles)
    monkeypatch.setattr(web, 'OUTPUTS_DIR', store.root / 'outputs')
    monkeypatch.setattr(web, '_memory_store', lambda: store)
    entry = active(store)
    request = SimpleNamespace(persona='one', message='摄影教程', sessionId='chat-session', turnId='chat-turn')
    context = web._chat_memory_context(request)
    assert [row['id'] for row in context['entries']] == [entry['id']]
    assert store.usage('one', 'chat-session')[0]['recall']['selectedCount'] == 1
    policy(store, readEnabled=False)
    request.turnId = 'next-turn'
    context = web._chat_memory_context(request)
    assert context['entries'] == [] and context['recall']['reason'] == 'read-disabled'
    assert store.usage('one', 'chat-session')[0]['recall']['reason'] == 'read-disabled'
