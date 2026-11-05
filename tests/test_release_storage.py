import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest


def manager():
    spec = importlib.util.spec_from_file_location('release_storage_manager',
        Path(__file__).resolve().parents[1] / 'deployment/138/manage.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize('full', ['Docker', 'containerd'])
def test_separate_full_build_filesystem_is_rejected(tmp_path, monkeypatch, full):
    module = manager()
    roots = {key: tmp_path / key for key in ['data', 'Docker', 'containerd']}
    for root in roots.values():
        root.mkdir()
    monkeypatch.setattr(module.shutil, 'disk_usage', lambda path:
        SimpleNamespace(free=100 if Path(path) == roots[full] else 30 * 1024 ** 3))
    with pytest.raises(RuntimeError, match=full):
        module.check_storage(roots['data'], roots['Docker'], roots['containerd'])


def test_storage_preflight_returns_all_mount_evidence(tmp_path, monkeypatch):
    module = manager()
    monkeypatch.setattr(module.shutil, 'disk_usage', lambda path: SimpleNamespace(free=10 * 1024 ** 3))
    checks = module.check_storage(tmp_path, tmp_path, tmp_path)
    assert [row['kind'] for row in checks] == ['release/data', 'Docker', 'containerd']
    assert all(row['freeBytes'] == 10 * 1024 ** 3 for row in checks)


def test_deployment_rejects_stale_branch_version_but_allows_minor_upgrade():
    module = manager()
    project = lambda version: '[project]' + chr(10) + 'version="' + version + '"'
    with pytest.raises(ValueError, match='older'):
        module.check_release_version(project('0.10.0'), project('0.45.9'))
    module.check_release_version(project('0.46.0'), project('0.45.9'))
    module.check_release_version(project('0.46.0'), project('0.46.0'))
