"""Run the actual Windows gateway bootstrap without starting any service."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('shell', ['powershell', 'pwsh'])
@pytest.mark.parametrize('overrides,configured,expected', [
    ({}, None, 37289),
    ({'OPENCLAW_GATEWAY_PORT': '[::1]:19001'}, 19005, 19001),
    ({'OPENCLAW_GATEWAY_PORT': 'invalid', 'EASEL_GATEWAY_PORT': 'host:19002'}, 19005, 19002),
    ({}, 19003.0, 37289),
    ({}, '19004', 37289),
    ({}, 19005, 19005),
    ({}, True, 37289),
])
def test_windows_bootstrap_uses_the_shared_endpoint_contract(tmp_path, shell, overrides, configured, expected):
    executable = shutil.which(shell)
    if not executable:
        pytest.skip(f'{shell} unavailable')
    state = tmp_path / 'state'
    state.mkdir()
    if configured is not None:
        (state / 'openclaw.json').write_text(json.dumps({'gateway': {'port': configured}}), encoding='utf-8')
    source = (ROOT / 'scripts/gateway.ps1').read_text(encoding='utf-8-sig')
    bootstrap = source[:source.index('$StartupTimeout =')]
    root_literal = "'" + str(ROOT).replace("'", "''") + "'"
    bootstrap = bootstrap.replace('$Root = Split-Path -Parent $PSScriptRoot', '$Root = ' + root_literal)
    probe = tmp_path / 'port-probe.ps1'
    probe.write_text(bootstrap + '\nWrite-Output "PORT=$Port"\n', encoding='utf-8-sig')
    keep = {'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
            'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'}
    env = {key: value for key, value in os.environ.items() if key.upper() in keep}
    env.update(EASEL_PYTHON=sys.executable, EASEL_DATA_DIR=str(tmp_path / 'data'),
               EASEL_OPENCLAW_STATE_DIR=str(state), **overrides)
    result = subprocess.run([executable, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                             '-File', str(probe)], env=env, capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert f'PORT={expected}' in result.stdout
