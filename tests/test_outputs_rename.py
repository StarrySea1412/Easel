"""内容库重命名：保留扩展名、防穿越、系统数据保护、同名冲突如实报错。"""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web  # noqa: E402


@pytest.fixture
def rename_env(tmp_path, monkeypatch):
    root = tmp_path / 'outputs'
    root.mkdir()
    monkeypatch.setattr(web, 'OUTPUTS_DIR', root)
    client = TestClient(web.app, base_url='http://127.0.0.1:7860', client=('127.0.0.1', 51234))
    return client, root


def test_file_rename_keeps_extension_and_accepts_explicit_suffix(rename_env):
    client, root = rename_env
    project = root / 'project'
    project.mkdir()
    (project / 'notes.md').write_text('正文', encoding='utf-8')
    res = client.post('/api/output/project/notes.md/rename', json={'name': '会议记录'})
    assert res.status_code == 200
    assert res.json() == {'ok': True, 'renamed': 'project/会议记录.md', 'old': 'project/notes.md', 'kind': 'file'}
    assert (project / '会议记录.md').read_text(encoding='utf-8') == '正文'
    assert not (project / 'notes.md').exists()
    res = client.post('/api/output/project/会议记录.md/rename', json={'name': '最终版.md'})
    assert res.status_code == 200 and res.json()['renamed'] == 'project/最终版.md'
    assert (project / '最终版.md').exists() and not (project / '最终版.md.md').exists()
    same = client.post('/api/output/project/最终版.md/rename', json={'name': '最终版.md'})
    assert same.status_code == 200 and same.json()['renamed'] == 'project/最终版.md'


def test_blank_separator_and_overlong_names_rejected(rename_env):
    client, root = rename_env
    target = root / 'note.md'
    target.write_text('keep', encoding='utf-8')
    for bad in [' ', 'a/b', 'a\\b', '..', 'a:b']:
        res = client.post('/api/output/note.md/rename', json={'name': bad})
        assert res.status_code == 400, bad
    assert client.post('/api/output/note.md/rename', json={'name': ''}).status_code == 422
    assert client.post('/api/output/note.md/rename', json={'name': '长' * 90}).status_code == 422
    assert target.exists()


def test_existing_sibling_reports_collision(rename_env):
    client, root = rename_env
    (root / 'readme.md').write_text('a', encoding='utf-8')
    (root / 'notes.md').write_text('b', encoding='utf-8')
    res = client.post('/api/output/notes.md/rename', json={'name': 'readme.md'})
    assert res.status_code == 409
    assert (root / 'readme.md').read_text(encoding='utf-8') == 'a'
    assert (root / 'notes.md').read_text(encoding='utf-8') == 'b'


def test_protected_system_paths_and_escapes_rejected(rename_env):
    client, root = rename_env
    sessions = root / '_sessions'
    sessions.mkdir()
    (sessions / 'abc.json').write_text('{}', encoding='utf-8')
    assert client.post('/api/output/_sessions/abc.json/rename', json={'name': 'me.json'}).status_code == 403
    secret = root.parent / 'secret.md'
    secret.write_text('s', encoding='utf-8')
    escape = client.post('/api/output/..%2Fsecret.md/rename', json={'name': 'x.md'})
    assert escape.status_code == 403
    assert secret.read_text(encoding='utf-8') == 's'
    assert client.post('/api/output/missing.md/rename', json={'name': 'x.md'}).status_code == 404


def test_directory_rename_moves_children_and_imagegen_sidecar(rename_env):
    client, root = rename_env
    idea = root / '灵感'
    idea.mkdir()
    (idea / 'a.md').write_text('x', encoding='utf-8')
    res = client.post('/api/output/灵感/rename', json={'name': '灵感存档'})
    assert res.status_code == 200
    assert res.json()['renamed'] == '灵感存档' and res.json()['kind'] == 'dir'
    assert (root / '灵感存档' / 'a.md').exists()
    assert [node['name'] for node in web.get_output_tree()] == ['灵感存档']
    images = root / 'AI生图'
    images.mkdir()
    png = images / 'photo.png'
    png.write_bytes(b'png')
    sidecar = web._imagegen_metadata_path(png)
    sidecar.write_text('{"prompt": "落日"}', encoding='utf-8')
    res = client.post('/api/output/AI生图/photo.png/rename', json={'name': '落日'})
    assert res.status_code == 200 and res.json()['renamed'] == 'AI生图/落日.png'
    assert web._imagegen_metadata_path(images / '落日.png').read_text(encoding='utf-8') == '{"prompt": "落日"}'
    assert not sidecar.exists()
