import importlib.util
import json
from pathlib import Path
import subprocess
import zipfile

import pytest

ROOT = Path(__file__).resolve().parents[1]


def test_linux_lock_covers_product_runtime_dependencies():
    import re
    import tomllib
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name

    project = tomllib.loads((ROOT / 'pyproject.toml').read_text(encoding='utf-8'))['project']
    pins = {canonicalize_name(name): version for name, version in re.findall(
        r'^([\w.-]+)==([^\s]+)', (ROOT / 'requirements/linux-py312.lock').read_text(), re.M)}
    for value in project['dependencies']:
        dependency = Requirement(value)
        if dependency.marker and not dependency.marker.evaluate({'sys_platform': 'linux', 'python_version': '3.12'}):
            continue
        assert canonicalize_name(dependency.name) in pins, dependency.name
        assert pins[canonicalize_name(dependency.name)] in dependency.specifier, dependency.name


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'deployment/138' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_release_uses_committed_bytes_excludes_secrets_and_detects_tampering(tmp_path):
    builder, manager = load('build_release'), load('manage')
    repo = tmp_path / 'repo'; repo.mkdir()
    required = ['deployment/138/Dockerfile', 'deployment/138/compose.yaml', 'requirements/linux-py312.lock',
                'deployment/138/runtime-package-lock.json', 'web/frontend/package-lock.json', 'easel/demo.py',
                '.env', 'profiles/person/private.md', 'skills/demo/cookies.json']
    for name in required:
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('committed')
    subprocess.run(['git', 'init', '--quiet'], cwd=repo, check=True)
    subprocess.run(['git', 'add', '.'], cwd=repo, check=True)
    subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], cwd=repo, check=True)
    (repo / 'easel/demo.py').write_text('dirty-live-source')
    output = tmp_path / 'release.zip'
    receipt = builder.export(repo, 'HEAD', output)
    expanded = tmp_path / 'expanded'; expanded.mkdir()
    with zipfile.ZipFile(output) as archive:
        assert archive.read('easel/demo.py') == b'committed'
        assert '.env' not in archive.namelist() and 'profiles/person/private.md' not in archive.namelist()
        assert 'skills/demo/cookies.json' not in archive.namelist()
        archive.extractall(expanded)
    assert manager.verify(expanded)['commit'] == receipt['commit']
    (expanded / 'easel/demo.py').write_text('tampered')
    with pytest.raises(ValueError, match='checksum'):
        manager.verify(expanded)


def test_manifest_cannot_verify_files_outside_release(tmp_path):
    manager = load('manage')
    release = tmp_path / 'release'; release.mkdir()
    (tmp_path / 'outside').write_text('x')
    (release / 'release-manifest.json').write_text(json.dumps({'schema': 1, 'commit': 'a' * 40,
        'files': {'../outside': {}}}))
    with pytest.raises(ValueError, match='Invalid release file'):
        manager.verify(release)


def test_quick_deploy_script_keeps_candidate_default_and_sensitive_paths_outside_payload():
    script = (ROOT / 'scripts/deploy_138.ps1').read_text(encoding='utf-8')
    assert '[switch]$Activate' in script
    assert "if ($Activate) { 'EXPLICITLY ENABLED' } else { 'candidate only' }" in script
    assert 'python3 "$stage/deployment/138/manage.py" activate' in script
    assert 'if [ "$activate" = 1 ]; then\n  python3 "$stage/deployment/138/manage.py" prepare' in script
    assert "[switch]$KeepRemoteArchive" in script
    assert 'BatchMode=yes' in script and 'sha256sum' in script
    guide = (ROOT / 'docs/deploy-138-quick-start.md').read_text(encoding='utf-8')
    assert '-Activate' in guide and 'OpenClaw 状态' in guide and '个人 outputs' in guide


def test_image_dependency_reuse_requires_every_locked_input(tmp_path, monkeypatch):
    import sys
    monkeypatch.syspath_prepend(str(ROOT / 'deployment/138'))
    builder = load('build_image')
    baseline = {'files': {name: {'sha256': str(i), 'bytes': i, 'md5': str(i)}
                          for i, name in enumerate(builder.DEPENDENCIES)}}
    candidate = json.loads(json.dumps(baseline))
    assert builder.compatible(candidate, baseline)
    for name in builder.DEPENDENCIES:
        changed = json.loads(json.dumps(candidate)); changed['files'][name]['sha256'] = 'changed'
        assert not builder.compatible(changed, baseline)
        missing = json.loads(json.dumps(candidate)); del missing['files'][name]
        assert not builder.compatible(missing, baseline)
