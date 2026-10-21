"""Scoped memory and HTTP lifecycle; isolated data, no model/platform calls."""
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from easel.profile_memory import MemoryStore, Conflict, digest


@pytest.fixture
def store(tmp_path):
    for name in ('one', 'two'):
        path = tmp_path / 'profiles' / name
        path.mkdir(parents=True)
        (path / 'memory.md').write_text('旧经验原文，发现日期未知。', encoding='utf-8')
    return MemoryStore(tmp_path)


def managed(store, name='one'):
    state = store.state(name)
    store.import_legacy(name, {'hash': state['legacy']['hash'], 'profileRevision': state['revision'], 'scope': {'kind': 'profile'}})
    return store.state(name)


def propose(store, text='摄影教程采用分步清单，仍需验证。', account=None, name='one', **extra):
    selected = {'kind': 'account', 'platform': 'douyin', 'accountId': account} if account else {'kind': 'profile'}
    return store.propose(name, {'text': text, 'scope': selected, **extra})


def change(store, entry, action, name='one', **extra):
    return store.change(name, entry['id'], action, {'revision': entry['revision'], 'profileRevision': store.state(name)['revision'], 'contentHash': entry['contentHash'], 'scopeHash': entry['scopeHash'], **extra})


def test_migration_is_explicit_preserves_exact_original_and_unknown_date(store):
    state = store.state('one')
    assert not state['managed'] and store.context('one')['entries'] == []
    managed(store)
    assert store.legacy_snapshot('one')['text'] == state['legacy']['text']
    state = store.state('one')
    entry = state['entries'][0]
    assert entry['status'] == 'pending' and entry['quality'] == 'legacy-unverified'
    assert entry['source']['capturedAt'] is None
    assert store.context('one')['entries'] == []
    assert '旧经验原文' not in (store.directory('one') / 'memory.md').read_text(encoding='utf-8')
    store.import_legacy('one', {})  # Idempotent retry.
    assert store.state('one')['revision'] == state['revision']


def test_migration_rejects_file_or_revision_changes(store):
    state = store.state('one')
    (store.directory('one') / 'memory.md').write_text('外部变更', encoding='utf-8')
    with pytest.raises(Conflict):
        store.import_legacy('one', {'hash': state['legacy']['hash'], 'profileRevision': state['revision'], 'scope': {'kind': 'profile'}})
    assert not store.state('one')['managed']


def test_double_profile_account_scope_relevance_and_budget(store):
    managed(store); managed(store, 'two')
    a = change(store, propose(store, account='A'), 'accept')
    b = change(store, propose(store, text='摄影教程从实物演示开始。', account='B'), 'accept')
    change(store, propose(store, name='two'), 'accept', name='two')
    assert [e['id'] for e in store.context('one', '摄影教程', 'douyin', 'A')['entries']] == [a['id']]
    assert [e['id'] for e in store.context('one', '摄影教程', 'douyin', 'B')['entries']] == [b['id']]
    assert store.context('one', '摄影教程', 'zhihu', 'A')['entries'] == []
    assert store.context('one', '完全无关的烹饪任务', 'douyin', 'A')['entries'] == []
    assert store.context('one', '摄影教程', 'douyin', 'A', budget=2)['entries'] == []
    assert store.state('one')['profileId'] != store.state('two')['profileId']
    assert '实物演示' not in (store.directory('one') / 'memory.md').read_text(encoding='utf-8')


@pytest.mark.parametrize('field,value', [('revision', 0), ('profileRevision', -1), ('contentHash', 'forged'), ('scopeHash', 'forged')])
def test_stale_or_tampered_confirmation_rejected(store, field, value):
    managed(store)
    entry = propose(store)
    with pytest.raises(Conflict):
        change(store, entry, 'accept', **{field: value})
    assert store.state('one')['entries'][0]['status'] == 'pending'


