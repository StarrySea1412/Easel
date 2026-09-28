"""服务商预设与模型发现（web.app 功能 C 第一步）定向测试。

对应 docs/secondary-development-plan.md 验收点：
预设 / 获取成功 / 401·403 / 404 / 不支持（非 JSON）/ 超时 / 空列表 / 恶意 URL /
手动输入兜底（拿不到列表时给出可读原因，不阻塞手动填写）。

全部离线：用假的 opener 替代真实 HTTP，恶意 URL 用例只走本地地址判定，不发请求。
"""
from __future__ import annotations

import asyncio
import json
import re
import socket
import sys
import urllib.error
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "web"))

import app as web  # noqa: E402


@pytest.fixture(autouse=True)
def isolated_config(tmp_path, monkeypatch):
    monkeypatch.setattr(web, 'ENV_FILE', tmp_path / '.env')
    monkeypatch.setenv('HOME', str(tmp_path))
    monkeypatch.setenv('USERPROFILE', str(tmp_path))
    monkeypatch.setenv('EASEL_OPENCLAW_STATE_DIR', str(tmp_path / 'state'))


class _FakeResp:
    def __init__(self, body: bytes, status: int = 200):
        self._body, self.status = body, status

    def read(self, _n: int | None = None) -> bytes:
        return self._body

    def __enter__(self) -> "_FakeResp":
        return self

    def __exit__(self, *_a) -> bool:
        return False


def _patch_open(monkeypatch, fn, skip_ssrf: bool = True):
    """把 _discover_models 里的 opener 换成假的；默认同时跳过 DNS 解析保持离线。"""
    class _Opener:
        def open(self, req, timeout=None):
            return fn(req, timeout)

    monkeypatch.setattr(web.urllib.request, "build_opener", lambda *a, **k: _Opener())
    if skip_ssrf:
        monkeypatch.setattr(web, "_ssrf_safe", lambda u: True)


