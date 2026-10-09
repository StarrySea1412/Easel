"""In-process login API checks with synthetic files; never starts a browser or connects to a platform."""
import ast
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parents[1]
OTHER_PLATFORMS = ['kuaishou', 'weixin-channels', 'zhihu', 'bilibili', 'douyin', 'wechat-oa']


class Process:
    def __init__(self, args):
        self.args = list(args)
        self.returncode = None

    def poll(self):
        return self.returncode

    def wait(self, timeout):
        assert timeout == 5
        if self.returncode is None:
            raise RuntimeError('fixture still running')
        return self.returncode


@pytest.fixture
def login_api(tmp_path):
    source = ast.parse((ROOT / 'web/app.py').read_text(encoding='utf-8'))
    names = {'api_login_start', 'api_login_status', '_login_status',
             '_require_account_available', '_account_browser_busy', '_restart_owned_login',
             'api_mp_login_start', '_mp_login_status'}
    nodes = [node for node in source.body
             if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    assert {node.name for node in nodes} == names
    runners = next(node.value for node in source.body
                   if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)
                   and node.target.id == 'LOGIN_RUNNERS')
    app = FastAPI()
    env = {
        'app': app, 'HTTPException': HTTPException, 'json': json, 'os': os, 'sys': sys,
        'LOGIN_RUNNERS': ast.literal_eval(runners), 'LOGIN_TIMEOUT': 240,
        'LOGIN_DIR': tmp_path / 'login', 'LOGIN_PROCESSES': {},
        'SHARED_SCRIPTS': tmp_path / 'scripts', 'DATA_DIR': tmp_path / 'data', 'PROJECT_ROOT': tmp_path,
        '_PUBLISH_LOCK': threading.RLock(), '_PUBLISH_ACTIVE': {}, '_ACCOUNT_CLEARING': set(),
        '_WHOAMI_LOCK': threading.Lock(), '_WHOAMI_CACHE': {}, '_WHOAMI_PROCESSES': {},
        '_invalidate_account_check': Mock(), '_account_check_generation': Mock(return_value='isolated-generation'),
        'invalidate_account_context': Mock(), '_proxy_env': lambda: {}, '_wechat_has_credentials': lambda: False,
        'asyncio': SimpleNamespace(sleep=AsyncMock(), to_thread=asyncio.to_thread),
    }

    def spawn(args, **_kwargs):
        # The runner substitute supplies an immediate QR result using only this
        # fixture's files. No executable or real credential directory is opened.
        status = Path(args[args.index('--status-file') + 1])
        qr = Path(args[args.index('--qr-out') + 1])
        assert status.parent == qr.parent == env['LOGIN_DIR']
        status.write_text(json.dumps({'state': 'qr_ready', 'message': 'offline fixture'}), encoding='utf-8')
        qr.write_bytes(b'synthetic QR')
        return Process(args)

    popen = Mock(side_effect=spawn)
    env['subprocess'] = SimpleNamespace(
        Popen=popen, STDOUT=subprocess.STDOUT,
        SubprocessError=subprocess.SubprocessError,
        CREATE_NEW_PROCESS_GROUP=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0),
        CREATE_NO_WINDOW=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(ROOT / 'web/app.py'), 'exec'), env)
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, env=env, popen=popen)


@pytest.mark.parametrize('params,expected', [({}, False), ({'visibleBrowser': 'false'}, False),
                                           ({'visibleBrowser': 'true'}, True)])
def test_xhs_query_selects_runner_mode_and_status_reports_it(login_api, params, expected):
    response = login_api.client.post('/api/login/xiaohongshu', params=params)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['mode'] == 'qr' and data['state'] == 'qr_ready'
    assert data['visibleBrowser'] is expected
    login_api.popen.assert_called_once()
    command = login_api.popen.call_args.args[0]
    assert command[:3] == [sys.executable, str(login_api.env['SHARED_SCRIPTS'] / 'xhs_publish.py'), 'login']
    assert '--no-proxy' in command
    assert command.count('--headed') == int(expected)
    status = login_api.client.get('/api/login/xiaohongshu/status')
    assert status.status_code == 200 and status.json()['visibleBrowser'] is expected


@pytest.mark.parametrize('platform', OTHER_PLATFORMS)
def test_visible_browser_rejects_other_platforms_before_any_launch_or_state_change(login_api, platform):
    response = login_api.client.post(f'/api/login/{platform}', params={'visibleBrowser': 'true'})
    assert response.status_code == 400, response.text
    login_api.popen.assert_not_called()
    assert login_api.env['LOGIN_PROCESSES'] == {}
    assert not login_api.env['LOGIN_DIR'].exists()
    login_api.env['_invalidate_account_check'].assert_not_called()
    login_api.env['invalidate_account_context'].assert_not_called()


