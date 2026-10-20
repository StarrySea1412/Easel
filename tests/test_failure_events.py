import json

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from easel.server_access import AccessStore, ServerAccessMiddleware, password_hash
from web.clawhub import ClawHubClient
from web.clawhub_import import SkillImporter, ImportRequest
from web.failure_events import FailureEvents, FailureEventMiddleware, HEADER, create_router


def fixture_app(tmp_path, upstream=None):
    events = FailureEvents(tmp_path)
    app = FastAPI()
    app.include_router(create_router(events))
    app.add_middleware(FailureEventMiddleware, events=events)
    if upstream:
        importer = SkillImporter(tmp_path, tmp_path / 'bundled', ClawHubClient(transport=httpx.MockTransport(upstream)))

        @app.post('/api/clawhub/skills/{slug}/import')
        async def install(slug: str, body: ImportRequest):
            return await importer.import_skill(slug, body.owner, body.version)
    return app, events


def test_llm_failure_is_safe_durable_and_deduplicated(tmp_path):
    events = FailureEvents(tmp_path)
    error = {'code': 'model_rate_limited', 'stage': 'model_response',
             'modelRef': 'relay/gpt-test', 'channel': 'relay',
             'message': 'PRIVATE_PROMPT', 'detail': 'api_key=PRIVATE_KEY',
             'channelEndpoint': 'https://PRIVATE_HOST'}
    event_id = events.record_chat(turn_id='turn-1', session_id='chat-1', error=error)
    assert events.record_chat(turn_id='turn-1', error=error) == event_id
    row, = FailureEvents(tmp_path).recent()
    assert row['id'] == event_id and row['operation'] == 'chat'
    assert row['status'] == 200 and row['code'] == 'model_rate_limited'
    assert row['modelRef'] == 'relay/gpt-test' and row['channel'] == 'relay'
    assert row['sessionId'] == 'chat-1' and row['turnId'] == 'turn-1'
    assert 'PRIVATE' not in events.path.read_text()


def test_llm_history_backfill_uses_explicit_failures_and_original_time(tmp_path):
    events = FailureEvents(tmp_path)
    root = tmp_path / 'sessions'
    (root / 'runs').mkdir(parents=True)
    older = '2026-10-20T00:00:00+00:00'
    (root / 'latest.json').write_text(json.dumps({'status': 'done', 'turn_id': 'failed-turn',
        'at': older, 'error': {'code': 'model_stream_interrupted', 'stage': 'model_response'},
        'requestedModelRef': 'relay/model', 'text': 'PRIVATE'}))
    for turn, status, stop, error in [('failed-turn', 'failed', None, {'code': 'model_stream_interrupted'}),
            ('stopped', 'stopped', 'user_stopped', {'code': 'agent_request_aborted'}),
            ('still-running', 'running', None, {'code': 'gateway_timeout'}),
            ('success', 'completed', None, None), ('uncertain', 'failed', None, None)]:
        (root / 'runs' / (turn + '.json')).write_text(json.dumps({'turnId': turn, 'sessionId': 'session',
            'status': status, 'stopReason': stop, 'error': error, 'terminalAt': older}))
    (root / 'malformed.json').write_text('broken')
    events.record(source='server', route='/api/new', method='GET', status=500, duration=1, context={})
    app = FastAPI()
    app.include_router(create_router(events, lambda: root))
    client = TestClient(app)
    rows = client.get('/api/diagnostics/failures').json()['events']
    assert len(rows) == 2 and rows[0]['route'] == '/api/new'
    row = rows[1]
    assert row['at'] == older and row['turnId'] == 'failed-turn'
    assert row['stage'] == 'model_response' and row['modelRef'] == 'relay/model'
    assert row['sessionId'] == 'session'
    assert client.get('/api/diagnostics/failures').json()['events'] == rows
    assert 'PRIVATE' not in events.path.read_text()


def test_failed_download_records_pinned_identity_stage_and_safe_upstream_status(tmp_path):
    def upstream(request):
        if request.url.path.endswith('/download'):
            assert request.url.params['ownerHandle'] == 'alice'
            return httpx.Response(409, text='PRIVATE upstream raw payload secret=do-not-save')
        return httpx.Response(200, json={'skill': {'slug': 'research'}, 'owner': {'handle': 'alice'},
            'latestVersion': {'version': '1.2.3'}})
    app, events = fixture_app(tmp_path, upstream)
    client = TestClient(app)
    response = client.post('/api/clawhub/skills/research/import?key=do-not-save',
        json={'owner': 'alice', 'version': '1.2.3'}, headers={'Authorization': 'Bearer do-not-save'})
    assert response.status_code == 409
    event_id = response.headers[HEADER]
    event, = client.get('/api/diagnostics/failures', params={'eventId': event_id}).json()['events']
    assert (event['source'], event['stage'], event['code']) == ('server', 'download', 'download_identity_conflict')
    assert (event['owner'], event['slug'], event['skillVersion'], event['upstreamStatus']) == ('alice', 'research', '1.2.3', 409)
    assert event['route'] == '/api/clawhub/skills/{slug}/import'
    assert event['durationMs'] >= 0 and event['version']
    assert 'do-not-save' not in events.path.read_text()


