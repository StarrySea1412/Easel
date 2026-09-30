"""Workspace output metadata tests never inspect real outputs or configuration."""
import ast
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
from urllib.parse import unquote, urlsplit

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.testclient import TestClient
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'web'))
import office_outputs as outputs


def make_file(root, relative, content=b'SYNTHETIC_CONTENT', stamp=None):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    if stamp is not None:
        os.utime(path, (stamp, stamp))
    return path


def test_metadata_has_real_size_time_kind_and_safe_href_without_reading_bodies(tmp_path, monkeypatch):
    path = make_file(tmp_path, '作品 空格/成品 #1.pdf', stamp=1700000000)
    monkeypatch.setattr(Path, 'open', lambda *args, **kwargs: pytest.fail('metadata must not read file bodies'))
    result = outputs.snapshot(tmp_path)
    assert result['scope'] == 'workspace' and result['source'] == 'local_output_metadata'
    assert result['truncated'] is False
    item, = result['items']
    assert item['name'] == path.name and item['kind'] == 'document' and item['size'] == 17
    assert datetime.fromisoformat(item['modifiedAt']).timestamp() == 1700000000
    assert datetime.fromisoformat(result['observedAt']).tzinfo == timezone.utc
    assert item['href'].startswith('/api/media/') and urlsplit(item['href']).fragment == ''
    assert unquote(item['href'][len('/api/media/'):]) == item['path']
    serialized = json.dumps(result)
    assert 'SYNTHETIC_CONTENT' not in serialized and str(tmp_path) not in serialized
    assert 'sessionId' not in serialized and 'agentId' not in serialized


def test_system_hidden_credentials_and_non_content_files_are_excluded(tmp_path):
    blocked = ['_sessions/session.md', '_skill_audits/a.pdf', '_login/code.png', 'analytics/report.csv',
               '.hidden/report.pdf', 'topic/.secret/report.pdf', 'topic/_private/report.pdf',
               'topic/cookies.txt', 'topic/api-key.txt', 'topic/credentials.csv', 'topic/密码.md',
               'topic/auth/config.md', 'topic/settings.json', 'topic/config.yaml', 'topic/private.pem',
               'topic/.easel.json', 'topic/script.ps1', 'loose.pdf']
    for name in blocked:
        make_file(tmp_path, name)
    make_file(tmp_path, 'topic/good.md')
    assert [item['path'] for item in outputs.snapshot(tmp_path)['items']] == ['topic/good.md']


def test_latest_twenty_items_are_ordered_and_ids_are_stable(tmp_path):
    for index in range(26):
        make_file(tmp_path, f'topic/{index}.png', stamp=1700000000 + index)
    first, second = outputs.snapshot(tmp_path), outputs.snapshot(tmp_path)
    assert len(first['items']) == 20 and first['items'] == second['items']
    assert [item['name'] for item in first['items']] == [f'{i}.png' for i in range(25, 5, -1)]
    assert first['truncated'] is False


def test_scan_entry_and_directory_caps_are_explicit(tmp_path, monkeypatch):
    for index in range(10):
        make_file(tmp_path, f'project-{index}/final.png')
    original = outputs.os.scandir
    visits = []
    def tracked(path):
        visits.append(path)
        return original(path)
    monkeypatch.setattr(outputs.os, 'scandir', tracked)
    monkeypatch.setattr(outputs, 'MAX_DIRECTORIES', 2)
    result = outputs.snapshot(tmp_path)
    assert len(visits) <= 2 and result['truncated'] is True and result['warnings']
    monkeypatch.setattr(outputs, 'MAX_ENTRIES', 2)
    assert outputs.snapshot(tmp_path)['truncated'] is True


def test_depth_limit_does_not_traverse_deep_trees(tmp_path, monkeypatch):
    make_file(tmp_path, 'topic/deep/deeper/final.pdf')
    monkeypatch.setattr(outputs, 'MAX_DEPTH', 1)
    result = outputs.snapshot(tmp_path)
    assert result['items'] == [] and result['truncated'] is True


def test_symlink_like_directory_is_not_followed(tmp_path, monkeypatch):
    # Simulate a Windows junction without requiring symlink privileges.
    make_file(tmp_path, 'topic/final.pdf')
    original = outputs.os.scandir
    scanned = []
    class LinkEntry:
        name = 'topic'
        path = str(tmp_path / 'topic')
        def stat(self, **kwargs):
            from types import SimpleNamespace
            return SimpleNamespace(st_mode=0o040755, st_file_attributes=0x400)
    class Entries:
        def __enter__(self): return iter([LinkEntry()])
        def __exit__(self, *args): pass
    def scan(path):
        scanned.append(path)
        return Entries() if path == tmp_path else original(path)
    monkeypatch.setattr(outputs.os, 'scandir', scan)
    assert outputs.snapshot(tmp_path)['items'] == [] and scanned == [tmp_path]


def test_unreadable_directory_has_visible_partial_coverage(tmp_path, monkeypatch):
    make_file(tmp_path, 'topic/final.pdf')
    def denied(path): raise PermissionError('PRIVATE_PATH_DETAIL')
    monkeypatch.setattr(outputs.os, 'scandir', denied)
    result = outputs.snapshot(tmp_path)
    assert result['items'] == [] and result['truncated'] is True and result['warnings']
    assert 'PRIVATE_PATH_DETAIL' not in json.dumps(result)


def test_missing_output_root_is_a_valid_empty_workspace(tmp_path):
    result = outputs.snapshot(tmp_path / 'missing')
    assert result['items'] == [] and result['warnings'] == [] and result['truncated'] is False


def test_endpoint_hrefs_reuse_existing_media_path_guard(tmp_path):
    make_file(tmp_path, 'topic/final #.txt')
    names = {'api_workspace_outputs', '_safe_output_path', 'api_media'}
    source = ast.parse((ROOT / 'web/app.py').read_text(encoding='utf-8'))
    nodes = [node for node in source.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    assert {node.name for node in nodes} == names
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), *nodes], type_ignores=[])
    ast.fix_missing_locations(module)
    app = FastAPI()
    namespace = {'app': app, 'OUTPUTS_DIR': tmp_path, 'HTTPException': HTTPException, 'FileResponse': FileResponse}
    exec(compile(module, str(ROOT / 'web/app.py'), 'exec'), namespace)
    with TestClient(app) as client:
        response = client.get('/api/workspace-outputs')
        assert response.status_code == 200
        item, = response.json()['items']
        # Read synthetic fixture only to verify the advertised link is usable.
        assert client.get(item['href']).content == b'SYNTHETIC_CONTENT'
        assert client.get('/api/media/topic/%2e%2e/%2e%2e/outside.txt').status_code == 403