@pytest.mark.parametrize('platform', OTHER_PLATFORMS)
def test_other_platform_default_requests_keep_the_existing_login_mode(login_api, platform):
    response = login_api.client.post(f'/api/login/{platform}')
    assert response.status_code == 200, response.text
    if platform == 'wechat-oa':
        assert response.json()['mode'] == 'credentials'
        login_api.popen.assert_not_called()
    else:
        assert response.json()['mode'] == 'qr'
        assert response.json()['visibleBrowser'] is False
        login_api.popen.assert_called_once()
        assert '--headed' not in login_api.popen.call_args.args[0]


@pytest.mark.parametrize('running_visible,requested_visible', [(False, False), (False, True), (True, False), (True, True)])
def test_repeated_requests_reuse_the_child_and_report_its_actual_mode(login_api, running_visible, requested_visible):
    first = login_api.client.post('/api/login/xiaohongshu', params={'visibleBrowser': str(running_visible).lower()})
    assert first.status_code == 200, first.text
    proc = login_api.env['LOGIN_PROCESSES']['xiaohongshu']
    marker = login_api.env['LOGIN_DIR'] / 'xiaohongshu.json'
    marker.write_text(json.dumps({'state': 'scanned', 'message': 'waiting for confirmation'}), encoding='utf-8')
    qr = login_api.env['LOGIN_DIR'] / 'xiaohongshu.png'
    before = marker.read_bytes(), qr.read_bytes()
    invalidations = login_api.env['_invalidate_account_check'].call_count
    context_invalidations = login_api.env['invalidate_account_context'].call_count

    repeat = login_api.client.post('/api/login/xiaohongshu', params={'visibleBrowser': str(requested_visible).lower()})

    assert repeat.status_code == 200, repeat.text
    assert repeat.json()['state'] == 'scanned'
    assert repeat.json()['visibleBrowser'] is running_visible
    assert login_api.env['LOGIN_PROCESSES']['xiaohongshu'] is proc
    login_api.popen.assert_called_once()
    assert (marker.read_bytes(), qr.read_bytes()) == before
    assert login_api.env['_invalidate_account_check'].call_count == invalidations
    assert login_api.env['invalidate_account_context'].call_count == context_invalidations
    status = login_api.client.get('/api/login/xiaohongshu/status')
    assert status.status_code == 200 and status.json()['visibleBrowser'] is running_visible


@pytest.mark.parametrize('args,expected', [([], False), (['python', 'login', '--headed'], True),
                                        (['python', 'login', '--headed=false'], False)])
@pytest.mark.parametrize('returncode', [None, 1])
def test_status_uses_the_exact_child_flag_even_after_runner_exit(login_api, args, expected, returncode):
    process = Process(args)
    process.returncode = returncode
    login_api.env['LOGIN_PROCESSES']['xiaohongshu'] = process
    response = login_api.client.get('/api/login/xiaohongshu/status')
    assert response.status_code == 200, response.text
    assert response.json()['visibleBrowser'] is expected
    if returncode is not None:
        assert response.json()['state'] == 'error'
    login_api.popen.assert_not_called()


@pytest.mark.parametrize('process', [None, SimpleNamespace(poll=lambda: None)])
def test_status_without_known_child_arguments_does_not_claim_a_visible_browser(login_api, process):
    if process is not None:
        login_api.env['LOGIN_PROCESSES']['xiaohongshu'] = process
    response = login_api.client.get('/api/login/xiaohongshu/status')
    assert response.status_code == 200, response.text
    assert response.json()['visibleBrowser'] is False
    login_api.popen.assert_not_called()


def test_invalid_query_boolean_is_rejected_without_a_process(login_api):
    response = login_api.client.post('/api/login/xiaohongshu', params={'visibleBrowser': 'invalid'})
    assert response.status_code == 422
    login_api.popen.assert_not_called()


def test_explicit_reconnect_replaces_only_registered_login_and_preserves_other_platform(monkeypatch, login_api):
    import easel.install_runner

    assert login_api.client.post('/api/login/xiaohongshu').status_code == 200
    assert login_api.client.post('/api/login/zhihu').status_code == 200
    old = login_api.env['LOGIN_PROCESSES']['xiaohongshu']
    other = login_api.env['LOGIN_PROCESSES']['zhihu']
    stopped = []

    def terminate(process):
        stopped.append(process)
        process.returncode = 0

    monkeypatch.setattr(easel.install_runner, 'terminate_phase_tree', terminate)
    response = login_api.client.post('/api/login/xiaohongshu', params={'restart': 'true', 'visibleBrowser': 'true'})
    assert response.status_code == 200 and response.json()['visibleBrowser'] is True
    assert stopped == [old]
    assert login_api.env['LOGIN_PROCESSES']['xiaohongshu'] is not old
    assert login_api.env['LOGIN_PROCESSES']['zhihu'] is other and other.poll() is None
    assert login_api.popen.call_count == 3


