"""Read-only status endpoints against synthetic files and process doubles."""
import ast
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def status_reader(tmp_path):
    source = ast.parse((ROOT / 'web/app.py').read_text(encoding='utf-8'))
    wanted = {'_login_status', '_mp_login_status'}
    module = ast.Module(body=[node for node in source.body
                             if isinstance(node, ast.FunctionDef) and node.name in wanted], type_ignores=[])
    env = {'json': json, 'LOGIN_DIR': tmp_path, 'LOGIN_PROCESSES': {}}
    exec(compile(module, str(ROOT / 'web/app.py'), 'exec'), env)
    return env


def read(env, platform):
    return env['_mp_login_status']() if platform == 'wechat-oa-mp' else env['_login_status'](platform)


@pytest.mark.parametrize('platform', ['xiaohongshu', 'wechat-oa-mp'])
@pytest.mark.parametrize('state', ['unknown', 'starting', 'qr_ready', 'scanned', 'sms_required', 'verifying'])
@pytest.mark.parametrize('code', [0, 1])
def test_exited_runner_cannot_leave_any_active_phase_polling(status_reader, platform, state, code):
    env = status_reader
    marker = env['LOGIN_DIR'] / f'{platform}.json'
    marker.write_text(json.dumps({'state': state, 'message': 'synthetic in-progress'}), encoding='utf-8')
    qr = env['LOGIN_DIR'] / f'{platform}.png'
    qr.write_bytes(b'synthetic QR')
    env['LOGIN_PROCESSES'][platform] = SimpleNamespace(poll=lambda: code)
    before = marker.read_bytes(), qr.read_bytes()

    result = read(env, platform)

    assert result['state'] == 'error' and f'退出码 {code}' in result['message']
    assert result['qr'] == '' and result['qrTs'] == 0
    assert (marker.read_bytes(), qr.read_bytes()) == before


@pytest.mark.parametrize('platform', ['xiaohongshu', 'wechat-oa-mp'])
@pytest.mark.parametrize('state', ['success', 'expired', 'error'])
def test_terminal_status_preserves_reason_but_never_exposes_stale_qr(status_reader, platform, state):
    env = status_reader
    (env['LOGIN_DIR'] / f'{platform}.json').write_text(
        json.dumps({'state': state, 'message': 'specific platform outcome'}), encoding='utf-8')
    (env['LOGIN_DIR'] / f'{platform}.png').write_bytes(b'stale QR')
    env['LOGIN_PROCESSES'][platform] = SimpleNamespace(poll=lambda: 1)

    result = read(env, platform)

    assert result['state'] == state and result['message'] == 'specific platform outcome'
    assert result['qr'] == ''


@pytest.mark.parametrize('platform', ['xiaohongshu', 'wechat-oa-mp'])
def test_live_runner_still_delivers_current_qr(status_reader, platform):
    env = status_reader
    (env['LOGIN_DIR'] / f'{platform}.json').write_text(json.dumps({'state': 'qr_ready'}), encoding='utf-8')
    (env['LOGIN_DIR'] / f'{platform}.png').write_bytes(b'current QR')
    env['LOGIN_PROCESSES'][platform] = SimpleNamespace(poll=lambda: None)
    result = read(env, platform)
    assert result['state'] == 'qr_ready' and result['qr'] == f'_login/{platform}.png'
    assert result['qrTs'] > 0
