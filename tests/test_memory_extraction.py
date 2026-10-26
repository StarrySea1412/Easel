"""Isolated functional extraction lifecycle. All reports are synthetic; no models."""
import copy
import hashlib
import json
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from analysis_conversations import AnalysisConversations
from content_analysis import Store
from content_analysis_routes import create_router as analysis_router
from web.profile_memory_routes import create_router as memory_router
from easel.memory_extraction import METHOD, normalized, spans
from easel.memory_sources import UnsettledSource, analysis_source
from easel.profile_memory import Conflict, MemoryStore, digest

TEXT = '[作品ID: n1] 摄影教程先展示成品再拆分步骤；仅有一个样本，仍需对照验证。'
SECOND = '[作品ID: n2] 旅行内容先说明行程与交通限制；当前没有同龄指标，不断言效果。'
REPORT = '## 分析\n这是明确标注的隔离合成报告，不表示真实账号结论。\n\n## 经验候选\n- ' + TEXT + '\n- ' + SECOND


@pytest.fixture
def env(tmp_path):
    for name in ('one', 'two'):
        (tmp_path / 'profiles' / name).mkdir(parents=True)
    memory = MemoryStore(tmp_path)
    for name in ('one', 'two'):
        memory.import_legacy(name, {'hash': digest(''), 'profileRevision': 0, 'scope': {'kind': 'profile'}})
    outputs = tmp_path / 'outputs'
    ledger = outputs / '_sessions'
    ledger.mkdir(parents=True)
    material = Store(outputs / '_analytics/workbench')
    material.ingest({'platform': 'douyin', 'accountId': 'A', 'contents': [
        {'id': 'n1', 'body': '隔离合成摄影教程'}, {'id': 'n2', 'body': '隔离合成旅行内容'}]})
    service = AnalysisConversations(material, memory.state)
    binding = service.prepare({'platform': 'douyin', 'accountId': 'A', 'sessionId': 's', 'persona': 'one'})
    result = service.save_result(binding['id'], {'sessionId': 's', 'turnId': 't', 'markdown': REPORT})
    marker = ledger / 'web_s.json'
    marker.write_text(json.dumps({'session_id': 's', 'turn_id': 't', 'status': 'done',
        'clean_end': True, 'text': REPORT}), encoding='utf-8')
    return SimpleNamespace(root=tmp_path, outputs=outputs, ledger=ledger, memory=memory,
        material=material, service=service, binding=result, marker=marker)


def extract(env, **extra):
    return env.memory.extract_analysis('one', {'bindingId': env.binding['id'], **extra})


def change(env, entry, action):
    return env.memory.change('one', entry['id'], action, {**{k: entry[k] for k in
        ('revision', 'contentHash', 'scopeHash', 'conditionsHash')},
        'profileRevision': env.memory.state('one')['revision']})


def replace_report(env, report, turn='t2'):
    env.binding = env.service.save_result(env.binding['id'], {'sessionId': 's', 'turnId': turn, 'markdown': report})
    env.marker.write_text(json.dumps({'session_id': 's', 'turn_id': turn, 'status': 'done',
        'clean_end': True, 'text': report}), encoding='utf-8')


def test_original_offsets_crlf_attribution_and_multiline_are_preserved():
    text = '## 经验候选\r\n- ' + TEXT + '\r\n  只对本次作品做观察。\r\n\r\n## 其他\r\n- ' + SECOND
    selected = spans(text, ['n1', 'n2'])
    assert len(selected) == 1
    item = selected[0]
    assert text[item['start']:item['end']] == TEXT + '\r\n  只对本次作品做观察。'
    assert item['contentIds'] == ['n1']


@pytest.mark.parametrize('text', [TEXT, '## 结论\n- '+TEXT,
    '## 经验候选\n- '+TEXT.replace('n1', 'unknown'),
    '## 经验候选\n- 无作品引用的很长内容，不应当被猜测为有来源的结论。',
    '## 经验候选\n- [作品ID: n1] 短', '## 经验候选\n- [作品ID: n1] '+ '长'*1000,
    '````markdown\n## 经验候选\n- '+TEXT+'\n```\n- '+SECOND+'\n````'])
def test_parser_requires_explicit_attributed_bounded_items(text):
    assert spans(text, ['n1', 'n2']) == []


def test_english_section_and_multiple_ids_with_code_block_are_read_literally():
    text = '## Experience candidates\n```text\n- '+SECOND+'\n```\n1. '+TEXT.replace('n1', 'n1，n2')
    assert spans(text, ['n1', 'n2'])[0]['contentIds'] == ['n1', 'n2']
    assert len(spans(text, ['n1', 'n2'])) == 1
    assert normalized('ＡＢＣ 1.5，不采用。') == normalized('abc1.5，不采用')
    assert normalized('采用2步') != normalized('不采用2步') != normalized('不采用3步')


