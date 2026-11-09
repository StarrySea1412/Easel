import asyncio
import json
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

import web.app as web
from easel.harnesses.base import HarnessError, RunRequest
from easel.harnesses import qizhi, store


def make_request(tmp_path):
    return RunRequest('只回复 OK', tmp_path, {
        'CLOUDCLI_API_KEY': 'ck_test_secret', 'CLOUDCLI_MODEL': 'gpt-6-sol',
        'EASEL_DATA_DIR': str(tmp_path)}, session_key='local-session')


def mock_remote(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(qizhi.httpx, 'AsyncClient', lambda **kwargs:
                        original(transport=httpx.MockTransport(handler), **kwargs))


def invoke(request):
    events, bindings = [], []
    asyncio.run(qizhi.QizhiAdapter().run(request, lambda *event: events.append(event), None, bindings.append))
    return events, bindings


def success(session='remote-session', content='OK'):
    return httpx.Response(200, json={'success': True, 'sessionId': session,
        'providerSessionId': 'must-not-be-used',
        'messages': [{'kind': 'text', 'role': 'assistant', 'content': content}]})


def test_remote_protocol_and_continuation_use_application_session(tmp_path, monkeypatch):
    sent = []
    def handler(request):
        sent.append(json.loads(request.content))
        assert request.headers['X-API-Key'] == 'ck_test_secret'
        assert request.url.path == '/api/agent'
        return success()
    mock_remote(monkeypatch, handler)
    request = make_request(tmp_path)
    events, ids = invoke(request)
    assert events[-1] == ('token', 'OK')
    invoke(replace(request, native_id=ids[0]))
    assert 'sessionId' not in sent[0]
    assert sent[1]['sessionId'] == 'remote-session'
    assert sent[0]['provider'] == 'codex' and sent[0]['model'] == 'gpt-6-sol'
    assert sent[0]['stream'] is False
    assert all(sent[0][key] is False for key in ('createBranch', 'createPR', 'cleanup'))
    assert str(tmp_path) not in json.dumps(sent) and 'ck_test_secret' not in json.dumps(sent)
    assert not qizhi.pending(tmp_path / 'outputs', 'local-session')


def test_timeout_remains_unknown_and_prevents_resubmit(tmp_path, monkeypatch):
    attempts = []
    def handler(request):
        attempts.append(request)
        raise httpx.ReadTimeout('ck_test_secret')
    mock_remote(monkeypatch, handler)
    request = make_request(tmp_path)
    with pytest.raises(HarnessError, match='状态未知') as error:
        invoke(request)
    assert 'ck_test_secret' not in str(error.value)
    assert qizhi.pending(tmp_path / 'outputs', 'local-session')
    with pytest.raises(HarnessError, match='不要重复提交'):
        invoke(request)
    assert len(attempts) == 1
    marker = json.loads(qizhi.pending_path(tmp_path / 'outputs', 'local-session').read_text())
    assert marker['timeoutSeconds'] == request.timeout
    assert marker['startedAt'] > 0 and len(marker['localRequestId']) == 32
    assert 'ck_test_secret' not in json.dumps(marker)


@pytest.mark.parametrize('budget', [60, 1800, 7200])
def test_sync_response_wait_uses_turn_budget_without_three_minute_cap(tmp_path, monkeypatch, budget):
    def handler(request):
        timeout = request.extensions['timeout']
        assert timeout == {'connect': 10, 'read': budget, 'write': 30, 'pool': 10}
        return success()
    mock_remote(monkeypatch, handler)
    events, _ = invoke(replace(make_request(tmp_path), timeout=budget))
    assert events[-1] == ('token', 'OK')


@pytest.mark.parametrize('exception,label', [
    (httpx.ReadTimeout, '等待远端响应'),
    (httpx.ConnectTimeout, '连接 Qizhi 服务超时'),
    (httpx.WriteTimeout, '发送请求超时'),
    (httpx.PoolTimeout, '可用连接超时'),
    (httpx.ConnectError, '网络连接中断'),
])
def test_network_failures_explain_phase_without_leaking_secrets_or_retrying(tmp_path, monkeypatch, exception, label):
    attempts = []
    def handler(request):
        attempts.append(request)
        raise exception('ck_test_secret')
    mock_remote(monkeypatch, handler)
    request = make_request(tmp_path)
    with pytest.raises(HarnessError, match=label) as error:
        invoke(request)
    assert '状态未知' in str(error.value) and 'ck_test_secret' not in str(error.value)
    assert qizhi.pending(tmp_path / 'outputs', 'local-session')
    with pytest.raises(HarnessError, match='不要重复提交'):
        invoke(request)
    assert len(attempts) == 1


def test_cancelled_remote_request_keeps_unknown_fence(tmp_path, monkeypatch):
    async def handler(request):
        raise asyncio.CancelledError
    mock_remote(monkeypatch, handler)
    with pytest.raises(asyncio.CancelledError):
        invoke(make_request(tmp_path))
    assert qizhi.pending(tmp_path / 'outputs', 'local-session')


def test_reject_does_not_echo_upstream_secret_and_does_not_follow_redirect(tmp_path, monkeypatch):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(302, headers={'Location': 'https://other.example/'}, text='ck_test_secret')
    mock_remote(monkeypatch, handler)
    with pytest.raises(HarnessError, match='HTTP 302') as error:
        invoke(make_request(tmp_path))
    assert 'ck_test_secret' not in str(error.value) and len(calls) == 1


def test_success_requires_text_and_correct_session(tmp_path, monkeypatch):
    mock_remote(monkeypatch, lambda request: success(content=''))
    with pytest.raises(HarnessError, match='没有助手文本'):
        invoke(make_request(tmp_path))
    assert not qizhi.pending(tmp_path / 'outputs', 'local-session')


def test_session_cannot_move_between_credentials(tmp_path, monkeypatch):
    mock_remote(monkeypatch, lambda request: success())
    request = make_request(tmp_path)
    _, ids = invoke(request)
    with pytest.raises(HarnessError, match='不匹配'):
        invoke(replace(request, native_id=ids[0], env={**request.env, 'CLOUDCLI_API_KEY': 'changed'}))


def test_explicit_failure_without_session_is_confirmed(tmp_path, monkeypatch):
    mock_remote(monkeypatch, lambda req: httpx.Response(200, json={
        'success': False, 'error': 'ck_test_secret'}))
    with pytest.raises(HarnessError, match='失败终态') as error:
        invoke(make_request(tmp_path))
    assert 'ck_test_secret' not in str(error.value)
    assert not qizhi.pending(tmp_path / 'outputs', 'local-session')


@pytest.fixture
def site(tmp_path, monkeypatch):
    for key in ('EASEL_AGENT_RUNTIME', 'CLOUDCLI_BASE_URL', 'CLOUDCLI_PROJECT_PATH', 'CLOUDCLI_MODEL', 'CLOUDCLI_API_KEY'):
        monkeypatch.delenv(key, raising=False)
    env = tmp_path / '.env'
    env.write_text('')
    monkeypatch.setattr(web, 'ENV_FILE', env)
    monkeypatch.setattr(web, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path / 'outputs')
    monkeypatch.setattr(web, 'PROJECT_ROOT', tmp_path)
    monkeypatch.setattr(web, 'SESSIONS_DIR', tmp_path / 'outputs' / '_sessions')
    for name in ('_BG_TASKS', '_HARNESS_TASKS', '_DIRECT_CHAT_TASKS'):
        monkeypatch.setattr(web, name, set())
    monkeypatch.setattr(web, '_RUNNING_CHAT', {})
    monkeypatch.setattr(web.harnesses, 'describe', lambda runtime: {'id': runtime, 'installed': True})
    with TestClient(web.app, base_url='http://127.0.0.1:7860', headers={'Origin': 'http://127.0.0.1:7860'}) as client:
        yield client


def test_web_configuration_masks_key_preserves_others_and_selects_explicitly(site):
    web.ENV_FILE.write_text('KEEP=unchanged\n')
    values = {'baseUrl': qizhi.DEFAULT_BASE, 'projectPath': qizhi.DEFAULT_PROJECT,
              'model': qizhi.DEFAULT_MODEL, 'apiKey': 'ck_test_secret'}
    response = site.post('/api/settings/qizhi', json=values)
    assert response.status_code == 200 and response.json()['configured']
    assert 'ck_test_secret' not in response.text and 'ck_test_secret' not in site.get('/api/settings/qizhi').text
    assert 'KEEP=unchanged' in web.ENV_FILE.read_text()
    assert not (web.OUTPUTS_DIR / '_harness' / 'config.json').exists()
    assert site.post('/api/settings/qizhi', json={k: v for k, v in values.items() if k != 'apiKey'}).status_code == 200
    result = site.post('/api/settings/harness', json={'runtime': 'qizhi'})
    assert result.status_code == 200 and result.json()['models']['qizhi'] == 'gpt-6-sol'


def test_remote_chat_does_not_upload_local_skills(site):
    from web import alternate_chat
    config = {'models': {'qizhi': 'gpt-6-sol'}}
    request = web.ChatRequest(message='hello', sessionId='session', selectedSkills=['card-xiaohongshu'])
    with pytest.raises(web.HTTPException) as error:
        asyncio.run(alternate_chat.start(web, request, 'qizhi', config))
    assert error.value.status_code == 409
    assert not (web.OUTPUTS_DIR / '_sessions' / 'runs').exists()


def test_remote_endpoint_change_requires_explicit_new_key(site):
    values = {'baseUrl': qizhi.DEFAULT_BASE, 'projectPath': qizhi.DEFAULT_PROJECT,
              'model': qizhi.DEFAULT_MODEL, 'apiKey': 'ck_test_secret'}
    assert site.post('/api/settings/qizhi', json=values).status_code == 200
    values.pop('apiKey')
    values['baseUrl'] = 'https://different.example'
    assert site.post('/api/settings/qizhi', json=values).status_code == 400


@pytest.mark.parametrize('timeout', [False, True, 'deadline'])
def test_web_chat_terminal_receipt_and_remote_unknown(site, monkeypatch, timeout):
    async def handler(request):
        if timeout == 'deadline':
            await asyncio.sleep(1)
        if timeout:
            raise httpx.ReadTimeout('ck_test_secret')
        return success(content='QIZHI_WEB_TEST_OK')
    mock_remote(monkeypatch, handler)
    if timeout == 'deadline':
        original = web._run_harness_chat
        async def timed(*args, **kwargs):
            return await original(*args, **kwargs, timeout=0.01)
        monkeypatch.setattr(web, '_run_harness_chat', timed)
    assert site.post('/api/settings/qizhi', json={
        'baseUrl': qizhi.DEFAULT_BASE, 'projectPath': qizhi.DEFAULT_PROJECT,
        'model': qizhi.DEFAULT_MODEL, 'apiKey': 'ck_test_secret'}).status_code == 200
    assert site.post('/api/settings/harness', json={'runtime': 'qizhi'}).status_code == 200
    result = site.post('/api/chat/stream', json={
        'message': 'reply OK', 'sessionId': 'qizhi-web-session', 'turnId': 'qizhi-web-turn'})
    assert result.status_code == 200
    record = web.run_ledger.read(web._run_ledger_root(), 'qizhi-web-turn')
    assert 'ck_test_secret' not in result.text
    if timeout:
        assert record['status'] == 'unknown'
        assert not record['settled'] and not record['resourceSettled']
        assert 'event: recovery_required' in result.text
        if timeout == 'deadline':
            assert 'Qizhi 等待超过本轮 0.01 秒上限' in result.text
            assert '已终止本轮进程' not in result.text
    else:
        assert 'QIZHI_WEB_TEST_OK' in result.text and 'event: done' in result.text
        assert record['status'] == 'completed' and record['settled'] and record['resourceSettled']
        assert record['completionReceipt']['runtime'] == 'qizhi'
