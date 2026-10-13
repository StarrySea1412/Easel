import importlib.util
import json
from pathlib import Path
import subprocess
import zipfile

import pytest

ROOT = Path(__file__).resolve().parents[1]


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
