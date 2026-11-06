import asyncio
from pathlib import Path

import httpx
import pytest

from easel import qizhi_files as files
from easel.harnesses.base import HarnessError


def client(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(files.httpx, 'AsyncClient', lambda **kwargs:
                        original(transport=httpx.MockTransport(handler), **kwargs))
    return files.QizhiFiles({'CLOUDCLI_API_KEY': 'ck_test_secret'})


def test_upload_uses_repeated_files_and_preserves_bytes(tmp_path, monkeypatch):
    a = tmp_path / 'sample.stl'
    a.write_bytes(b'\x00\xffbinary\r\n')
    def handle(req):
        assert req.headers['X-API-Key'] == 'ck_test_secret'
        assert req.url.path == '/api/qizhi-agent/files'
        assert b'name="files"' in req.content and a.read_bytes() in req.content
        return httpx.Response(201, json={'projectPath': files.config({
            'CLOUDCLI_API_KEY': 'test'})[1], 'files': [{'file_id': 'file_123',
            'relative_path': 'uploads/file_123-sample.stl', 'size': a.stat().st_size}]})
    c = client(monkeypatch, handle)
    rows = asyncio.run(c.upload([a]))
    assert rows[0]['file_id'] == 'file_123'


def test_artifact_listing_filters_exact_task_prefix(monkeypatch):
    c = client(monkeypatch, lambda req: httpx.Response(200, json={
        'projectPath': '/home/cloudcli/projects/qizhi-agent', 'truncated': True,
        'artifacts': [{'relative_path': x} for x in (
            'outputs/task-1/a.stl', 'outputs/task-10/private.stl', 'outputs/other/b.stl')]}))
    result = asyncio.run(c.artifacts('task-1'))
    assert result == {'artifacts': [{'relative_path': 'outputs/task-1/a.stl'}], 'truncated': True}


@pytest.mark.parametrize('relative', ['../secrets', '/outputs/x', 'outputs/a/../secret',
                                    'outputs//a', 'outputs/a\\b', 'uploads/a'])
def test_download_rejects_unsafe_paths_without_network(tmp_path, monkeypatch, relative):
    def reject(req):
        pytest.fail('unsafe path reached transport')
    c = client(monkeypatch, reject)
    with pytest.raises(HarnessError):
        asyncio.run(c.download(relative, tmp_path / 'out.stl'))


def test_download_binary_and_refuses_overwrite(tmp_path, monkeypatch):
    data = b'\x00\xff3MF\r\n'
    c = client(monkeypatch, lambda req: httpx.Response(200, content=data))
    out = asyncio.run(c.download('outputs/task-1/a.3mf', tmp_path / 'out.3mf'))
    assert out.read_bytes() == data and not out.with_suffix('.3mf.part').exists()
    with pytest.raises(HarnessError, match='已存在'):
        asyncio.run(c.download('outputs/task-1/a.3mf', out))


def test_error_never_saved_or_key_echoed(tmp_path, monkeypatch):
    c = client(monkeypatch, lambda req: httpx.Response(401, text='ck_test_secret'))
    with pytest.raises(HarnessError) as error:
        asyncio.run(c.download('outputs/task/a.stl', tmp_path / 'out.stl'))
    assert 'ck_test_secret' not in str(error.value) and not (tmp_path / 'out.stl').exists()


def test_json_error_is_not_saved_as_binary(tmp_path, monkeypatch):
    c = client(monkeypatch, lambda req: httpx.Response(200, json={'error': 'failure'}))
    with pytest.raises(HarnessError, match='JSON'):
        asyncio.run(c.download('outputs/task/a.stl', tmp_path / 'out.stl'))
    assert not list(tmp_path.iterdir())