def test_unhandled_exception_is_safe_and_successful_stream_is_unchanged(tmp_path):
    from starlette.responses import StreamingResponse
    app, events = fixture_app(tmp_path)

    @app.get('/api/private/{name}')
    async def fail(name: str):
        raise RuntimeError('do-not-save ' + name)

    @app.get('/api/stream')
    async def stream():
        async def chunks():
            yield b'first\n'
            yield b'second\n'
        return StreamingResponse(chunks(), media_type='text/event-stream')

    client = TestClient(app)
    assert client.get('/api/stream').content == b'first\nsecond\n'
    assert events.recent() == []
    response = client.get('/api/private/do-not-save')
    assert response.status_code == 500 and 'do-not-save' not in response.text
    event, = events.recent()
    assert event['exceptionType'] == 'RuntimeError' and event['code'] == 'unhandled_exception'
    assert event['id'] == response.headers[HEADER]
    assert 'do-not-save' not in events.path.read_text()


def test_journal_failure_never_masks_original_error_or_claims_saved_id(tmp_path, monkeypatch):
    app, events = fixture_app(tmp_path)

    @app.get('/api/fail')
    async def fail():
        raise HTTPException(409, 'original failure')

    def denied(*args, **kwargs):
        raise PermissionError('do-not-save')
    monkeypatch.setattr('web.failure_events.os.open', denied)
    response = TestClient(app).get('/api/fail')
    assert response.status_code == 409 and response.json()['detail'] == 'original failure'
    assert HEADER not in response.headers


def test_callback_and_query_require_existing_server_auth_and_reject_extra_data(tmp_path):
    app, events = fixture_app(tmp_path)
    access = tmp_path / 'access.json'
    access.write_text(json.dumps({'sessionKey': 'ab' * 32, 'environment': 'isolated-test',
        'users': {'gaojitest': password_hash('gaoji')}}))
    app.add_middleware(ServerAccessMiddleware, store=AccessStore(access),
        origins=['http://testserver'], test_mode=True)
    client = TestClient(app, follow_redirects=False)
    assert client.get('/api/diagnostics/failures').status_code == 401
    assert client.post('/api/diagnostics/failures', json={}).status_code == 401
    assert client.post('/login', headers={'Origin': 'http://testserver'},
        data={'username': 'gaojitest', 'password': 'gaoji'}).status_code == 303
    body = {'operation': 'clawhub_import', 'stage': 'catalog_verify', 'code': 'catalog_missing',
        'slug': 'research', 'relatedEventId': 'a' * 32}
    assert client.post('/api/diagnostics/failures', json=body).status_code == 403
    response = client.post('/api/diagnostics/failures', json=body, headers={'Origin': 'http://testserver'})
    assert response.status_code == 201
    event, = client.get('/api/diagnostics/failures').json()['events']
    assert event['id'] == response.json()['eventId'] and event['source'] == 'browser'
    assert event['relatedEventId'] == 'a' * 32
    assert client.post('/api/diagnostics/failures', json={**body, 'message': 'do-not-save'},
        headers={'Origin': 'http://testserver'}).status_code == 422
    assert 'do-not-save' not in events.path.read_text()
    assert client.get('/api/diagnostics/failures?limit=101').status_code == 422


def test_rotation_and_client_admission_bound_storage(tmp_path, monkeypatch):
    monkeypatch.setattr('web.failure_events.MAX_BYTES', 800)
    events = FailureEvents(tmp_path)
    for _ in range(35):
        assert events.record(source='server', route='/api/fail', method='GET', status=502,
            duration=10, context={'code': 'test', 'secret': 'do-not-save'})
    paths = list(events.directory.iterdir())
    assert len(paths) == 4 and all(p.stat().st_size <= 800 for p in paths)
    assert len(events.recent(2)) == 2
    assert all(events.admit_client() for _ in range(60))
    assert not events.admit_client()


@pytest.mark.parametrize('storage_error', [False, True])
def test_archive_and_storage_failure_stages_are_distinct(tmp_path, monkeypatch, storage_error):
    import io
    import zipfile
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as output:
        output.writestr('SKILL.md', '# Research')
    if storage_error:
        def denied(*args):
            raise PermissionError('do-not-save')
        monkeypatch.setattr(SkillImporter, 'store', denied)
    def upstream(request):
        if request.url.path.endswith('/download'):
            return httpx.Response(200, content=archive.getvalue() if storage_error else b'not-a-zip',
                headers={'Content-Type': 'application/zip'})
        return httpx.Response(200, json={'skill': {'slug': 'research'}, 'owner': {'handle': 'alice'},
            'latestVersion': {'version': '1.2.3'}})
    app, events = fixture_app(tmp_path, upstream)
    response = TestClient(app).post('/api/clawhub/skills/research/import', json={'owner': 'alice', 'version': '1.2.3'})
    assert response.status_code == (503 if storage_error else 400)
    event, = events.recent()
    assert event['stage'] == ('save' if storage_error else 'archive_validation')
    assert event['code'] == ('storage_unavailable' if storage_error else 'archive_unreadable')
    assert event['upstreamStatus'] == 200 and event['upstreamType'] == 'application/zip'

