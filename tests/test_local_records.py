"""Record-store regressions use temporary data and isolated API definitions.

Do not import the full Web application: reviewing local persistence must not
load the user's environment, credentials, workbench data, or gateway state.
"""
import ast
import asyncio
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
import uuid

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from easel import local_records as store


@pytest.fixture
def api(tmp_path):
    names = {'ScheduleItem', 'IdeaItem', '_read_schedule', '_write_schedule', '_read_ideas', '_write_ideas',
             'api_schedule_list', 'api_schedule_create', 'api_schedule_update', 'api_schedule_delete',
             'api_ideas_list', 'api_ideas_create', 'api_ideas_update', 'api_ideas_delete',
             '_record_published_schedule', '_run_publish_bg', 'api_schedule_context'}
    source = ast.parse((ROOT / 'web/app.py').read_text(encoding='utf-8'))
    nodes = [node for node in source.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name in names]
    assert {node.name for node in nodes} == names
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), *nodes], type_ignores=[])
    ast.fix_missing_locations(module)
    app = FastAPI()
    namespace = {'app': app, 'HTTPException': HTTPException, 'BaseModel': BaseModel, 'local_records': store,
                 'uuid': uuid, 'time': time, 'IDEAS_FILE': tmp_path / '_ideas.json',
                 'SCHEDULE_FILE': tmp_path / '_schedule.json', 'OUTPUTS_DIR': tmp_path,
                 'IDEA_STATUSES': {'pending', 'doing', 'done'}, 'SCHEDULE_KINDS': {'content', 'event'},
                 'SCHEDULE_STATUSES': {'idea', 'draft', 'scheduled', 'published'}}
    exec(compile(module, str(ROOT / 'web/app.py'), 'exec'), namespace)
    with TestClient(app) as client:
        yield client, namespace


@pytest.mark.parametrize('kind', ['ideas', 'schedule'])
@pytest.mark.parametrize('raw', [b'{broken-private-data', b'{}', b'null', b'[1]', b'[{"value":NaN}]', b'\xff'])
def test_bad_store_is_visible_and_every_mutation_preserves_original(api, kind, raw):
    client, namespace = api
    path = namespace[kind.upper() + '_FILE']
    path.write_bytes(raw)
    body = {'title': 'new', 'date': '2030-01-01'}
    for method, url, payload in [('get', f'/api/{kind}', None), ('post', f'/api/{kind}', body),
                                 ('put', f'/api/{kind}/old', body), ('delete', f'/api/{kind}/old', None)]:
        response = client.request(method, url, **({'json': payload} if payload is not None else {}))
        assert response.status_code == 503
        assert '原文件已保留' in response.json()['detail']
        assert 'private-data' not in response.text
        assert path.read_bytes() == raw


@pytest.mark.parametrize('kind', ['ideas', 'schedule'])
def test_missing_file_can_initialize_update_and_delete_without_losing_other_records(api, kind):
    client, namespace = api
    assert client.get(f'/api/{kind}').json() == []
    first = client.post(f'/api/{kind}', json={'title': 'first', 'date': '2030-01-01'})
    second = client.post(f'/api/{kind}', json={'title': 'second', 'date': '2030-01-02'})
    assert first.status_code == second.status_code == 200
    ident = first.json()['id']
    updated = client.put(f'/api/{kind}/{ident}', json={'title': 'updated', 'date': '2030-01-03'})
    assert updated.status_code == 200 and updated.json()['title'] == 'updated'
    assert client.delete(f'/api/{kind}/{ident}').status_code == 200
    assert client.get(f'/api/{kind}').json() == [second.json()]


