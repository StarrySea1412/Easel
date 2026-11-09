import asyncio
import hashlib
import json

import httpx
import pytest
from fastapi.testclient import TestClient

import web.app as web
from easel import qizhi_delivery as delivery
from easel.artifacts import ArtifactStore
from easel.harnesses import store
from easel.harnesses.base import HarnessError

ENV = {'CLOUDCLI_API_KEY': 'ck_test_secret'}
PROJECT = '/home/cloudcli/projects/qizhi-agent'


def transport(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: original(transport=httpx.MockTransport(handler), **kw))


def test_declared_remote_file_is_downloaded_hashed_registered_and_idempotent(tmp_path, monkeypatch):
    calls = []
    body = b'real original bytes\n'
    def handle(request):
        calls.append(request)
        assert request.method == 'GET'
        assert request.url.path == '/api/qizhi-agent/artifacts/file'
        assert request.url.params['path'] == 'outputs/task/result.md'
        return httpx.Response(200, content=body)
    transport(monkeypatch, handle)
    text = f'[Result]({PROJECT}/outputs/task/result.md)'
    result = asyncio.run(delivery.sync(tmp_path, 's1', 't1', text, ENV))
    row = result['links'][0]
    assert row['status'] == 'ready'
    assert (tmp_path / row['localPath']).read_bytes() == body
    assert row['sha256'] == hashlib.sha256(body).hexdigest()
    assert ArtifactStore(tmp_path).snapshot('s1')['artifacts'][0]['turnId'] == 't1'
    assert delivery.status(tmp_path, 's1', 't1', text, ENV)['links'][0]['status'] == 'ready'
    asyncio.run(delivery.sync(tmp_path, 's1', 't1', text, ENV))
    assert len(calls) == 1
    assert 'ck_test_secret' not in json.dumps(result)
    (tmp_path / row['localPath']).write_text('user modified')
    assert delivery.status(tmp_path, 's1', 't1', text, ENV)['links'][0]['status'] == 'pending'
    recovered = asyncio.run(delivery.sync(tmp_path, 's1', 't1', text, ENV))
    assert recovered['links'][0]['localPath'] != row['localPath']
    assert (tmp_path / row['localPath']).read_text() == 'user modified'


def test_outside_output_paths_are_explained_without_guessing_missing_or_reading_projects(tmp_path, monkeypatch):
    transport(monkeypatch, lambda req: pytest.fail('no remote file access allowed'))
    text = f'[ZIP]({PROJECT}/xiaohongshu-xiaomi-auto/cards.zip)\n[Source](https://source.test/outputs/a.md)\n[Secret](outputs/a/../secret)'
    result = asyncio.run(delivery.sync(tmp_path, 's1', 't1', text, ENV))
    assert len(result['links']) == 2
    assert all(x['status'] == 'unsupported' for x in result['links'])
    assert all('不存在' not in x['message'] for x in result['links'])
    assert not list(tmp_path.glob('Qizhi/**/*'))
    assert delivery.references('`[example](outputs/secret.md)`', PROJECT) == []


@pytest.mark.parametrize('response', [httpx.Response(404), httpx.Response(302, headers={'location':'http://untrusted.test'}), httpx.Response(200, json={'error':'not bytes'}), httpx.Response(200, content=b'')])
def test_failed_or_empty_downloads_never_become_deliveries(tmp_path, monkeypatch, response):
    transport(monkeypatch, lambda req: response)
    result = asyncio.run(delivery.sync(tmp_path, 's', 't', '[F](outputs/task/file.md)', ENV))
    assert result['links'][0]['status'] == 'unavailable'
    assert ArtifactStore(tmp_path).snapshot('s')['artifacts'] == []


def test_approved_existing_export_is_checked_against_original_hash(tmp_path, monkeypatch):
    text = f'[Old]({PROJECT}/original/file.md)'
    original = b'existing file'
    receipt = delivery.status(tmp_path, 's', 't', text, ENV)
    receipt['links'][0].update(remotePath='outputs/recovery/file.md', approvedExport=True,
                              expectedSha256=hashlib.sha256(original).hexdigest())
    store.write_json(delivery.manifest_path(tmp_path, 's', 't'), receipt)
    transport(monkeypatch, lambda req: httpx.Response(200, content=b'changed bytes'))
    result = asyncio.run(delivery.sync(tmp_path, 's', 't', text, ENV))
    assert result['links'][0]['status'] == 'unavailable'
    assert ArtifactStore(tmp_path).snapshot('s')['artifacts'] == []


@pytest.fixture
def api(tmp_path, monkeypatch):
    outputs = tmp_path / 'outputs'
    sessions = outputs / '_sessions'
    monkeypatch.setattr(web, 'OUTPUTS_DIR', outputs)
    monkeypatch.setattr(web, 'SESSIONS_DIR', sessions)
    monkeypatch.setattr(web, 'ENV_FILE', tmp_path / '.env')
    web.ENV_FILE.write_text('CLOUDCLI_API_KEY=ck_test_secret\n')
    store.bind(sessions, 's1', 'qizhi', json.dumps({'sessionId':'native', 'target':delivery.target_identity(ENV)}))
    store.write_json(web._run_snapshot_file('t1'), {'session_id':'s1','turn_id':'t1','runtime':'qizhi','status':'done','clean_end':True,'text':'[F](outputs/task/file.md)'})
    with TestClient(web.app, base_url='http://127.0.0.1:7860', headers={'Origin':'http://127.0.0.1:7860'}) as client:
        yield client


def test_api_uses_stored_turn_and_original_target_only(api, monkeypatch):
    transport(monkeypatch, lambda req: httpx.Response(200, content=b'original'))
    assert api.get('/api/chat/remote-outputs/s1/t1').json()['links'][0]['status'] == 'pending'
    assert api.get('/api/chat/remote-outputs/another/t1').status_code == 404
    response = api.post('/api/chat/remote-outputs/s1/t1/recheck', json={'path':'/etc/passwd'})
    assert response.status_code == 200
    assert response.json()['links'][0]['status'] == 'ready'
    web.ENV_FILE.write_text('CLOUDCLI_API_KEY=other_key\n')
    assert api.post('/api/chat/remote-outputs/s1/t1/recheck').status_code == 409