def test_reconnect_during_whoami_preserves_both_processes_and_old_marker(monkeypatch, login_api):
    import easel.install_runner

    assert login_api.client.post('/api/login/xiaohongshu').status_code == 200
    old = login_api.env['LOGIN_PROCESSES']['xiaohongshu']
    marker = login_api.env['LOGIN_DIR'] / 'xiaohongshu.json'
    before = marker.read_bytes()
    whoami = Process(['fixture-whoami'])
    login_api.env['_WHOAMI_PROCESSES']['xiaohongshu'] = [whoami]
    stop = Mock()
    monkeypatch.setattr(easel.install_runner, 'terminate_phase_tree', stop)
    response = login_api.client.post('/api/login/xiaohongshu', params={'restart': 'true'})
    assert response.status_code == 409
    stop.assert_not_called()
    assert login_api.env['LOGIN_PROCESSES']['xiaohongshu'] is old and old.poll() is None
    assert whoami.poll() is None and marker.read_bytes() == before
    login_api.popen.assert_called_once()


def test_failed_reconnect_does_not_spawn_another_writer_or_delete_marker(monkeypatch, login_api):
    import easel.install_runner

    assert login_api.client.post('/api/login/xiaohongshu').status_code == 200
    old = login_api.env['LOGIN_PROCESSES']['xiaohongshu']
    marker = login_api.env['LOGIN_DIR'] / 'xiaohongshu.json'
    before = marker.read_bytes()
    monkeypatch.setattr(easel.install_runner, 'terminate_phase_tree', Mock(side_effect=OSError('offline stop failure')))
    response = login_api.client.post('/api/login/xiaohongshu', params={'restart': 'true'})
    assert response.status_code == 500
    assert login_api.env['LOGIN_PROCESSES']['xiaohongshu'] is old and marker.read_bytes() == before
    login_api.popen.assert_called_once()


def test_mp_reconnect_replaces_registered_mp_login(monkeypatch, login_api):
    import easel.install_runner

    route = '/api/accounts/wechat-oa/mp-login'
    assert login_api.client.post(route).status_code == 200
    old = login_api.env['LOGIN_PROCESSES']['wechat-oa-mp']

    def terminate(process):
        assert process is old
        process.returncode = 0

    monkeypatch.setattr(easel.install_runner, 'terminate_phase_tree', terminate)
    response = login_api.client.post(route, params={'restart': 'true'})
    assert response.status_code == 200
    assert login_api.env['LOGIN_PROCESSES']['wechat-oa-mp'] is not old
    assert login_api.popen.call_count == 2


def test_slow_reconnect_keeps_event_loop_responsive_and_reserves_same_account(monkeypatch, login_api):
    import easel.install_runner

    assert login_api.client.post('/api/login/xiaohongshu').status_code == 200
    entered, release = threading.Event(), threading.Event()

    def terminate(process):
        entered.set()
        assert release.wait(5)
        process.returncode = 0

    monkeypatch.setattr(easel.install_runner, 'terminate_phase_tree', terminate)
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(login_api.client.post, '/api/login/xiaohongshu', params={'restart': 'true'})
        try:
            assert entered.wait(5)
            # Other platforms remain usable while taskkill/wait is running.
            other = pool.submit(login_api.client.post, '/api/login/zhihu').result(timeout=2)
            assert other.status_code == 200
            assert login_api.client.post('/api/login/xiaohongshu').status_code == 409
            assert login_api.client.post('/api/login/xiaohongshu', params={'restart': 'true'}).status_code == 409
            with pytest.raises(HTTPException) as busy:
                login_api.env['_require_account_available']('xiaohongshu')
            assert busy.value.status_code == 409
        finally:
            release.set()
        assert pending.result(timeout=5).status_code == 200
    assert login_api.env['_ACCOUNT_CLEARING'] == set()


def test_reconnect_is_rejected_before_stopping_login_during_active_publish(monkeypatch, login_api):
    import easel.install_runner

    assert login_api.client.post('/api/login/xiaohongshu').status_code == 200
    old = login_api.env['LOGIN_PROCESSES']['xiaohongshu']
    login_api.env['_PUBLISH_ACTIVE']['xiaohongshu'] = 'fixture-publish'
    stop = Mock()
    monkeypatch.setattr(easel.install_runner, 'terminate_phase_tree', stop)
    assert login_api.client.post('/api/login/xiaohongshu', params={'restart': 'true'}).status_code == 409
    stop.assert_not_called()
    assert login_api.env['LOGIN_PROCESSES']['xiaohongshu'] is old