@pytest.mark.parametrize('kind', ['ideas', 'schedule'])
def test_read_permission_failure_is_not_an_empty_collection(api, monkeypatch, kind):
    client, namespace = api
    path = namespace[kind.upper() + '_FILE']
    original = Path.read_bytes
    def denied(candidate):
        if candidate == path:
            raise PermissionError('PRIVATE_FILESYSTEM_DETAIL')
        return original(candidate)
    monkeypatch.setattr(Path, 'read_bytes', denied)
    response = client.post(f'/api/{kind}', json={'title': 'new', 'date': '2030-01-01'})
    assert response.status_code == 503 and '读取失败' in response.json()['detail']
    assert 'PRIVATE_FILESYSTEM_DETAIL' not in response.text and not path.exists()


@pytest.mark.parametrize('kind', ['ideas', 'schedule'])
def test_failed_atomic_replace_preserves_existing_file_and_reports_failure(api, monkeypatch, kind):
    client, namespace = api
    path = namespace[kind.upper() + '_FILE']
    raw = b'[{"id":"old","title":"keep"}]'
    path.write_bytes(raw)
    def fail(*args):
        raise PermissionError('PRIVATE_REPLACE_ERROR')
    monkeypatch.setattr(store.os, 'replace', fail)
    response = client.post(f'/api/{kind}', json={'title': 'new', 'date': '2030-01-01'})
    assert response.status_code == 503 and '保存失败' in response.json()['detail']
    assert 'PRIVATE_REPLACE_ERROR' not in response.text
    assert path.read_bytes() == raw and not list(path.parent.glob('*.tmp'))


def test_stale_snapshot_conflicts_instead_of_overwriting_another_write(tmp_path):
    path = tmp_path / 'records.json'
    old, newer = store.read(path), store.read(path)
    newer.append({'id': 'winner'})
    store.write(path, newer)
    old.append({'id': 'stale'})
    with pytest.raises(store.RecordConflict):
        store.write(path, old)
    assert store.read(path) == [{'id': 'winner'}]


@pytest.mark.parametrize('kind', ['ideas', 'schedule'])
def test_api_reports_conflict_when_another_writer_commits_before_it(api, monkeypatch, kind):
    client, namespace = api
    original = store.write
    def write_competing_first(path, records, label):
        competing = store.read(path)
        competing.append({'id': 'other-writer'})
        original(path, competing)
        original(path, records, label)
    monkeypatch.setattr(store, 'write', write_competing_first)
    response = client.post(f'/api/{kind}', json={'title': 'new', 'date': '2030-01-01'})
    assert response.status_code == 409 and '请刷新后重试' in response.json()['detail']
    assert store.read(namespace[kind.upper() + '_FILE']) == [{'id': 'other-writer'}]


def test_successful_publish_reports_calendar_failure_without_overwriting_corruption(api):
    _, namespace = api
    path = namespace['SCHEDULE_FILE']
    path.write_bytes(b'BROKEN_PRIVATE_DATA')
    notices = []
    namespace.update(PROJECT_ROOT=ROOT,
                     subprocess=SimpleNamespace(run=lambda *a, **k: SimpleNamespace(returncode=0, stdout='', stderr=''),
                                                TimeoutExpired=subprocess.TimeoutExpired),
                     _publish_env=lambda: {}, _notify_email_completion=None,
                     _read_publish_status=lambda _: {'state': 'success', 'message': 'published'},
                     _write_publish_status=lambda *args: notices.append(args))
    namespace['_run_publish_bg']('synthetic', ['synthetic-no-execution'], 'title', 'body', {'name': 'test'},
                                 path.parent / 'status.json', path.parent / 'code.txt')
    assert len(notices) == 1 and notices[0][1] == 'success'
    assert '排期记录未保存' in notices[0][2] and 'BROKEN_PRIVATE_DATA' not in notices[0][2]
    assert path.read_bytes() == b'BROKEN_PRIVATE_DATA'