def test_idempotent_accept_reject_and_delete_never_resurrect(store):
    managed(store)
    entry = propose(store)
    active = change(store, entry, 'accept')
    assert change(store, entry, 'accept') == active
    assert len(store.history('one', entry['id'])) == 2
    rejected = change(store, propose(store, '这是一条被拒绝的摄影结论。'), 'reject')
    assert propose(store, rejected['text'])['status'] == 'rejected'
    change(store, active, 'delete')
    with pytest.raises(LookupError): store.history('one', active['id'])
    with pytest.raises(Conflict): propose(store)
    assert active['text'] not in (store.directory('one') / 'memory.md').read_text(encoding='utf-8')


def test_edits_preserve_versions_and_invalidation_restore(store):
    managed(store)
    active = change(store, propose(store), 'accept')
    edited = change(store, active, 'edit', text='摄影教程先演示成品。', reviewAfter='2000-01-01')
    assert store.state('one')['entries'][0]['needsReview']
    with pytest.raises(Conflict): change(store, active, 'edit', text='旧任务迟到')
    invalid = change(store, edited, 'invalidate')
    assert not store.context('one')['entries']
    restored = change(store, invalid, 'restore')
    assert restored['status'] == 'active'
    assert store.history('one', active['id'])[-1]['text'] == active['text']


def test_parallel_edits_one_wins_other_conflicts(store):
    managed(store); entry = propose(store)
    base = {'revision': entry['revision'], 'profileRevision': store.state('one')['revision']}
    def edit(text):
        try:
            store.change('one', entry['id'], 'edit', {**base, 'text': text})
            return 'saved'
        except Conflict: return 'conflict'
    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(edit, ['第一个草稿', '第二个草稿'])) == ['conflict', 'saved']


def test_projection_failure_recovers_and_external_change_pauses_context(store, monkeypatch):
    managed(store); change(store, propose(store), 'accept')
    original = Path.replace
    def broken(*args): raise OSError('disk unavailable')
    monkeypatch.setattr(Path, 'replace', broken)
    propose(store, '触发新的投影版本')
    state = store.state('one')
    assert not state['projectionReady'] and store.context('one')['entries'] == []
    monkeypatch.setattr(Path, 'replace', original)
    assert store.state('one')['projectionReady']
    path = store.directory('one') / 'memory.md'
    path.write_text('摄影教程外部修改，仅提案。', encoding='utf-8')
    state = store.state('one')
    assert not state['projectionReady'] and not store.context('one')['entries']
    store.reconcile('one', {'hash': digest(path.read_text(encoding='utf-8')), 'profileRevision': state['revision']})
    assert store.state('one')['projectionReady']
    assert store.state('one')['entries'][0]['status'] == 'pending'


def test_source_change_and_deletion_preserve_record_but_stop_injection(store):
    managed(store)
    current = {'type': 'analysis', 'bindingId': 'binding', 'platform': 'douyin', 'accountId': 'A', 'sourceHash': 'original', 'markdown': '摄影教程采用分步清单，仍需验证。'}
    store.resolve_source = lambda _: dict(current)
    entry = propose(store, account='A', source={'type': 'analysis', 'bindingId': 'binding'})
    with pytest.raises(ValueError): propose(store, account='B', source={'type': 'analysis', 'bindingId': 'binding'})
    active = change(store, entry, 'accept')
    current['sourceHash'] = 'changed'
    assert store.state('one')['entries'][0]['sourceStatus'] == 'changed'
    assert not store.context('one', '', 'douyin', 'A')['entries']
    def deleted(_): raise LookupError('deleted')
    store.resolve_source = deleted
    assert store.state('one')['entries'][0]['sourceStatus'] == 'missing'
    assert store.history('one', active['id'])[0]['status'] == 'active'


def test_turn_uses_pin_ids_versions_and_contain_no_body(store):
    managed(store); active = change(store, propose(store), 'accept')
    context = store.context('one')
    assert store.record_use('one', 's', 't', context)
    change(store, active, 'invalidate')
    assert not store.record_use('one', 's', 't', store.context('one'))
    use = store.usage('one', 's')[0]
    assert use['entries'] == [{'id': active['id'], 'revision': active['revision']}]
    assert active['text'] not in json.dumps(use)
    assert not store.usage('two', 's')


