import importlib.util
import json
from pathlib import Path
import subprocess
import zipfile

import pytest

ROOT = Path(__file__).resolve().parents[1]


def test_server_build_context_includes_runtime_agent_sources():
    rules=(ROOT / '.dockerignore').read_text().splitlines()
    for directory in ('agents/', 'agents/workspace/', 'openclaw/', 'openclaw/easel-agent-safety/'):
        assert '!'+directory in rules
    for directory in ('agents/workspace/', 'openclaw/easel-agent-safety/'):
        assert '!'+directory+'**' in rules


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


def test_image_reuse_allows_only_verified_release_metadata_change(monkeypatch):
    import hashlib
    monkeypatch.syspath_prepend(str(ROOT / 'deployment/138'))
    builder = load('build_image')
    old = b'[project]\nname="easel"\nversion="0.14.6"\ndependencies=["pillow==12.2.0"]\n'
    new = old.replace(b'0.14.6', b'0.43.0')
    baseline = {'files': {name: {'sha256': 'unchanged'} for name in builder.DEPENDENCIES}}
    baseline['files']['pyproject.toml'] = {'sha256': hashlib.sha256(old).hexdigest()}
    candidate = json.loads(json.dumps(baseline))
    candidate['files']['pyproject.toml'] = {'sha256': hashlib.sha256(new).hexdigest()}
    assert builder.compatible(candidate, baseline, new, old)
    assert not builder.compatible(candidate, baseline, new + b'\n', old)
    for changed in (new.replace(b'12.2.0', b'12.3.0'), new + b'\n[tool.setuptools]\nzip-safe=false\n'):
        candidate['files']['pyproject.toml']['sha256'] = hashlib.sha256(changed).hexdigest()
        assert not builder.compatible(candidate, baseline, changed, old)


def test_image_reuse_falls_back_to_matching_running_production_image(tmp_path, monkeypatch):
    from types import SimpleNamespace
    monkeypatch.syspath_prepend(str(ROOT / 'deployment/138'))
    builder = load('build_image')
    receipt = tmp_path / 'Easel' / 'deployment-receipt.json'
    receipt.parent.mkdir()
    secrets = tmp_path / 'easel-secrets'; secrets.mkdir()
    (secrets / 'deployment.env').write_text('EASEL_IMAGE=easel:active\n')
    original_is_file = Path.is_file
    def guarded_is_file(self):
        if self == receipt:
            raise PermissionError('protected release')
        return original_is_file(self)
    monkeypatch.setattr(Path, 'is_file', guarded_is_file)
    image_id = 'sha256:' + 'a' * 64
    manifest = {'commit': 'b' * 40, 'files': {}}
    def output(command, **kwargs):
        if command[:2] == ['docker', 'ps']:
            return 'container-1\n'
        if command[:2] == ['docker', 'inspect']:
            return json.dumps([{'Image': image_id}])
        if command[:3] == ['docker', 'image', 'inspect']:
            return json.dumps([{'Id': image_id, 'Config': {'Labels': {
                'org.opencontainers.image.revision': 'b' * 40}}}])
        if command[:3] == ['docker', 'run', '--rm'] and command[-1] == '/app/release-manifest.json':
            return json.dumps(manifest)
        if command[:3] == ['docker', 'run', '--rm'] and command[-1] == '/app/pyproject.toml':
            return (ROOT / 'pyproject.toml').read_bytes()
        raise AssertionError(command)
    monkeypatch.setattr(subprocess, 'check_output', output)
    monkeypatch.setattr(builder, 'compatible', lambda candidate, baseline, new, old:
                        baseline.get('commit') == 'b' * 40 and new == (ROOT / 'pyproject.toml').read_bytes())
    assert builder.reusable(tmp_path, {'files': {}}, ROOT) == (image_id, manifest)


def test_active_receipt_is_reconstructed_from_verified_running_image(tmp_path, monkeypatch):
    import sys
    monkeypatch.syspath_prepend(str(ROOT / 'deployment/138'))
    manager = load('manage')
    secrets = tmp_path / 'easel-secrets-test'; secrets.mkdir()
    image_id = 'sha256:' + 'a' * 64
    image_ref = 'easel:active-test'
    nginx = 'nginx:1.29.2-alpine@sha256:' + 'c' * 64
    (secrets / 'deployment.env').write_text(f'EASEL_IMAGE={image_ref}\nEASEL_NGINX_IMAGE={nginx}\n')
    def output(command, **kwargs):
        if command[:2] == ['docker', 'ps']:
            assert 'easel-test' in command[4]
            return 'container-1\n'
        if command[:2] == ['docker', 'inspect']:
            return json.dumps([{'Image': image_id}])
        if command[:3] == ['docker', 'image', 'inspect']:
            return json.dumps([{'Id': image_id, 'Config': {'Labels': {
                'org.opencontainers.image.revision': 'b' * 40}}}])
        raise AssertionError(command)
    monkeypatch.setattr(subprocess, 'check_output', output)
    result = manager.active_receipt(tmp_path, True, tmp_path / 'old-release')
    assert result == {'commit': 'b' * 40, 'image': image_id, 'nginx': nginx,
                      'source': str(tmp_path / 'old-release')}


