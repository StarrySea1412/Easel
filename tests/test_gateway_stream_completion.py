"""Gateway stream completion must not overtake queued response tokens."""
import asyncio
import io
import json
import threading
from types import SimpleNamespace

import httpx
import pytest
from easel.codex_service import CodexService
from easel.gateway_auth import GatewayCredentials

import web.app as web


@pytest.mark.parametrize("parts", [["complete"], ["开始", "中间", "结束"], ["a" * 8192, "tail"]])
@pytest.mark.parametrize("buffered", [True, False])
@pytest.mark.parametrize("raw_failure", [False, True])
@pytest.mark.parametrize('cleanup_failure', [False, True])
def test_gateway_stream_preserves_every_token(tmp_path, monkeypatch, parts, buffered, raw_failure, cleanup_failure):
    # The production model/engine contract changed after this fixture was written.
    # Keep every write and credential lookup inside this synthetic environment.
    state=tmp_path/'state';state.mkdir();(state/'openclaw.json').write_text('{}',encoding='utf-8')
    monkeypatch.setattr(web,'openclaw_state_dir',lambda:state)
    monkeypatch.setattr(web,'OUTPUTS_DIR',tmp_path/'outputs')
    monkeypatch.setattr(web,'OPENCLAW_SESSIONS_DIR',tmp_path/'transcripts')
    monkeypatch.setattr(web,'_codex_service',CodexService(tmp_path/'outputs'))
    monkeypatch.setattr(web,'gateway_credentials',lambda:GatewayCredentials('token',token='isolated-fixture'))
    cleanup = {'fail': cleanup_failure}
    def cancel_browser(*_):
        if cleanup['fail']:
            raise TimeoutError('Isolated browser cleanup fixture')
    monkeypatch.setattr(web, '_browser_service', SimpleNamespace(has_pages=lambda _: cleanup_failure, call=cancel_browser))
    monkeypatch.setattr(web, "SESSIONS_DIR", tmp_path / "sessions")
    monkeypatch.setattr(web, "DEBUG_DIR", tmp_path / "debug")
    monkeypatch.setattr(web, "SHARED_RAW_STREAM", tmp_path / "absent-raw.jsonl")
    monkeypatch.setattr(web, "_session_locks", {})
    monkeypatch.setattr(web, "_RUNNING_CHAT", {})
    monkeypatch.setattr(web, "_STOPPED_CHAT", set())
    monkeypatch.setattr(web, "_BG_TASKS", set())
    monkeypatch.setattr(web, "_direct_api_enabled", lambda: False)
    monkeypatch.setattr(web, "_chat_backend", lambda session_id: "openclaw", raising=False)
    monkeypatch.setattr(web, "_chat_message", lambda req, **_: req.message)
    monkeypatch.setattr(web, "_heal_openclaw_session", lambda sk: None)
    monkeypatch.setattr(web, "openclaw_base_cmd", lambda: ["unused-openclaw"])
    monkeypatch.setattr(web, "_proxy_env", dict)
    monkeypatch.setattr(web, "question_bridge_supported", lambda: False)
    monkeypatch.setattr(web, "GatewayClient", None)
    monkeypatch.setattr(web, "_resolve_transport", lambda sk: "http")
    monkeypatch.setattr(web, "chat_completions_url", lambda: "http://gateway.test/v1/chat/completions")
    events = [{"choices": [{"delta": {"reasoning_content": "thinking"}}]}]
    events.extend({"choices": [{"delta": {"content": part}}]} for part in parts)
    events.append({"choices": [{"delta": {}, "finish_reason": "stop"}]})
    payload = "".join("data: " + json.dumps(event) + "\n\n" for event in events) + "data: [DONE]\n\n"

    raw_failed = threading.Event()

    if raw_failure:
        original_open = open

        class BrokenRawStream(io.StringIO):
            def readline(self, *args):
                raise UnicodeError("simulated raw log decoding failure")

            def __exit__(self, *args):
                raw_failed.set()
                return super().__exit__(*args)

        def open_log(path, *args, **kwargs):
            if path == web.SHARED_RAW_STREAM:
                return BrokenRawStream()
            return original_open(path, *args, **kwargs)

        monkeypatch.setattr(web, "open", open_log, raising=False)

    class Chunks(httpx.AsyncByteStream):
        async def __aiter__(self):
            for block in payload.split("\n\n"):
                await asyncio.sleep(0)
                yield (block + "\n\n").encode()

    client_class = httpx.AsyncClient

    async def gateway_response(request):
        if raw_failure:
            # Release the HTTP response only after the auxiliary reader fails.
            # No wall-clock sleep: the worker signals the exact fault boundary.
            assert await asyncio.to_thread(raw_failed.wait, 2)
            await asyncio.sleep(0)
        return (httpx.Response(200, text=payload) if buffered
                else httpx.Response(200, stream=Chunks()))

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client_class(
        transport=httpx.MockTransport(gateway_response),
        **kwargs))

    async def scenario():
        response = await web.api_chat_stream(web.ChatRequest(
            message="test", sessionId="buffered", turnId="buffered-turn"))

        async def collect():
            return [event async for event in response.body_iterator]

        received = await asyncio.wait_for(collect(), timeout=3)
        tokens = [json.loads(event["data"]) for event in received if event["event"] == "token"]
        assert tokens == parts
        assert [json.loads(event["data"]) for event in received
                if event["event"] == "thinking"] == ["thinking"]
        assert received[-1]['event'] == ('recovery_required' if cleanup_failure else 'done')
        snapshot = await web.api_chat_last("buffered", turn_id="buffered-turn")
        assert snapshot["text"] == "".join(parts)
        replay = web._read_job_events("buffered-turn")
        assert [event["data"] for event in replay if event["event"] == "token"] == parts
        assert replay[-1]['event'] == ('recovery_required' if cleanup_failure else 'done')
        record = web.run_ledger.read(web._run_ledger_root(), 'buffered-turn')
        assert record['resourceSettled'] is not cleanup_failure
        from easel.task_store import TaskStore
        store = TaskStore(web.OUTPUTS_DIR)
        assert store.pending_chat('buffered') == ('buffered-turn' if cleanup_failure else None)
        if cleanup_failure:
            cleanup['fail'] = False
            from chat_recovery import reconcile_orphan
            result = await asyncio.to_thread(reconcile_orphan, web, 'buffered', 'buffered-turn')
            assert result == {'stopped': True, 'status': 'already_finished'}
            assert store.pending_chat('buffered') is None
            assert web.run_ledger.read(web._run_ledger_root(), 'buffered-turn')['resourceSettled']
            assert web._read_job_events('buffered-turn')[-1]['event'] == 'done'
            restored = await web.api_chat_last('buffered', turn_id='buffered-turn')
            assert restored['text'] == ''.join(parts) and restored['clean_end'] and not restored['error']
        assert not web._RUNNING_CHAT
        assert not web._session_lock("buffered").locked()

    asyncio.run(scenario())
