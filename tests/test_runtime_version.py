"""Runtime identity uses release metadata and the existing server authentication."""
import ast
import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
import pytest

from easel import version
from easel.server_access import AccessStore, ServerAccessMiddleware, password_hash

ROOT = Path(__file__).resolve().parents[1]
REVISION = 'abcdef0123456789' * 2 + 'abcdef01'


def source_version(root, value='0.2.7'):
    (root / 'pyproject.toml').write_text(f'[project]\nversion = "{value}"\n', encoding='utf-8')


def test_release_revision_and_version_describe_running_files(tmp_path, monkeypatch):
    source_version(tmp_path)
    (tmp_path / 'release-manifest.json').write_text(json.dumps({
        'schema': 1, 'source': 'git-archive', 'commit': REVISION, 'files': {}}))
    monkeypatch.setenv('EASEL_VERSION', '9.9.9')
    monkeypatch.setenv('EASEL_REVISION', 'f' * 40)
    monkeypatch.setattr(version.metadata, 'version', lambda name: '0.1.0')
    assert version.runtime_version(tmp_path) == {'version': '0.2.7', 'revision': REVISION,
        'build': REVISION[:12], 'development': False}
    source_version(tmp_path, '0.2.8')
    assert version.runtime_version(tmp_path)['version'] == '0.2.8'


@pytest.mark.parametrize('manifest', [None, '{broken', 'null', '[]',
    {'schema': True, 'source': 'git-archive', 'commit': REVISION},
    {'schema': 2, 'source': 'git-archive', 'commit': REVISION},
    {'schema': 1, 'source': 'working-tree', 'commit': REVISION},
    {'schema': 1, 'source': 'git-archive', 'commit': 'bad-path/secret'},
    {'schema': 1, 'source': 'git-archive', 'commit': 123},
    {'schemaVersion': 1, 'sourceCommit': REVISION, 'sourceDirty': True}])
def test_missing_or_invalid_manifest_is_explicitly_development(tmp_path, manifest):
    source_version(tmp_path)
    if manifest is not None:
        (tmp_path / 'release-manifest.json').write_text(
            manifest if isinstance(manifest, str) else json.dumps(manifest))
    assert version.runtime_version(tmp_path) == {'version': '0.2.7', 'revision': None,
        'build': 'development', 'development': True}


def test_version_falls_back_to_installed_metadata_without_source(tmp_path, monkeypatch):
    monkeypatch.setattr(version.metadata, 'version', lambda name: '0.2.9')
    assert version.application_version(tmp_path) == '0.2.9'
    (tmp_path / 'pyproject.toml').write_text('invalid TOML')
    assert version.application_version(tmp_path) == '0.2.9'
    def missing(name):
        raise version.metadata.PackageNotFoundError(name)
    monkeypatch.setattr(version.metadata, 'version', missing)
    assert version.application_version(tmp_path) == 'unknown'


def test_python_310_reader_only_uses_project_version(tmp_path, monkeypatch):
    monkeypatch.setattr(version, 'tomllib', None)
    (tmp_path / 'pyproject.toml').write_text(
        "[dependency]\nversion = \"8.8.8\"\n[project]\nversion = '0.2.7' # release\n"
        '[tool.example]\nversion = "9.9.9"\n')
    assert version.application_version(tmp_path) == '0.2.7'


def test_api_version_requires_existing_server_login_and_forbids_cache(tmp_path):
    source_version(tmp_path)
    auth = tmp_path / 'access.json'
    auth.write_text(json.dumps({'sessionKey': 'ab' * 32, 'environment': 'production',
        'users': {'operator': password_hash('synthetic-test-password')}}))
    store = AccessStore(auth)
    app = FastAPI()
    # Load the actual endpoint without starting Gateway or reading user state.
    tree = ast.parse((ROOT / 'web/app.py').read_text(encoding='utf-8'))
    route, = [node for node in tree.body
              if isinstance(node, ast.AsyncFunctionDef) and node.name == 'api_version']
    module = ast.Module(body=[route], type_ignores=[])
    ast.fix_missing_locations(module)
    exec(compile(module, str(ROOT / 'web/app.py'), 'exec'), {
        'app': app, 'JSONResponse': JSONResponse, 'runtime_version': version.runtime_version,
        'PROJECT_ROOT': tmp_path})
    app.add_middleware(ServerAccessMiddleware, store=store, origins=['https://easel.test'])
    with TestClient(app, base_url='https://easel.test', follow_redirects=False) as client:
        assert client.get('/api/version').status_code == 401
        login = client.post('/login', headers={'Origin': 'https://easel.test'},
            data={'username': 'operator', 'password': 'synthetic-test-password'})
        assert login.status_code == 303
        result = client.get('/api/version')
        assert result.status_code == 200
        assert result.headers['cache-control'] == 'no-store'
        assert result.json() == {'version': '0.2.7', 'revision': None,
            'build': 'development', 'development': True}
        assert str(tmp_path) not in result.text and 'sessionKey' not in result.text
        (tmp_path / 'release-manifest.json').write_text(json.dumps({
            'schema': 1, 'source': 'git-archive', 'commit': REVISION}))
        assert client.get('/api/version').json()['revision'] == REVISION