def test_batch_is_pending_bounded_and_receipt_has_no_report_body(env):
    report = REPORT + '\n- '+TEXT+'\n- '+TEXT.replace('成品', '道具')+'\n- '+TEXT.replace('成品', '分镜')
    replace_report(env, report)
    receipt = extract(env)
    assert (receipt['createdCount'], receipt['duplicateCount'], receipt['overflowCount']) == (3, 1, 1)
    assert receipt['method'] == METHOD and receipt['modelRequests'] == 0
    assert TEXT not in json.dumps(receipt, ensure_ascii=False)
    entries = env.memory.state('one')['entries']
    assert len(entries) == 3 and all(e['status'] == 'pending' for e in entries)
    assert not env.memory.context('one', '摄影', 'douyin', 'A')['entries']
    for entry in entries:
        provenance = entry['source']['extraction']
        assert report[provenance['start']:provenance['end']] == entry['text']
        assert provenance['textHash'] == digest(entry['text'])
        assert entry['scope'] == {'kind': 'account', 'platform': 'douyin', 'accountId': 'A'}
    assert env.memory.state('two')['entries'] == []


def test_parallel_retries_share_one_transaction_and_restart_receipt(env):
    with ThreadPoolExecutor(3) as pool:
        receipts = list(pool.map(lambda _: extract(env), range(3)))
    assert receipts[0] == receipts[1] == receipts[2]
    assert len(env.memory.state('one')['entries']) == 2
    assert MemoryStore(env.root).extract_analysis('one', {'bindingId': env.binding['id']}) == receipts[0]


def test_failed_batch_rolls_back_entries_receipt_and_revision(env, monkeypatch):
    original, calls = env.memory._insert, []
    def insert(*args, **kwargs):
        calls.append(1)
        if len(calls) == 2:
            raise OSError('isolated simulated storage failure')
        return original(*args, **kwargs)
    before = env.memory.state('one')['revision']
    monkeypatch.setattr(env.memory, '_insert', insert)
    with pytest.raises(OSError): extract(env)
    assert not env.memory.state('one')['entries']
    assert env.memory.state('one')['revision'] == before
    with env.memory.connect() as db:
        assert db.execute('SELECT count(*) FROM extractions').fetchone()[0] == 0
    monkeypatch.setattr(env.memory, '_insert', original)
    assert extract(env)['createdCount'] == 2


def test_rejected_and_deleted_candidates_do_not_return_on_retry(env):
    receipt = extract(env)
    first, second = env.memory.state('one')['entries']
    change(env, first, 'reject')
    change(env, second, 'delete')
    assert extract(env) == receipt
    entries = env.memory.state('one')['entries']
    assert len(entries) == 1 and entries[0]['status'] == 'rejected'
    env.memory.purge_profile('one')
    with env.memory.connect() as db:
        assert not db.execute('SELECT * FROM extractions').fetchall()
    with pytest.raises(Conflict, match='删除或重建'): extract(env)


def test_candidate_policy_and_original_profile_are_independent_of_read_policy(env):
    store = env.memory
    store.set_policy('one', {'profileRevision': store.state('one')['revision'], 'readEnabled': False})
    assert extract(env)['createdCount'] == 2
    with pytest.raises(Conflict, match='绑定的画像'):
        store.extract_analysis('two', {'bindingId': env.binding['id']})
    store.set_policy('one', {'profileRevision': store.state('one')['revision'], 'candidatesEnabled': False})
    with pytest.raises(Conflict, match='关闭保存候选'): extract(env)
    assert len(store.state('one')['entries']) == 2


def test_unmanaged_profile_and_unbound_legacy_report_remain_manual(env):
    with env.memory.connect() as db:
        db.execute('UPDATE profiles SET managed=0 WHERE name="one"')
    with pytest.raises(Conflict, match='托管'): extract(env)
    current = copy.deepcopy(env.binding)
    current.pop('persona')
    with env.material.connect() as db:
        db.execute('UPDATE analysis_conversations SET data=? WHERE id=?', (json.dumps(current), current['id']))
    with pytest.raises(Conflict, match='绑定的画像'): extract(env)


def test_expected_version_and_second_source_check_prevent_stale_candidates(env, monkeypatch):
    with pytest.raises(Conflict, match='版本'): extract(env, sourceHash='old-version')
    with pytest.raises(Conflict, match='轮次'): extract(env, turnId='older-turn')
    original = env.memory.resolve_extraction_source
    calls = []
    def changed(binding):
        value = original(binding)
        calls.append(1)
        if len(calls) == 2:
            value['capturedAt'] = 'later'
        return value
    monkeypatch.setattr(env.memory, 'resolve_extraction_source', changed)
    with pytest.raises(Conflict, match='来源已变化'): extract(env)
    assert not env.memory.state('one')['entries']


