"""Offline model probes: shared quotas, opt-in schedules and objective vision scoring."""
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import random
import sys
import threading
import urllib.error
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "web"))
import app as web
import model_health as health


@pytest.fixture
def service(tmp_path):
    now = [1000.]
    targets = {f"relay/model-{i}": health.Target(f"relay/model-{i}", "relay", f"model-{i}",
              "openai", "https://fixture.invalid/v1", "synthetic-secret") for i in range(4)}
    calls = []
    def sender(target, prompt, mode):
        calls.append((target.model_ref, prompt, mode))
        return {"ok": True, "state": "success", "detail": "synthetic"}
    result = health.Service(tmp_path, targets.get, lambda _: True, clock=lambda: now[0], sender=sender)
    return SimpleNamespace(api=result, now=now, targets=targets, calls=calls, root=tmp_path, sender=sender)


def test_cross_process_quota_survives_reopen_and_expires(service):
    second = health.Service(service.root, service.targets.get, lambda _: True, clock=lambda: service.now[0], sender=service.sender)
    service.api.probe("relay/model-0")
    second.probe("relay/model-1")
    with pytest.raises(HTTPException) as exc:
        second.probe("relay/model-2")
    assert exc.value.status_code == 429 and len(service.calls) == 2
    service.now[0] += 60
    second.probe("relay/model-2")
    assert len(service.calls) == 3


def test_concurrent_legacy_and_new_checks_share_two_slots(service):
    def reserve(_):
        try:
            service.api.reserve_legacy()
            return True
        except HTTPException as exc:
            assert exc.status_code == 429
            return False
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(reserve, range(12))) == 2


def test_automatic_default_off_and_persistence(service):
    assert service.api.status()["schedules"] == []
    service.api.configure([{"modelRef": "relay/model-0", "enabled": False, "intervalSeconds": 60, "prompt": "custom"}])
    service.now[0] += 600
    service.api.tick()
    assert not service.calls
    service.api.configure([{"modelRef": "relay/model-0", "enabled": True, "intervalSeconds": 60, "prompt": "custom"}])
    service.now[0] += 60
    second = health.Service(service.root, service.targets.get, lambda _: True, clock=lambda: service.now[0], sender=service.sender)
    second.tick()
    service.api.tick()
    assert service.calls == [("relay/model-0", "custom", "text")]
    assert second.status()["results"][0]["automatic"] is True


def test_config_change_stops_scheduled_billing_and_invalidates_evidence(service):
    ref = "relay/model-0"
    service.api.configure([{"modelRef": ref, "enabled": True, "intervalSeconds": 60}])
    service.api.probe(ref)
    service.targets[ref] = health.Target(ref, "relay", "model-0", "openai", "https://new.invalid/v1", "new-key")
    service.now[0] += 60
    service.api.tick()
    status = service.api.status()
    assert len(service.calls) == 1 and not status["schedules"][0]["enabled"]
    assert status["results"][0]["state"] == "unverified"


def test_scheduler_rejects_deleted_target_and_does_not_block_others(service):
    service.api.configure([{"modelRef": "relay/model-0", "enabled": True, "intervalSeconds": 60},
                           {"modelRef": "relay/model-1", "enabled": True, "intervalSeconds": 60}])
    del service.targets["relay/model-0"]
    service.now[0] += 60
    service.api.tick()
    assert service.calls[0][0] == "relay/model-1"
    assert not service.api.status()["schedules"][0]["enabled"]


@pytest.mark.parametrize("rows", [None, [{"modelRef": "relay/model-0", "intervalSeconds": True}],
    [{"modelRef": "relay/model-0", "intervalSeconds": 59}], [{"modelRef": "relay/model-0", "enabled": 1}],
    [{"modelRef": "relay/model-0"}, {"modelRef": "relay/model-0"}],
    [{"modelRef": f"relay/model-{i}", "enabled": True} for i in range(3)]])
def test_invalid_schedule_rejected_atomically(service, rows):
    with pytest.raises(HTTPException):
        service.api.configure(rows)
    assert service.api.status()["schedules"] == [] and not service.calls


def test_rejected_target_never_reserves_or_sends(service):
    service.api.allowed = lambda _: False
    with pytest.raises(HTTPException):
        service.api.probe("relay/model-0")
    service.api.allowed = lambda _: True
    service.api.probe("relay/model-0")
    service.api.probe("relay/model-1")
    assert len(service.calls) == 2


def test_stale_results_and_incomplete_request_recovery(service):
    service.api.probe("relay/model-0")
    service.now[0] += 901
    assert service.api.status()["results"][0]["stale"]
    with service.api.connect() as db:
        db.execute("UPDATE results SET data=?", (json.dumps({"state": "running", "startedAt": service.now[0] - 61}),))
    assert service.api.status()["results"][0]["state"] == "failed"
    service.api.probe("relay/model-0")