def test_calendar_context_error_is_not_reported_as_an_empty_summary(api):
    client, namespace = api
    namespace.update(subprocess=SimpleNamespace(run=lambda *a, **k: SimpleNamespace(returncode=1, stdout=''),
                                                SubprocessError=subprocess.SubprocessError),
                     sys=sys, SHARED_SCRIPTS=ROOT / 'skills/shared/scripts', PROJECT_ROOT=ROOT, _proxy_env=lambda: {})
    response = client.get('/api/schedule/context')
    assert response.status_code == 503 and '排期摘要读取失败' in response.json()['detail']


def test_record_corrupted_after_read_is_preserved_on_commit(tmp_path):
    path = tmp_path / 'records.json'
    records = store.read(path)
    records.append({'id': 'new'})
    path.write_bytes(b'CORRUPT_ORIGINAL')
    with pytest.raises(store.RecordError, match='原文件已保留'):
        store.write(path, records)
    assert path.read_bytes() == b'CORRUPT_ORIGINAL'


def test_unversioned_or_wrong_file_snapshot_is_never_committed(tmp_path):
    path = tmp_path / 'records.json'
    with pytest.raises(store.RecordConflict):
        store.write(path, [{'id': 'unversioned'}])
    with pytest.raises(store.RecordConflict):
        store.write(path, store.read(tmp_path / 'other.json'))
    assert not path.exists()


def test_simultaneous_threads_cannot_both_commit_from_one_revision(tmp_path):
    path = tmp_path / 'records.json'
    ready = threading.Barrier(2)
    def worker(ident):
        records = store.read(path)
        records.append({'id': ident})
        ready.wait(timeout=5)
        try:
            store.write(path, records)
            return ident
        except store.RecordConflict:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(worker, ['one', 'two']))
    winners = [ident for ident in outcomes if ident]
    assert len(winners) == 1 and store.read(path) == [{'id': winners[0]}]


def test_another_process_lock_prevents_overlapping_commit(tmp_path):
    path = tmp_path / 'records.json'
    command = "from pathlib import Path; import sys; from easel.local_records import _write_lock;\nwith _write_lock(Path(sys.argv[1]), 'test'):\n print('locked', flush=True)\n sys.stdin.readline()"
    process = subprocess.Popen([sys.executable, '-c', command, str(path)], cwd=ROOT,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        assert process.stdout.readline().strip() == 'locked'
        records = store.read(path)
        records.append({'id': 'after-lock'})
        with pytest.raises(store.RecordConflict):
            store.write(path, records)
        assert not path.exists()
        process.communicate('\n', timeout=5)
        assert process.returncode == 0
        store.write(path, records)
        assert store.read(path) == [{'id': 'after-lock'}]
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)


def test_calendar_cli_uses_same_revision_and_refuses_corrupt_records(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv('EASEL_ROOT', str(ROOT))
    monkeypatch.setenv('EASEL_DATA_DIR', str(tmp_path))
    monkeypatch.delenv('EASEL_CALENDAR_AUTORECORD', raising=False)
    spec = importlib.util.spec_from_file_location('records_test_calendar', ROOT / 'skills/shared/scripts/calendar_ops.py')
    calendar = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(calendar)
    path = tmp_path / 'records.json'
    cli_records, web_records = calendar.load(path), store.read(path)
    web_records.append({'id': 'web'})
    store.write(path, web_records)
    cli_records.append({'id': 'cli'})
    with pytest.raises(store.RecordConflict):
        calendar.atomic_write(path, cli_records)
    path.write_bytes(b'BROKEN_PRIVATE_DATA')
    with pytest.raises(SystemExit, match='原文件已保留'):
        calendar.main(['--data', str(path), 'add-event', '--title', 'new', '--date', '2030-01-01'])
    with pytest.raises(SystemExit) as failure:
        calendar.main(['--data', str(path), 'record-publish', '--platform', 'test', '--title', 'new', '--no-log'])
    assert failure.value.code == 1
    output = capsys.readouterr()
    assert '原文件已保留' in output.err and 'BROKEN_PRIVATE_DATA' not in output.err
    assert path.read_bytes() == b'BROKEN_PRIVATE_DATA'
