import importlib.util
import json
from pathlib import Path

import pytest


def test_server_bootstrap_retains_identity_config_and_user_data(tmp_path, monkeypatch):
    probe = tmp_path / 'link-probe'
    try:
        probe.symlink_to(tmp_path, target_is_directory=True)
        probe.unlink()
    except OSError:
        pytest.skip('Linux server symlinks are unavailable to this Windows test account')
    source = Path(__file__).resolve().parents[1] / 'deployment/138/bootstrap_gateway.py'
    spec = importlib.util.spec_from_file_location('bootstrap', source)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    module.ROOT = tmp_path / 'code'
    module.DATA = tmp_path / 'data'
    module.STATE = tmp_path / 'state/openclaw'
    module.WORKSPACE = module.STATE / 'workspace'
    for name, text in {'skills/openclaw/example/SKILL.md': 'example', 'skills/shared/helper.py': 'helper',
                       'profiles/_template/identity.md': 'template', 'openclaw/workspace/AGENTS.md': 'agent'}.items():
        target = module.ROOT / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_text(text)
    monkeypatch.setattr(Path, 'home', classmethod(lambda cls: tmp_path / 'state/home'))
    monkeypatch.setenv('XDG_CACHE_HOME', str(tmp_path / 'state/cache'))
    model_file = tmp_path / 'bootstrap-model.json'
    model_file.write_text(json.dumps({'providers': {'test': {'models': [{'id': 'sample'}]}}, 'primary': 'test/sample'}))
    monkeypatch.setenv('EASEL_MODEL_BOOTSTRAP_FILE', str(model_file))
    module.bootstrap()
    assert not (module.STATE / 'identity/device.json').exists()
    # Bootstrap must leave native OpenClaw identity storage alone. Actual native
    # creation and Gateway pairing are verified separately in the Linux runtime.
    identity_path = module.STATE / 'state/openclaw.sqlite'
    identity_path.parent.mkdir(exist_ok=True)
    identity_path.write_bytes(b'existing-native-state-fixture')
    identity = identity_path.read_bytes()
    config_path = module.STATE / 'openclaw.json'
    config = json.loads(config_path.read_text())
    assert config['tools']['toolSearch'] is False
    # An explicit later preference belongs to the operator and survives restart.
    config['tools']['toolSearch'] = True
    config['agents']['defaults']['model']['primary'] = 'test/user-selected'
    config_path.write_text(json.dumps(config))
    expected_config = config_path.read_bytes()
    memory = module.WORKSPACE / 'MEMORY.md'; memory.write_text('user memory')
    output = module.DATA / 'outputs/actual.txt'; output.write_text('actual file')
    module.bootstrap()
    assert identity_path.read_bytes() == identity
    assert config_path.read_bytes() == expected_config
    assert memory.read_text() == 'user memory' and output.read_text() == 'actual file'
    assert (module.WORKSPACE / 'outputs').resolve() == (module.DATA / 'outputs').resolve()
    assert (module.DATA / 'profiles/_template/identity.md').read_text() == 'template'