def test_legacy_delete_purges_original_and_history(store):
    state = managed(store); entry = state['entries'][0]
    change(store, entry, 'delete')
    assert store.legacy_snapshot('one') is None
    store.purge_profile('one')
    assert store.state('one')['profileId'] != state['profileId']


def test_path_links_refused(store, tmp_path):
    target = tmp_path / 'outside'; target.mkdir()
    alias = store.profiles / 'alias'
    try: alias.symlink_to(target, target_is_directory=True)
    except OSError: pytest.skip('Host does not grant symlink creation')
    with pytest.raises(LookupError): store.state('alias')


def test_http_writes_require_browser_origin_and_old_put_cannot_bypass(store, monkeypatch):
    import easel.persona as persona
    import web.app as web
    monkeypatch.setattr(web, 'PROFILES_DIR', store.profiles)
    monkeypatch.setattr(persona, 'PROFILES_DIR', store.profiles)
    local = 'http://127.0.0.1:7860'
    client = TestClient(web.app, base_url=local, client=('127.0.0.1', 51234))
    base = '/api/persona/one/memory'
    state = client.get(base).json()
    data = {'hash': state['legacy']['hash'], 'profileRevision': state['revision'], 'scope': {'kind': 'profile'}}
    assert client.post(base+'/import', json=data).status_code == 403
    assert client.post(base+'/import', json=data, headers={'Origin': local}).status_code == 403
    headers = {'Origin': local, 'Sec-Fetch-Site': 'same-origin'}
    assert client.post(base+'/import', json=data, headers=headers).status_code == 200
    assert client.post(base+'/import', json=data, headers={**headers, 'Origin': 'https://foreign.test'}).status_code == 403
    response = client.post(base+'/candidates', json={'text': '摄影测试经验', 'scope': {'kind': 'profile'}, 'status': 'active', 'confirmedAt': 'forged'})
    assert response.status_code == 200 and response.json()['entry']['status'] == 'pending'
    assert client.put('/api/persona/one/file', json={'filename': 'memory.md', 'content': 'bypass'}, headers=headers).status_code == 409
    assert client.post(base+'/candidates', content='[]', headers={'Content-Type': 'application/json'}).status_code == 400


def test_real_analysis_resolver_recomputes_server_hash_and_detects_missing_chat(store, tmp_path, monkeypatch):
    import web.app as web
    from content_analysis import Store
    from analysis_conversations import AnalysisConversations
    outputs = tmp_path / 'outputs'
    monkeypatch.setattr(web, 'OUTPUTS_DIR', outputs)
    ledger = tmp_path / 'ledger'; ledger.mkdir()
    monkeypatch.setattr(web, '_run_ledger_root', lambda: ledger)
    material = Store(outputs / '_analytics/workbench')
    material.ingest({'platform': 'douyin', 'accountId': 'A', 'contents': [{'id': 'work', 'body': '摄影教程的作品正文'}]})
    service = AnalysisConversations(material)
    binding = service.prepare({'platform': 'douyin', 'accountId': 'A', 'sessionId': 's'})
    service.save_result(binding['id'], {'sessionId': 's', 'turnId': 't', 'markdown': '摄影教程采用分步清单，仍需验证；一个样本不证明因果。'})
    marker = ledger / 'web_s.json'; marker.write_text('{}')
    source = web._memory_analysis_source(binding['id'])
    assert source['sampleCount'] == 1 and source['sourceHash'] != 'forged'
    marker.unlink()
    with pytest.raises(LookupError): web._memory_analysis_source(binding['id'])


def test_profile_build_preserves_managed_file_and_model_export_never_splices_legacy(store, monkeypatch):
    import web.app as web
    import easel.persona as persona
    monkeypatch.setattr(web, 'PROFILES_DIR', store.profiles)
    monkeypatch.setattr(persona, 'PROFILES_DIR', store.profiles)
    original = (store.directory('one') / 'memory.md').read_text(encoding='utf-8')
    web._write_baseline_profile('one', {})
    assert (store.directory('one') / 'memory.md').read_text(encoding='utf-8') == original
    assert original not in persona.load_profile_text('one', for_model=True)
    assert original in persona.load_profile_text('one')