@pytest.mark.parametrize('platform', ['xiaohongshu', 'douyin', 'kuaishou', 'weixin-channels', 'zhihu', 'bilibili', 'wechat-oa'])
def test_publish_callback_records_only_platform_stage_and_receipt(tmp_path, platform):
    app, events = fixture_app(tmp_path)
    client = TestClient(app)
    body = {'operation': 'publish', 'platform': platform, 'stage': 'receipt',
            'code': 'publish_failed', 'receiptId': 'a' * 32}
    result = client.post('/api/diagnostics/failures', json=body)
    assert result.status_code == 201
    event, = events.recent()
    assert event['id'] == result.json()['eventId']
    assert (event['route'], event['platform'], event['receiptId']) == ('publish_ui', platform, 'a' * 32)
    for extra in [{'message': 'PRIVATE'}, {'title': 'PRIVATE'}, {'media': ['PRIVATE']},
                  {'slug': 'skill'}, {'stage': 'catalog_verify'}, {'platform': 'untrusted'}]:
        assert client.post('/api/diagnostics/failures', json={**body, **extra}).status_code == 422
    assert 'PRIVATE' not in events.path.read_text()


@pytest.mark.parametrize('stage,code', [('module_load', 'module_load_failed'), ('render', 'render_failed')])
def test_page_failure_callback_keeps_safe_stage_asset_and_ui_version(tmp_path, stage, code):
    app, events = fixture_app(tmp_path)
    client = TestClient(app)
    body = {'operation': 'page_load', 'page': 'accounts', 'stage': stage, 'code': code,
            'exceptionType': 'TypeError', 'asset': 'assets/AccountsPage-abc123.js:123:45', 'uiVersion': '0.6.2'}
    result = client.post('/api/diagnostics/failures', json=body)
    assert result.status_code == 201
    event, = events.recent()
    assert event['id'] == result.json()['eventId']
    assert (event['route'], event['page'], event['stage'], event['uiVersion']) == ('page_load_ui', 'accounts', stage, '0.6.2')
    assert event['asset'] == body['asset'] and event['exceptionType'] == 'TypeError'
    for extra in [{'message': 'PRIVATE'}, {'stack': 'PRIVATE'}, {'page': 'PRIVATE'}, {'asset': 'https://private/path?token=PRIVATE'},
                  {'platform': 'zhihu'}, {'stage': 'identity'}, {'code': 'network'}, {'uiVersion': 'PRIVATE'}, {'exceptionType': 'PRIVATE'}]:
        assert client.post('/api/diagnostics/failures', json={**body, **extra}).status_code == 422
    assert 'PRIVATE' not in events.path.read_text()

def test_codex_terminal_failures_share_diagnostic_store_and_exclude_interrupt(tmp_path):
    from easel.codex_service import CodexService
    service = CodexService(tmp_path / 'outputs')
    service.failure_events = FailureEvents(tmp_path)
    state = {'sessionId': 'codex-session', 'turn_id': 'codex-turn', 'status': 'done',
             'outcome': 'failed', 'error': {'message': 'timeout PRIVATE'}, 'requestedModelRef': 'codex/gpt-test'}
    service._persist(state)
    row, = service.failure_events.recent()
    assert row['code'] == 'gateway_timeout' and row['id'] == state['error']['failureEventId']
    assert row['modelRef'] == 'codex/gpt-test'
    service._persist(state)
    service._persist({**state, 'turn_id': 'stopped-turn', 'outcome': 'interrupted'})
    assert len(service.failure_events.recent()) == 1
    assert 'PRIVATE' not in service.failure_events.path.read_text()

def test_llm_recording_failure_does_not_claim_a_saved_receipt(tmp_path, monkeypatch):
    events = FailureEvents(tmp_path)
    def denied(*args, **kwargs):
        raise PermissionError('PRIVATE')
    monkeypatch.setattr('web.failure_events.os.open', denied)
    assert events.record_chat(turn_id='turn', error={'code': 'gateway_timeout'}) is None
    assert events.recent() == []


def test_historical_classification_does_not_store_provider_response(tmp_path):
    events = FailureEvents(tmp_path)
    events.record_chat(turn_id='old-turn', error={'code': 'agent_execution_failed',
        'detail': '429 您已达到并发请求数限制 PRIVATE api_key=PRIVATE'})
    row, = events.recent()
    assert row['code'] == 'model_rate_limited'
    assert 'PRIVATE' not in events.path.read_text()


def test_restored_prompt_wrapper_preserves_existing_publish_policy(monkeypatch):
    import web.app as web
    monkeypatch.setattr(web, 'read_settings', lambda path: {})
    assert web._publishing_message('draft') == 'draft'
    monkeypatch.setattr(web, 'read_settings', lambda path: {'EASEL_PUBLISH_MODE': 'manual'})
    assert '人工提交' in web._publishing_message('draft')
    assert '不要调用发布脚本' in web._publishing_message('draft')