def test_changed_version_creates_only_pending_and_advises_without_merging(env):
    extract(env)
    before = {e['id']: e for e in env.memory.state('one')['entries']}
    replace_report(env, REPORT.replace('## 分析', '## 分析更新'))
    result = extract(env)
    assert result['createdCount'] == 2
    entries = env.memory.state('one')['entries']
    fresh = [e for e in entries if e['id'] not in before]
    assert len(entries) == 4
    assert all(e['status'] == 'pending' and not e.get('replaces') for e in fresh)
    assert all(e['relatedCandidates'][0]['kind'] == 'normalized-text' for e in fresh)
    assert all(e['relatedCandidates'][0]['id'] in before for e in fresh)
    assert all(env.memory.history('one', e['id'])[0]['revision'] == 1 for e in fresh)


@pytest.mark.parametrize('patch', [{'status': 'running'}, {'clean_end': False}, {'stopped': True},
    {'stop_reason': 'user_stopped'}, {'text': REPORT+'new content'}])
def test_only_exact_normally_completed_turns_are_extractable(env, patch):
    snapshot = json.loads(env.marker.read_text(encoding='utf-8'))
    env.marker.write_text(json.dumps({**snapshot, **patch}), encoding='utf-8')
    with pytest.raises(UnsettledSource): extract(env)
    assert not env.memory.state('one')['entries']


def test_archive_of_old_turn_is_used_without_replacing_latest_turn(env):
    archive = env.ledger / 'jobs/t.snapshot.json'
    archive.parent.mkdir()
    archive.write_bytes(env.marker.read_bytes())
    latest = {'session_id': 's', 'turn_id': 'newer', 'status': 'running', 'text': '后续轮次'}
    env.marker.write_text(json.dumps(latest), encoding='utf-8')
    assert extract(env)['createdCount'] == 2
    assert json.loads(env.marker.read_text(encoding='utf-8')) == latest


def test_sqlite_run_lifecycle_takes_precedence_over_done_marker(env):
    with sqlite3.connect(env.ledger / 'ledger.sqlite3') as db:
        db.execute('CREATE TABLE runs(turn TEXT PRIMARY KEY,data TEXT)')
        db.execute('INSERT INTO runs VALUES(?,?)', ('t', json.dumps({'sessionId': 's', 'status': 'running'})))
    with pytest.raises(UnsettledSource): extract(env)
    with sqlite3.connect(env.ledger / 'ledger.sqlite3') as db:
        db.execute('UPDATE runs SET data=?', (json.dumps({'sessionId': 's', 'status': 'completed', 'settled': True}),))
    assert extract(env)['createdCount'] == 2


def test_codex_exact_turn_and_missing_deleted_sources(env):
    folder = env.outputs / '_codex' / hashlib.sha256(b's').hexdigest()
    (folder / 'turns').mkdir(parents=True)
    (folder / 'session.json').write_text('{"engine":"codex"}', encoding='utf-8')
    env.marker.unlink()
    with pytest.raises(UnsettledSource): extract(env)
    turn = folder / 'turns' / (hashlib.sha256(b't').hexdigest()+'.json')
    turn.write_text(json.dumps({'sessionId': 's', 'turn_id': 't', 'status': 'done',
        'outcome': 'completed', 'text': REPORT}), encoding='utf-8')
    assert extract(env)['createdCount'] == 2
    from easel.task_store import TaskStore
    TaskStore(env.outputs).delete_session('s')
    with pytest.raises(LookupError, match='删除'): extract(env)


def test_writeback_timestamp_is_idempotent_and_late_receipt_does_not_annotate_new_report(env):
    original = env.binding['result']
    receipt = extract(env)
    env.service.record_extraction(env.binding['id'], original, receipt)
    repeat = env.service.save_result(env.binding['id'], {'sessionId': 's', 'turnId': 't', 'markdown': REPORT})
    assert repeat['result'] == original and repeat['experienceExtraction'] == receipt
    replace_report(env, REPORT+'\n\n补充局限。')
    assert 'experienceExtraction' not in env.service.record_extraction(env.binding['id'], original, receipt)
    assert 'experienceExtraction' not in env.service.record_extraction(env.binding['id'], None, receipt)