def _http_error(req, code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(req.full_url, code, "err", {}, None)


# ---- 预设 ----

def test_presets_chat_no_secrets_and_valid_urls():
    d = asyncio.run(web.api_models_presets("chat"))
    assert d["presets"], d
    for p in d["presets"]:
        assert set(p) == {"id", "name", "protocol", "baseUrl", "note"}, p   # 结构固定，没有 Key 字段
        assert web._valid_base_url(p["baseUrl"]), p
        assert p["protocol"] in ("openai", "anthropic")
        blob = json.dumps(p, ensure_ascii=False)
        assert not re.search(r"sk-[A-Za-z0-9_\-]{8,}", blob), p             # 不带任何像密钥的值
    assert {"deepseek", "siliconflow", "anthropic"} <= {p["id"] for p in d["presets"]}


def test_presets_all_channels_have_note():
    d = asyncio.run(web.api_models_presets(""))
    assert {"chat", "transcribe", "image"} <= set(d["presets"])
    assert d["note"]
    for ps in d["presets"].values():
        for p in ps:
            assert web._valid_base_url(p["baseUrl"]), p


# ---- 获取成功 ----

def test_discover_success_openai(monkeypatch):
    seen: dict = {}

    def fake(req, timeout):
        seen["url"] = req.full_url
        seen["auth"] = req.get_header("Authorization")
        body = {"data": [{"id": "deepseek-chat"}, {"id": "deepseek-reasoner"}, {"id": "deepseek-chat"}]}
        return _FakeResp(json.dumps(body).encode())

    _patch_open(monkeypatch, fake)
    r = web._discover_models("https://api.deepseek.com/v1/", "sk-test-123")
    assert r["ok"] and r["kind"] == "ok"
    assert r["models"] == ["deepseek-chat", "deepseek-reasoner"]   # 去重
    assert seen["url"] == "https://api.deepseek.com/v1/models"
    assert seen["auth"] == "Bearer sk-test-123"


def test_discover_success_anthropic_protocol(monkeypatch):
    seen: dict = {}

    def fake(req, timeout):
        seen["url"] = req.full_url
        seen["hdr"] = {k.lower(): v for k, v in req.header_items()}
        return _FakeResp(json.dumps({"data": [{"id": "claude-sonnet-4-6"}]}).encode())

    _patch_open(monkeypatch, fake)
    r = web._discover_models("https://api.anthropic.com", "sk-ant-x", protocol="anthropic")
    assert r["ok"] and seen["url"] == "https://api.anthropic.com/v1/models"
    assert seen["hdr"].get("x-api-key") == "sk-ant-x"
    assert "authorization" not in seen["hdr"]


# ---- 失败分级：401 / 403 / 404 / 429 / 5xx / 跳转 ----

@pytest.mark.parametrize("code,kind", [
    (401, "unauthorized"), (403, "unauthorized"), (404, "not_found"),
    (429, "rate_limited"), (500, "server_error"), (302, "redirect_blocked"),
])
def test_discover_http_status_kinds(monkeypatch, code, kind):
    _patch_open(monkeypatch, lambda req, timeout: (_ for _ in ()).throw(_http_error(req, code)))
    r = web._discover_models("https://api.deepseek.com/v1", "sk-x")
    assert r["ok"] is False and r["kind"] == kind, r
    assert r["message"] and "sk-x" not in r["message"]


# ---- 超时 / 网络错误 / 不支持 / 空列表 ----

def test_discover_timeout(monkeypatch):
    def boom(req, timeout):
        raise urllib.error.URLError(socket.timeout("timed out"))
    _patch_open(monkeypatch, boom)
    r = web._discover_models("https://api.deepseek.com/v1", "sk-x")
    assert r["kind"] == "timeout" and "超时" in r["message"]


def test_discover_network_error_redacts_key(monkeypatch):
    def boom(req, timeout):
        raise urllib.error.URLError("handshake failed for key sk-leak-me")
    _patch_open(monkeypatch, boom)
    r = web._discover_models("https://api.deepseek.com/v1", "sk-leak-me")
    assert r["kind"] == "network"
    assert "sk-leak-me" not in r["message"] and "••••" in r["message"]


def test_discover_non_json_is_unsupported(monkeypatch):
    _patch_open(monkeypatch, lambda req, timeout: _FakeResp(b"<html>login page</html>"))
    r = web._discover_models("https://api.deepseek.com/v1", "sk-x")
    assert r["kind"] == "unsupported" and "手动填写" in r["message"]


def test_discover_empty_list(monkeypatch):
    _patch_open(monkeypatch, lambda req, timeout: _FakeResp(b'{"data": []}'))
    r = web._discover_models("https://api.deepseek.com/v1", "sk-x")
    assert r["ok"] is False and r["kind"] == "empty"


def test_discover_caps_model_count(monkeypatch):
    big = {"data": [{"id": f"m{i}"} for i in range(600)]}
    _patch_open(monkeypatch, lambda req, timeout: _FakeResp(json.dumps(big).encode()))
    r = web._discover_models("https://api.deepseek.com/v1", "sk-x")
    assert r["ok"] and len(r["models"]) == 500


# ---- 恶意/内网地址：不发请求就拒绝 ----

@pytest.mark.parametrize("url,kind", [
    ("ftp://api.example.com", "invalid_url"),
    ("http://user:pass@api.example.com", "invalid_url"),
    ("file:///etc/passwd", "invalid_url"),
    ("http://127.0.0.1:8000", "blocked_target"),
    ("http://localhost:11434", "blocked_target"),
    ("http://169.254.169.254/latest/meta-data", "blocked_target"),
    ("http://[::1]:8080", "blocked_target"),
])
def test_discover_rejects_unsafe_targets(monkeypatch, url, kind):
    def should_not_run(*_a, **_k):
        raise AssertionError("不安全地址不应发起请求")
    _patch_open(monkeypatch, should_not_run, skip_ssrf=False)   # 内网判定走真实实现
    r = web._discover_models(url, "sk-x")
    assert r["ok"] is False and r["kind"] == kind, (url, r)


# ---- 端点包装：校验、Key 来源 ----

def test_endpoint_requires_base_url():
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_models_discover(web.ModelDiscoverRequest(channel="chat", baseUrl="")))