def test_active_receipt_rejects_container_image_mismatch(tmp_path, monkeypatch):
    import sys
    monkeypatch.syspath_prepend(str(ROOT / 'deployment/138'))
    manager = load('manage')
    secrets = tmp_path / 'easel-secrets'; secrets.mkdir()
    (secrets / 'deployment.env').write_text('EASEL_IMAGE=easel:active\nEASEL_NGINX_IMAGE=nginx:fixed\n')
    def output(command, **kwargs):
        if command[:2] == ['docker', 'ps']:
            return 'container-1\n'
        if command[:2] == ['docker', 'inspect']:
            return json.dumps([{'Image': 'sha256:' + 'd' * 64}])
        if command[:3] == ['docker', 'image', 'inspect']:
            return json.dumps([{'Id': 'sha256:' + 'a' * 64, 'Config': {'Labels': {
                'org.opencontainers.image.revision': 'b' * 40}}}])
        raise AssertionError(command)
    monkeypatch.setattr(subprocess, 'check_output', output)
    with pytest.raises(ValueError, match='does not match'):
        manager.active_receipt(tmp_path, False, tmp_path / 'old-release')


def test_previous_release_receipt_is_captured_before_candidate_config_write(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / 'deployment/138'))
    manager = load('manage')
    old_release = tmp_path / 'protected-old-release'; old_release.mkdir()
    current = tmp_path / 'Easel-test'
    original_is_symlink = Path.is_symlink
    original_resolve = Path.resolve
    monkeypatch.setattr(Path, 'is_symlink', lambda self: True if self == current else original_is_symlink(self))
    monkeypatch.setattr(Path, 'resolve', lambda self, *args, **kwargs:
                        old_release if self == current else original_resolve(self, *args, **kwargs))
    secrets = tmp_path / 'easel-secrets-test'; secrets.mkdir()
    image_id = 'sha256:' + 'a' * 64
    old_ref = 'easel:old'
    new_ref = 'easel:new'
    nginx = 'nginx:fixed'
    config = secrets / 'deployment.env'
    config.write_text(f'EASEL_IMAGE={old_ref}\nEASEL_NGINX_IMAGE={nginx}\n')
    def output(command, **kwargs):
        if command[:2] == ['docker', 'ps']:
            return 'container-1\n'
        if command[:2] == ['docker', 'inspect']:
            return json.dumps([{'Image': image_id}])
        if command[:3] == ['docker', 'image', 'inspect']:
            assert command[-1] == old_ref
            return json.dumps([{'Id': image_id, 'Config': {'Labels': {
                'org.opencontainers.image.revision': 'b' * 40}}}])
        raise AssertionError(command)
    monkeypatch.setattr(subprocess, 'check_output', output)
    captured = manager.previous_release_receipt(tmp_path, True)
    config.write_text(f'EASEL_IMAGE={new_ref}\nEASEL_NGINX_IMAGE={nginx}\n')
    assert captured['image'] == image_id
    assert captured['commit'] == 'b' * 40
    assert captured['source'] == str(old_release)


@pytest.mark.parametrize('name,code', [('Gateway', -9), ('Web', 1)])
def test_supervisor_identifies_failed_child_without_logging_arguments(monkeypatch, name, code):
    from types import SimpleNamespace
    monkeypatch.syspath_prepend(str(ROOT / 'deployment/138'))
    supervisor = load('supervisor')
    live = SimpleNamespace(pid=101, poll=lambda: None)
    failed = SimpleNamespace(pid=102, poll=lambda: code)
    monkeypatch.setattr(supervisor, 'children', [failed, live] if name == 'Gateway' else [live, failed])
    with pytest.raises(RuntimeError, match=f'{name} process pid=102 exited with code={code}'):
        supervisor.check_children()


def test_gateway_cold_start_can_exceed_previous_80_second_limit(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.syspath_prepend(str(ROOT / 'deployment/138'))
    supervisor = load('supervisor')
    clock = [0.0]
    monkeypatch.delenv('EASEL_GATEWAY_STARTUP_TIMEOUT', raising=False)
    monkeypatch.setattr(supervisor, 'children', [SimpleNamespace(pid=101, poll=lambda: None)])
    monkeypatch.setattr(supervisor.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(supervisor.time, 'sleep', lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    monkeypatch.setattr(supervisor, 'ready', lambda url: clock[0] >= 120)
    supervisor.wait_gateway_ready(supervisor.gateway_startup_timeout())
    assert clock[0] == 120


@pytest.mark.parametrize('state', ['timeout', 'stopping', 'exited'])
def test_gateway_startup_still_rejects_unready_or_failed_process(monkeypatch, state):
    from types import SimpleNamespace
    monkeypatch.syspath_prepend(str(ROOT / 'deployment/138'))
    supervisor = load('supervisor')
    monkeypatch.setattr(supervisor, 'ready', lambda url: False)
    monkeypatch.setattr(supervisor, 'stopping', state == 'stopping')
    monkeypatch.setattr(supervisor, 'children', [SimpleNamespace(pid=101, poll=lambda: 1 if state == 'exited' else None)])
    monkeypatch.setattr(supervisor.time, 'monotonic', lambda: 301)
    with pytest.raises(RuntimeError):
        supervisor.wait_gateway_ready(300)


@pytest.mark.parametrize('value,expected', [('30', 30), ('900', 900), ('29', None), ('901', None), ('bad', None)])
def test_gateway_startup_budget_is_bounded(monkeypatch, value, expected):
    monkeypatch.syspath_prepend(str(ROOT / 'deployment/138'))
    supervisor = load('supervisor')
    monkeypatch.setenv('EASEL_GATEWAY_STARTUP_TIMEOUT', value)
    if expected is None:
        with pytest.raises(ValueError):
            supervisor.gateway_startup_timeout()
    else:
        assert supervisor.gateway_startup_timeout() == expected


def test_docker_startup_grace_uses_same_gateway_budget():
    import yaml
    app = yaml.safe_load((ROOT / 'deployment/138/compose.yaml').read_text())['services']['app']
    budget = app['environment']['EASEL_GATEWAY_STARTUP_TIMEOUT']
    assert app['healthcheck']['start_period'] == budget + 's'
