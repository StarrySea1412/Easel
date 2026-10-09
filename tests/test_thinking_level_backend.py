"""Per-request thinking level validation and CLI forwarding."""

import asyncio
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "web"))
import app as web
from easel.gateway_auth import GatewayCredentials


THINKING_LEVELS = [
    "off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra",
]


@pytest.mark.parametrize("level", THINKING_LEVELS)
def test_chat_request_accepts_supported_thinking_levels(level):
    request = web.ChatRequest(message="test", thinkingLevel=level)
    assert request.thinkingLevel == level


@pytest.mark.parametrize("level", ["", "normal", "HIGH", "xhigh ", 1, False])
def test_chat_request_rejects_unknown_thinking_levels(level):
    with pytest.raises(ValidationError):
        web.ChatRequest(message="test", thinkingLevel=level)


def test_run_agent_sync_forwards_request_level_to_cli(monkeypatch):
    calls = []

    class Lock:
        def __init__(self, key):
            assert key == "thinking-sync"

        def acquire(self, timeout):
            return True

        def release(self):
            calls.append("released")

    def run(command, **kwargs):
        calls.append((command, kwargs))
        assert command[command.index("--thinking") + 1] == "high"
        return subprocess.CompletedProcess(command, 0, "answer\n", "")

    monkeypatch.setattr(web, "_CrossProcLock", Lock)
    monkeypatch.setattr(web, "gateway_credentials",
                        lambda: GatewayCredentials("token", token="synthetic-token"))
    monkeypatch.setattr(web, "_heal_openclaw_session", lambda key: None)
    monkeypatch.setattr(web, "_openclaw_session_id", lambda key: "runtime-thinking-sync")
    monkeypatch.setattr(web, "openclaw_base_cmd", lambda: ["fake-cli"])
    monkeypatch.setattr(web, "_proxy_env", lambda: {})
    monkeypatch.setattr(web.subprocess, "run", run)

    result = web.run_agent_sync("test", session_id="thinking-sync", thinking_level="high")

    assert result == "answer"
    assert calls[-1] == "released"


def test_api_chat_passes_request_level_to_sync_agent(monkeypatch):
    calls = []

    def fake_run(*args):
        calls.append(args)
        return "simulated"

    monkeypatch.setattr(web, "run_agent_sync", fake_run)
    result = asyncio.run(web.api_chat(web.ChatRequest(
        message="test", sessionId="chat-session", thinkingLevel="minimal")))

    assert result == {"response": "simulated"}
    assert calls and calls[0][2:] == ("chat-session", "minimal")


def test_api_chat_omits_level_as_none_for_backward_compatibility(monkeypatch):
    calls = []
    monkeypatch.setattr(web, "run_agent_sync", lambda *args: calls.append(args) or "simulated")

    asyncio.run(web.api_chat(web.ChatRequest(message="test", sessionId="legacy-session")))

    assert calls and calls[0][2:] == ("legacy-session", None)