def test_endpoint_unknown_channel():
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_models_discover(
            web.ModelDiscoverRequest(channel="nope", baseUrl="https://api.deepseek.com/v1")))


def test_endpoint_key_source_input(monkeypatch):
    monkeypatch.setattr(web, "_discover_models",
                        lambda base, key, protocol="openai", timeout=10.0:
                        {"ok": True, "kind": "ok", "models": ["m1"], "message": "ok"})
    d = asyncio.run(web.api_models_discover(web.ModelDiscoverRequest(
        channel="chat", slot="openai", baseUrl="https://api.deepseek.com/v1", apiKey="sk-typed")))
    assert d["keySource"] == "input" and d["models"] == ["m1"] and d["channel"] == "chat"
    assert d["source"] == "https://api.deepseek.com/v1" and d["fetchedAt"] > 0


def test_endpoint_falls_back_to_saved_key(monkeypatch):
    monkeypatch.setattr(web, "_saved_key_for", lambda ch, slot: "sk-saved")
    monkeypatch.setattr(web, '_saved_base_for', lambda ch, slot: 'https://api.deepseek.com/v1')
    captured: dict = {}

    def fake(base, key, protocol="openai", timeout=10.0):
        captured["key"] = key
        return {"ok": True, "kind": "ok", "models": ["m"], "message": "ok"}

    monkeypatch.setattr(web, "_discover_models", fake)
    d = asyncio.run(web.api_models_discover(web.ModelDiscoverRequest(
        channel="chat", slot="openai", baseUrl="https://api.deepseek.com/v1")))
    assert captured["key"] == "sk-saved" and d["keySource"] == "saved"


def test_endpoint_does_not_send_saved_key_to_changed_address(monkeypatch):
    monkeypatch.setattr(web, '_saved_key_for', lambda ch, slot: 'sk-saved')
    monkeypatch.setattr(web, '_saved_base_for', lambda ch, slot: 'https://trusted.example/v1')
    monkeypatch.setattr(web, '_discover_models', lambda *args: pytest.fail('must not send request'))
    with pytest.raises(web.HTTPException) as caught:
        asyncio.run(web.api_models_discover(web.ModelDiscoverRequest(
            channel='chat', slot='openai', baseUrl='https://changed.example/v1')))
    assert caught.value.status_code == 400 and '重新填写' in caught.value.detail
    assert 'sk-saved' not in caught.value.detail


@pytest.mark.parametrize('slot,protocol', [('relay', 'openai'), ('anthropic', 'openai'), ('openai', 'anthropic')])
def test_discovery_rejects_slot_protocol_mismatch(monkeypatch, slot, protocol):
    monkeypatch.setattr(web, '_discover_models', lambda *args: pytest.fail('must not send request'))
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_models_discover(web.ModelDiscoverRequest(
            channel='chat', slot=slot, protocol=protocol, apiKey='sk-typed', baseUrl='https://api.example/v1')))


def test_anthropic_base_with_v1_does_not_duplicate_path(monkeypatch):
    seen = []
    def fake(req, timeout):
        seen.append(req.full_url)
        return _FakeResp(b'{"data":[{"id":"model"}]}')
    _patch_open(monkeypatch, fake)
    assert web._discover_models('https://api.example/v1', 'sk-test', 'anthropic')['ok']
    assert seen == ['https://api.example/v1/models']


@pytest.mark.parametrize('payload', [{'data': 12}, {'data': {'error': 'bad'}}, {'data': 'model'}])
def test_malformed_discovery_list_degrades(monkeypatch, payload):
    _patch_open(monkeypatch, lambda req, timeout: _FakeResp(json.dumps(payload).encode()))
    result = web._discover_models('https://api.example/v1', 'sk-test')
    assert result['kind'] == 'unsupported' and result['models'] == []