def test_random_image_contains_pixels_without_answer_metadata():
    image, expected, prompt = health.challenge(random.Random(42))
    assert len(set(expected)) == 4 and json.dumps(expected) not in prompt
    with Image.open(io.BytesIO(image)) as bitmap:
        assert bitmap.size == (320, 320) and not bitmap.info
        for i, color in enumerate(expected):
            assert bitmap.getpixel(((i % 2) * 160 + 80, (i // 2) * 160 + 80)) == tuple(bytes.fromhex(health.PALETTE[color][1:]))
    assert health.image_score(json.dumps(expected), expected) == {"correct": 4, "total": 4, "passed": True}
    assert not health.image_score("I support vision", expected)["passed"]
    assert not health.image_score(json.dumps(expected[::-1]), expected)["passed"]


@pytest.mark.parametrize("protocol", ["openai", "anthropic"])
def test_protocol_image_payload_and_response_redaction(protocol):
    target = health.Target("provider/model", "provider", "model", protocol, "https://fixture.invalid/v1", "synthetic-secret")
    image, _, prompt = health.challenge(random.Random(1))
    request = health.request_body(target, prompt, image)
    payload = json.loads(request.data)
    content = payload["messages"][0]["content"]
    if protocol == "anthropic":
        assert request.full_url.endswith("/v1/messages")
        assert base64.b64decode(content[0]["source"]["data"]) == image
        raw = {"content": [{"type": "text", "text": "synthetic-secret received"}]}
    else:
        assert request.full_url.endswith("/v1/chat/completions")
        assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")
        raw = {"choices": [{"message": {"content": "synthetic-secret received"}}]}
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, size): return json.dumps(raw).encode()
    result = health.dispatch(target, "custom", "text", SimpleNamespace(open=lambda req, timeout: Response()))
    assert result["ok"] and "synthetic-secret" not in json.dumps(result)


def test_saved_resolver_and_readonly_routes(service, tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    config = state / "openclaw.json"
    config.write_text(json.dumps({"models": {"providers": {"relay": {"api": "openai-completions",
        "baseUrl": "https://fixture.invalid/v1", "apiKey": "synthetic-secret", "models": [{"id": "model-0"}]}}}}))
    monkeypatch.setattr(web, "openclaw_state_dir", lambda: state)
    assert web._model_health_target("relay/model-0").key == "synthetic-secret"
    assert web._model_health_target("foreign/model") is None
    monkeypatch.setattr(web, "_model_health_service", lambda: service.api)
    assert asyncio.run(web.api_model_health())["results"] == [] and not service.calls
    result = asyncio.run(web.api_model_probe(web.ModelProbeRequest(modelRef="relay/model-0", prompt="custom")))
    assert result["ok"] and service.calls[0][1] == "custom"


def test_saved_environment_key_reference_and_entry_auth_are_not_sent_as_literals(tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    path = state / "openclaw.json"
    row = {"id": "model"}
    saved = {"api": "openai-completions", "baseUrl": "https://fixture.invalid/v1",
             "apiKey": "${FIXTURE_KEY}", "models": [row]}
    config = {"models": {"providers": {"relay": saved}}}
    path.write_text(json.dumps(config))
    monkeypatch.setattr(web, "openclaw_state_dir", lambda: state)
    monkeypatch.setattr(web, "_read_env", lambda: {"FIXTURE_KEY": "resolved-fixture-secret"})
    assert web._model_health_target("relay/model").key == "resolved-fixture-secret"
    row["headers"] = {"Authorization": "unsupported"}
    path.write_text(json.dumps(config))
    assert web._model_health_target("relay/model") is None


def test_title_runner_calls_only_saved_default_text_completion_without_tools(service, tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    (state / "openclaw.json").write_text(json.dumps({"agents": {"defaults": {"model": {"primary": "relay/model-0"}}}}))
    monkeypatch.setattr(web, "openclaw_state_dir", lambda: state)
    monkeypatch.setattr(web, "_model_health_service", lambda: service.api)
    requests = []
    monkeypatch.setattr(web.model_health, "dispatch", lambda target, prompt, mode:
        requests.append((target.model_ref, prompt, mode)) or {"ok": True, "preview": '{"title":"测试标题"}'})
    monkeypatch.setattr(web, "run_agent_sync", lambda *args, **kw: pytest.fail("no agent tools or sessions"))
    assert web._conversation_title_runner("bounded", session_id="isolated") == '{"title":"测试标题"}'
    assert requests == [("relay/model-0", "bounded", "text")]


def test_builtin_gateway_probes_exact_saved_upstream_without_local_address_or_fallback(tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    path = state / "openclaw.json"
    path.write_text(json.dumps({"models": {"providers": {"relay": {"api": "openai-completions",
        "baseUrl": "http://127.0.0.1:8890/v1", "apiKey": "gateway-token",
        "models": [{"id": "saved-model"}, {"id": "other-model"}]}}}}))
    env = {"EASEL_LLM_BASE_URL": "https://upstream.invalid", "EASEL_LLM_API_KEY": "upstream-secret",
           "EASEL_LLM_MODEL": "saved-model"}
    monkeypatch.setattr(web, "openclaw_state_dir", lambda: state)
    monkeypatch.setattr(web, "_read_env", lambda: env)
    target = web._model_health_target("relay/saved-model")
    assert (target.base, target.key, target.protocol) == ("https://upstream.invalid", "upstream-secret", "anthropic")
    assert web._model_health_target("relay/other-model") is None


@pytest.mark.parametrize("protocol", ["openai", "anthropic"])
@pytest.mark.parametrize("passes", [True, False])
def test_vision_dispatch_scores_random_pixels_without_answer_in_request(protocol, passes, monkeypatch):
    image, expected, prompt = health.challenge(random.Random(442))
    monkeypatch.setattr(health, "challenge", lambda: (image, expected, prompt))
    target = health.Target("provider/model", "provider", "model", protocol, "https://fixture.invalid/v1", "synthetic-secret")
    closed = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): closed.append(True)
        def read(self, size):
            answer = expected if passes else expected[::-1]
            text = json.dumps(answer)
            return json.dumps({"content": [{"type": "text", "text": text}]} if protocol == "anthropic"
                else {"choices": [{"message": {"content": text}}]}).encode()
    def open_request(request, timeout):
        payload = json.loads(request.data)
        assert timeout == 20 and payload["model"] == "model"
        content = payload["messages"][0]["content"]
        text = next(block["text"] for block in content if block["type"] == "text")
        assert text == prompt and json.dumps(expected) not in text and "custom secret prompt" not in text
        encoded = content[0]["source"]["data"] if protocol == "anthropic" else content[1]["image_url"]["url"].split(",", 1)[1]
        assert base64.b64decode(encoded) == image
        return Response()
    result = health.dispatch(target, "custom secret prompt", "vision", SimpleNamespace(open=open_request))
    assert result["ok"] is passes and result["score"]["passed"] is passes
    assert result["score"]["correct"] == (4 if passes else 0) and result["score"]["total"] == 4
    assert closed == [True] and "synthetic-secret" not in json.dumps(result)


def test_duplicate_running_probe_rejected_before_consuming_second_slot(service):
    entered, release = threading.Event(), threading.Event()
    def blocked_sender(target, prompt, mode):
        service.calls.append(target.model_ref)
        entered.set()
        assert release.wait(5)
        return {"ok": True, "state": "success", "detail": "synthetic"}
    service.api.sender = blocked_sender
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(service.api.probe, "relay/model-0")
        try:
            assert entered.wait(5)
            with pytest.raises(HTTPException) as exc:
                service.api.probe("relay/model-0")
            assert exc.value.status_code == 409
            with service.api.connect() as db:
                assert db.execute("SELECT COUNT(*) FROM calls").fetchone()[0] == 1
        finally:
            release.set()
        assert first.result(timeout=5)["ok"]
    service.api.probe("relay/model-1")
    assert service.calls == ["relay/model-0", "relay/model-1"]


def test_concurrent_scheduler_services_claim_same_due_job_once(service):
    service.api.configure([{"modelRef": "relay/model-0", "enabled": True, "intervalSeconds": 60}])
    service.now[0] += 60
    copies = [health.Service(service.root, service.targets.get, lambda _: True, clock=lambda: service.now[0], sender=service.sender) for _ in range(6)]
    barrier = threading.Barrier(len(copies))
    def tick(copy):
        barrier.wait(timeout=5)
        copy.tick()
    with ThreadPoolExecutor(max_workers=len(copies)) as pool:
        list(pool.map(tick, copies))
    assert service.calls == [("relay/model-0", health.DEFAULT_PROMPT, "text")]
    with service.api.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM calls").fetchone()[0] == 1


def test_due_jobs_do_not_starve_after_quota_rollover(service):
    for i, target in list(service.targets.items()):
        service.targets[i] = health.Target(target.model_ref, i, target.model, target.protocol, target.base, target.key)
    service.api.configure([{"modelRef": ref, "enabled": True, "intervalSeconds": 60} for ref in service.targets])
    service.now[0] += 60
    service.api.tick()
    assert [call[0] for call in service.calls] == ["relay/model-0", "relay/model-1"]
    service.now[0] += 60
    service.api.tick()
    assert [call[0] for call in service.calls[2:]] == ["relay/model-2", "relay/model-3"]


def test_http_error_body_connection_closed_without_exposing_credentials():
    body = io.BytesIO(b"synthetic-secret private upstream error")
    error = urllib.error.HTTPError("https://fixture.invalid", 401, "synthetic-secret", {}, body)
    def open_request(request, timeout):
        raise error
    target = health.Target("provider/model", "provider", "model", "openai", "https://fixture.invalid/v1", "synthetic-secret")
    result = health.dispatch(target, "custom", "text", SimpleNamespace(open=open_request))
    assert result["state"] == "failed" and "401" in result["detail"] and body.closed
    assert "synthetic-secret" not in json.dumps(result)