def test_http_cli_and_automatic_writeback_share_one_service(env, monkeypatch, capsys):
    import web.app as app_module
    import easel.commands.memory as command
    monkeypatch.setattr(app_module, '_memory_store', lambda: env.memory)
    automatic = app_module._extract_analysis_experience
    app = FastAPI()
    app.include_router(analysis_router(lambda: env.material.path.parent, lambda: pytest.fail('no platform'),
        experience_extractor=automatic, profile_resolver=env.memory.state))
    app.include_router(memory_router(lambda: env.memory,
        lambda receipt: env.service.record_extraction(receipt['bindingId'], None, receipt)))
    client = TestClient(app)
    path = '/api/content-analysis/conversations/'+env.binding['id']+'/result'
    response = client.post(path, json={'sessionId': 's', 'turnId': 't', 'markdown': REPORT})
    assert response.status_code == 200
    receipt = response.json()['experienceExtraction']
    manual = client.post('/api/persona/one/memory/extract-analysis', json={
        'bindingId': env.binding['id'], 'sourceHash': receipt['sourceHash']})
    assert manual.status_code == 200 and manual.json()['extraction'] == receipt
    assert env.service.list('douyin', 'A')[0]['experienceExtraction'] == receipt
    monkeypatch.setattr(command, 'MemoryStore', lambda _: env.memory)
    command.run(SimpleNamespace(action='extract-analysis', profile='one', binding=env.binding['id']))
    assert json.loads(capsys.readouterr().out) == receipt
    assert len(env.memory.state('one')['entries']) == 2


def test_automatic_deferred_or_skipped_preserves_saved_report(env, monkeypatch):
    import web.app as app_module
    monkeypatch.setattr(app_module, '_memory_store', lambda: env.memory)
    env.marker.unlink()
    receipt = app_module._extract_analysis_experience(env.binding)
    assert receipt['status'] == 'deferred' and receipt['modelRequests'] == 0
    env.service.record_extraction(env.binding['id'], env.binding['result'], receipt)
    assert env.service.list('douyin', 'A')[0]['result'] == env.binding['result']
    assert app_module._extract_analysis_experience({})['reason'] == 'no-profile'


def test_missing_explicit_section_records_empty_result_without_copying_report(env):
    replace_report(env, '## 分析结论\n'+TEXT+'\n只有普通段落，不自动提炼或复制整份报告。')
    receipt = extract(env)
    assert receipt['reason'] == 'no-explicit-candidates'
    assert receipt['entryIds'] == [] and env.memory.state('one')['entries'] == []


def test_manual_original_candidates_are_reused_and_deletion_before_extraction_is_respected(env):
    for text in (TEXT, SECOND):
        entry = env.memory.propose('one', {'text': text, 'scope': {'kind': 'account',
            'platform': 'douyin', 'accountId': 'A'}, 'source': {'type': 'analysis', 'bindingId': env.binding['id']}})
        change(env, entry, 'delete')
    receipt = extract(env)
    assert receipt['deletedCount'] == 2 and receipt['reason'] == 'previously-deleted'
    assert env.memory.state('one')['entries'] == []


def test_conditions_have_independent_receipts_and_no_advisory_across_conditions(env):
    first = extract(env, conditions={'taskTypes': ['writing']})
    second = extract(env, conditions={'taskTypes': ['coding']})
    assert first['id'] != second['id'] and second['createdCount'] == 2
    assert all(not row.get('relatedCandidates') for row in env.memory.state('one')['entries'])
    assert extract(env, conditions={'taskTypes': ['writing']}) == first


def test_lexical_overlap_never_accepts_or_replaces_changed_quantities(env):
    extract(env)
    replace_report(env, REPORT.replace('仅有一个样本', '仅有两个样本'))
    receipt = extract(env)
    assert receipt['createdCount'] == 2
    rows = env.memory.state('one')['entries']
    changed = next(row for row in rows if '两个样本' in row['text'])
    assert changed['relatedCandidates'][0]['kind'] == 'lexical-overlap'
    assert len(rows) == 4 and all(row['status'] == 'pending' and not row.get('replaces') for row in rows)


def test_material_updates_keep_saved_report_but_do_not_extract(env):
    env.material.ingest({'platform': 'douyin', 'accountId': 'A', 'contents': [{'id': 'n1', 'body': '隔离合成：材料更新'}]})
    with pytest.raises(ValueError, match='材料已改变'): extract(env)
    assert env.service.list('douyin', 'A')[0]['result'] == env.binding['result']
    assert not env.memory.state('one')['entries']


def test_existing_manual_source_keeps_its_revision_and_receipt_adds_exact_location(env):
    entry = env.memory.propose('one', {'text': TEXT, 'scope': {'kind': 'account', 'platform': 'douyin',
        'accountId': 'A'}, 'source': {'type': 'analysis', 'bindingId': env.binding['id']}})
    receipt = extract(env)
    assert (receipt['createdCount'], receipt['existingCount']) == (1, 1)
    assert env.memory.history('one', entry['id'])[0] == entry
    location = next(row for row in receipt['selections'] if row['entryId'] == entry['id'])
    assert location['reused'] and REPORT[location['start']:location['end']] == TEXT
    assert location['textHash'] == entry['contentHash']
