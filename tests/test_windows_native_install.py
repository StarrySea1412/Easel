"""Actual phased setup functions, isolated settings and no tool installation."""
import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from tests.test_install_runner import _ps_functions, _ps_literal

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which('powershell.exe'), reason='Windows PowerShell required')
@pytest.mark.parametrize('existing', [False, True])
def test_native_phases_never_call_openclaw_and_keep_user_selection(tmp_path, existing):
    env_file = tmp_path / '.env'
    original = b'OPENAI_API_KEY=isolated-placeholder\n'
    env_file.write_bytes(original)
    config = tmp_path / 'outputs/_harness/config.json'
    if existing:
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({'runtime': 'codex', 'models': {'codex': 'fixture-model'}}), encoding='utf-8')
    wrapper = tmp_path / 'python-probe.ps1'
    wrapper.write_text('param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)\n'
        "if ($Arguments -contains '--verify-web') { Write-Output 'WEB_VERIFIER_BOUNDARY'; $global:LASTEXITCODE=0; return }\n"
        + '& ' + _ps_literal(sys.executable) + ' @Arguments\n$global:LASTEXITCODE=$LASTEXITCODE\n', encoding='utf-8-sig')
    body = "$ErrorActionPreference='Stop'\n$SkipOpenClaw=$true\n$NonInteractive=$true\n"
    body += f'$Root={_ps_literal(ROOT)}\n$DataDir={_ps_literal(tmp_path)}\n$Python={_ps_literal(wrapper)}\n'
    body += "function openclaw { throw 'OpenClaw must not execute' }\n"
    body += "function npm { throw 'OpenClaw must not install' }\n"
    body += "function Read-Host { throw 'non-interactive input forbidden' }\n"
    body += 'Invoke-openclaw\nInvoke-profile\nInvoke-skills\nInvoke-gateway\n'
    result = _ps_functions(body)
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'WEB_VERIFIER_BOUNDARY' in result.stdout
    assert env_file.read_bytes() == original
    selected = json.loads(config.read_text(encoding='utf-8'))
    assert selected['runtime'] == ('codex' if existing else 'api')
    if existing:
        assert selected['models'] == {'codex': 'fixture-model'}
    assert not (tmp_path / 'gateway-installation.json').exists()


@pytest.mark.skipif(not shutil.which('powershell.exe'), reason='Windows PowerShell required')
def test_conflicting_windows_choices_fail_before_bootstrap(tmp_path):
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', str(ROOT / 'setup.ps1'), '-SkipOpenClaw', '-OpenClaw', '-DataDir', str(tmp_path / 'untouched')],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=15)
    assert result.returncode != 0 and '不能同时指定' in result.stdout + result.stderr
    assert not (tmp_path / 'untouched').exists()
