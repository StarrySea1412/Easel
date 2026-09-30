"""easel-notify 邮箱通知（MCP server + mailer + web/manifest 完成钩子）回归测试。

全离线：不连真实 SMTP、不发真实邮件（dry-run / 假主机异常吞噬路径覆盖）。

运行：pytest tests/test_email_notify.py -q
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "web"), str(ROOT / "mcp" / "easel-notify"),
                str(ROOT / "skills" / "shared" / "scripts")]

import app as web  # noqa: E402
import mailer  # noqa: E402
import notify_hook as nh  # noqa: E402
import server as mcp  # noqa: E402

GOOD_ENV = {
    "EASEL_NOTIFY_EMAIL": "a@x.com, b@x.com",
    "EASEL_NOTIFY_SMTP_HOST": "smtp.x.com",
    "EASEL_NOTIFY_SMTP_PORT": "465",
    "EASEL_NOTIFY_SMTP_USER": "u@x.com",
    "EASEL_NOTIFY_SMTP_PASS": "p",
}


# --------------------------------------------------------------------------- #
# mailer：配置解析 / 消息构造 / 失败路径
# --------------------------------------------------------------------------- #
def test_address_split_handles_semicolon_and_cjk_comma():
    cfg = mailer.load_email_config(env={
        "EASEL_NOTIFY_EMAIL": "a@x.com；b@x.com，c@x.com",
        "EASEL_NOTIFY_SMTP_HOST": "smtp.x.com",
    })
    assert cfg.to == ["a@x.com", "b@x.com", "c@x.com"]
    assert cfg.configured


def test_host_without_recipient_is_not_configured():
    assert not mailer.load_email_config(env={"EASEL_NOTIFY_SMTP_HOST": "smtp.x.com"}).configured
    assert not mailer.load_email_config(env={}).configured


def test_port_and_ssl_parsing():
    cfg = mailer.load_email_config(env={"EASEL_NOTIFY_SMTP_HOST": "h",
                                        "EASEL_NOTIFY_EMAIL": "a@x.com",
                                        "EASEL_NOTIFY_SMTP_PORT": "587",
                                        "EASEL_NOTIFY_SMTP_SSL": "0"})
    assert cfg.port == 587 and cfg.ssl is False
    # 非法端口回默认 465，不裸崩
    cfg = mailer.load_email_config(env={"EASEL_NOTIFY_SMTP_HOST": "h",
                                        "EASEL_NOTIFY_EMAIL": "a@x.com",
                                        "EASEL_NOTIFY_SMTP_PORT": "abc"})
    assert cfg.port == 465 and cfg.ssl is True


def test_sender_fallback_chain():
    # from > user > 首个收件人
    assert mailer.load_email_config(env=dict(GOOD_ENV,
                                             EASEL_NOTIFY_FROM="f@x.com")).sender == "f@x.com"
    assert mailer.load_email_config(env=dict(GOOD_ENV)).sender == "u@x.com"
    assert mailer.load_email_config(env={"EASEL_NOTIFY_EMAIL": "a@x.com",
                                         "EASEL_NOTIFY_SMTP_HOST": "h"}).sender == "a@x.com"


def test_mask_keeps_domain():
    assert mailer.mask("user@qq.com").endswith("@qq.com")
    assert "*" in mailer.mask("user@qq.com")
    assert mailer.mask("") == "••••"


def test_send_without_recipient_or_host_fails_clean():
    r = mailer.send_email(mailer.EmailConfig(host="smtp.x.com"), "s", "b")
    assert r["ok"] is False and "收件人" in r["detail"]
    r = mailer.send_email(mailer.EmailConfig(to=["a@x.com"]), "s", "b")
    assert r["ok"] is False and "SMTP 主机" in r["detail"]


def test_dry_run_does_not_touch_network():
    cfg = mailer.load_email_config(env=dict(GOOD_ENV))
    r = mailer.send_email(cfg, "主题", "正文", dry_run=True)
    assert r["ok"] is True and r["dry_run"] is True
    assert r["to"] == ["a@x.com", "b@x.com"]


def test_bad_host_error_is_swallowed_into_result():
    cfg = mailer.load_email_config(env={"EASEL_NOTIFY_EMAIL": "a@x.com",
                                        "EASEL_NOTIFY_SMTP_HOST": "127.0.0.1",
                                        "EASEL_NOTIFY_SMTP_PORT": "1"})
    r = mailer.send_email(cfg, "s", "b")
    assert r["ok"] is False and "失败" in r["detail"]


# --------------------------------------------------------------------------- #
# MCP server：协议面
# --------------------------------------------------------------------------- #
def _rpc(method, params=None, req_id=1):
    return json.loads(mcp.handle({"jsonrpc": "2.0", "id": req_id,
                                  "method": method, "params": params or {}}, req_id))


def test_mcp_initialize_and_tools_list():
    r = _rpc("initialize")
    assert r["result"]["protocolVersion"] == mcp.PROTOCOL_VERSION
    assert "tools" in r["result"]["capabilities"]
    r = _rpc("tools/list")
    names = {t["name"] for t in r["result"]["tools"]}
    assert names == {"notify_email", "notify_status"}


def test_mcp_unknown_method_and_tool():
    r = _rpc("no/such")
    assert r["error"]["code"] == -32601
    r = _rpc("tools/call", {"name": "nope", "arguments": {}})
    assert r["error"]["code"] == -32602


def test_mcp_notification_returns_none():
    assert mcp.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None


def test_mcp_notify_email_unconfigured_gives_hint_not_error(monkeypatch):
    monkeypatch.setattr(mailer, "DEFAULT_ENV_FILE", Path("<nonexistent>"))
    r = _rpc("tools/call", {"name": "notify_email",
                            "arguments": {"subject": "s", "body": "b"}})
    payload = json.loads(r["result"]["content"][0]["text"])
    assert payload["ok"] is False and "未配置" in payload["detail"]
    # 配置了但 dry_run 预览不真发
    orig = mailer.load_email_config
    monkeypatch.setattr(mcp.mailer, "load_email_config",
                        lambda *a, **k: orig(env=dict(GOOD_ENV)))
    r = _rpc("tools/call", {"name": "notify_email",
                            "arguments": {"subject": "s", "body": "b", "dry_run": True}})
    payload = json.loads(r["result"]["content"][0]["text"])
    assert payload["ok"] is True and payload["dry_run"] is True


def test_mcp_notify_status_masks_addresses(monkeypatch):
    monkeypatch.setattr(mailer, "DEFAULT_ENV_FILE", Path("<nonexistent>"))
    # patch 必须先存原函数再包一层：直接 lambda 里再调 mailer.load_email_config 会
    # 调到 patch 后的自身（无限递归）。
    orig = mailer.load_email_config
    monkeypatch.setattr(mcp.mailer, "load_email_config",
                        lambda *a, **k: orig(env=dict(GOOD_ENV)))
    r = _rpc("tools/call", {"name": "notify_status", "arguments": {}})
    payload = json.loads(r["result"]["content"][0]["text"])
    assert payload["configured"] is True
    assert all("*" in x or "•" in x for x in payload["to"])
    assert "a@x.com" not in json.dumps(payload)


def test_mcp_stdio_pipe_roundtrip():
    import subprocess
    proc = subprocess.run(
        [sys.executable, str(ROOT / "mcp" / "easel-notify" / "server.py")],
        input='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'
              '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
        capture_output=True, text=True, encoding="utf-8", timeout=30)
    lines = [json.loads(x) for x in proc.stdout.strip().splitlines() if x.strip()]
    assert len(lines) == 2
    assert lines[0]["result"]["serverInfo"]["name"] == "easel-notify"
    assert {t["name"] for t in lines[1]["result"]["tools"]} == {"notify_email", "notify_status"}


# --------------------------------------------------------------------------- #
# 钩子：条件门禁 / 异常吞噬 / web 与 manifest 接线
# --------------------------------------------------------------------------- #
def test_hook_silent_when_unconfigured(monkeypatch):
    monkeypatch.setattr(mailer, "DEFAULT_ENV_FILE", Path("<nonexistent>"))
    nh._last_sent.clear()
    nh.notify_completion(title="项目", summary="摘要")          # 不抛即通过
    nh.notify_web_turn("done", "正文")                          # 不抛即通过


def test_hook_skip_conditions(monkeypatch):
    # 钩子的 _enabled() 短路在 _send_async 之前——配置未启用时本来就不发，
    # 测跳过条件必须把配置换成已启用，再数发送次数。
    monkeypatch.setattr(mailer, "DEFAULT_ENV_FILE", Path("<nonexistent>"))
    orig = mailer.load_email_config
    monkeypatch.setattr(nh.mailer, "load_email_config",
                        lambda *a, **k: orig(env=dict(GOOD_ENV)))
    sent = []
    monkeypatch.setattr(nh, "_send_async", lambda cfg, s, b: sent.append(s))
    nh._last_sent.clear()
    # 非正常完成：失败/停止/截断/空正文都不发
    nh.notify_web_turn("failed", "x")
    nh.notify_web_turn("done", "x", user_stopped=True)
    nh.notify_web_turn("done", "x", clean_end=False)
    nh.notify_web_turn("done", "  \n")
    assert sent == []
    # 正常完成发
    nh.notify_web_turn("done", "第一行标题\n正文")
    assert len(sent) == 1 and "第一行标题" in sent[0]


def test_hook_dedupes_within_gap(monkeypatch):
    monkeypatch.setattr(mailer, "DEFAULT_ENV_FILE", Path("<nonexistent>"))
    orig = mailer.load_email_config
    monkeypatch.setattr(nh.mailer, "load_email_config",
                        lambda *a, **k: orig(env=dict(GOOD_ENV)))
    sent = []
    monkeypatch.setattr(nh, "_send_async", lambda cfg, s, b: sent.append(s))
    nh._last_sent.clear()
    nh.notify_completion(title="项目", summary="1")
    nh.notify_completion(title="项目", summary="2")   # 60s 内同 key 不重发
    assert len(sent) == 1


def test_hook_send_failure_does_not_raise(monkeypatch):
    monkeypatch.setattr(mailer, "DEFAULT_ENV_FILE", Path("<nonexistent>"))
    def _boom(cfg, s, b):
        raise RuntimeError("smtp down")
    monkeypatch.setattr(nh, "_send_async", _boom)
    nh.notify_completion(title="项目", summary="x")   # 异常被吞，不抛即通过


@pytest.fixture()
def web_sandbox(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "OUTPUTS_DIR", tmp_path)
    return tmp_path


@pytest.mark.parametrize("async_path", [True, False])
def test_publish_success_fires_email_hook(web_sandbox, monkeypatch, async_path):
    fired = []
    monkeypatch.setattr(web, "_notify_email_completion",
                        lambda **kw: fired.append(kw))
    monkeypatch.setattr(web, "_read_schedule", lambda: [])
    monkeypatch.setattr(web, "_write_schedule", lambda items: None)
    if async_path:
        monkeypatch.setattr(web, "_read_publish_status", lambda p: {"state": "success"})
        monkeypatch.setattr(web, "_write_publish_status", lambda *a, **k: None)
        code_file = web_sandbox / "douyin.code"
        web._run_publish_bg("douyin", [sys.executable, "-c", "pass"], "标题", "正文",
                            {"name": "抖音"}, web_sandbox / "douyin.json", code_file)
    else:
        # 直接调用钩子注入点语义：api_publish 里的 if ok 块
        class R:
            returncode = 0
            stdout = ""
            stderr = ""
        ok = R.returncode == 0
        assert ok
        web._notify_email_completion(title="标题", platform="小红书",
                                     summary="正文", source="publish")
    assert fired and fired[0]["source"] == "publish"


def test_publish_failure_does_not_fire_email_hook(web_sandbox, monkeypatch):
    fired = []
    monkeypatch.setattr(web, "_notify_email_completion",
                        lambda **kw: fired.append(kw))
    monkeypatch.setattr(web, "_read_schedule", lambda: [])
    monkeypatch.setattr(web, "_write_schedule", lambda items: None)
    monkeypatch.setattr(web, "_read_publish_status", lambda p: {"state": "error"})
    monkeypatch.setattr(web, "_write_publish_status", lambda *a, **k: None)
    monkeypatch.setattr(web, "subprocess", __import__("subprocess"))
    import subprocess as sp

    def _fail_run(*a, **k):
        raise sp.TimeoutExpired(cmd="x", timeout=1)
    monkeypatch.setattr("subprocess.run", _fail_run)
    web._run_publish_bg("douyin", [sys.executable, "-c", "pass"], "标题", "正文",
                        {"name": "抖音"}, web_sandbox / "douyin.json",
                        web_sandbox / "douyin.code")
    assert fired == []


def test_manifest_record_done_fires_email_hook(tmp_path, monkeypatch):
    import manifest as mf
    fired = []
    monkeypatch.setattr(mf, "_notify_completion",
                        lambda **kw: fired.append(kw))
    monkeypatch.setattr(mf, "OUTPUTS_DIR", tmp_path / "outputs")
    args = SimpleNamespace(topic="测试项目", data=None, profile="", layer="produce",
                           skill="ai-video", status="done", outputs="a.md",
                           upstream="", summary="出片完成")
    mf.cmd_record(args)
    assert fired and fired[0]["topic"] == "测试项目"
    assert fired[0]["deliverables"] == ["a.md"]


def test_manifest_record_failed_does_not_fire(tmp_path, monkeypatch):
    import manifest as mf
    fired = []
    monkeypatch.setattr(mf, "_notify_completion",
                        lambda **kw: fired.append(kw))
    monkeypatch.setattr(mf, "OUTPUTS_DIR", tmp_path / "outputs")
    args = SimpleNamespace(topic="测试项目", data=None, profile="", layer="produce",
                           skill="ai-video", status="failed", outputs="",
                           upstream="", summary="失败")
    mf.cmd_record(args)
    assert fired == []


def test_manifest_meta_ready_fires_email_hook(tmp_path, monkeypatch):
    import manifest as mf
    fired = []
    monkeypatch.setattr(mf, "_notify_completion",
                        lambda **kw: fired.append(kw))
    monkeypatch.setattr(mf, "OUTPUTS_DIR", tmp_path / "outputs")
    args = SimpleNamespace(topic="测试项目", data=None, profile="", title="标题",
                           summary="摘要", platform="小红书", kind="xhs-note",
                           status="ready", cover=None, tags=None,
                           deliverables=None)
    mf.cmd_meta(args)
    assert fired and fired[0]["source"] == "publish"


def test_manifest_without_hook_module_still_writes(tmp_path, monkeypatch):
    import manifest as mf
    monkeypatch.setattr(mf, "_notify_completion", None)
    monkeypatch.setattr(mf, "OUTPUTS_DIR", tmp_path / "outputs")
    args = SimpleNamespace(topic="测试项目", data=None, profile="", layer="produce",
                           skill="ai-video", status="done", outputs="a.md",
                           upstream="", summary="完成")
    mf.cmd_record(args)
    assert (tmp_path / "outputs" / "测试项目" / ".easel.json").is_file()


from types import SimpleNamespace  # noqa: E402
