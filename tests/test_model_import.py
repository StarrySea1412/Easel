"""从本机配置导入（方案功能 C 第二步）定向测试。

覆盖：来源探测、OpenClaw / CC Switch（SQLite + 旧版 JSON）解析、协议与模型提示、
OAuth/缺 URL/缺密钥判不兼容、预览不回明文密钥、覆盖预览、导入只写所选槽位、
非法输入不改动现有配置。

全部离线：来源用 tmp 目录里的固定样本，不读真实用户配置。
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "web"))

import app as web  # noqa: E402
import local_config_import as lci  # noqa: E402

OPENCLAW_FIXTURE = {
    "models": {"providers": {
        "openai": {"baseUrl": "https://api.deepseek.com/v1",
                   "apiKey": "sk-openclaw-secret-1234",
                   "models": [{"id": "deepseek-chat"}]},
        "relayX": {"baseUrl": "https://relay.example.com/v1", "apiKey": "sk-relay-secret-abcd"},
        "broken": {"baseUrl": "not a url", "apiKey": "sk-broken-secret-1234"},
        "oauthone": {"baseUrl": "https://oauth.example.com",
                     "apiKey": "sk-oauth-secret-1234",
                     "auth": {"refresh_token": "R"}},
    }}
}

CCSWITCH_JSON_FIXTURE = {
    "claude": {"providers": {"p1": {"name": "Relay A", "settingsConfig": {"env": {
        "ANTHROPIC_BASE_URL": "https://relay-a.example.com",
        "ANTHROPIC_AUTH_TOKEN": "sk-ant-token-1234567890",
        "ANTHROPIC_MODEL": "claude-sonnet-4-6",
    }}}}},
    "codex": {"providers": {"p2": {"name": "Codex B", "settingsConfig": {
        "auth": {"OPENAI_API_KEY": "sk-codex-key-1234567890"},
        "config": 'model = "gpt-5-codex"\nbase_url = "https://codex.example.com/v1"\n',
    }}}},
}


def _write_openclaw(home: Path) -> Path:
    home.mkdir(parents=True, exist_ok=True)
    p = home / "openclaw.json"
    p.write_text(json.dumps(OPENCLAW_FIXTURE), encoding="utf-8")
    return p


def _write_ccswitch_json(home: Path) -> Path:
    home.mkdir(parents=True, exist_ok=True)
    p = home / "config.json"
    p.write_text(json.dumps(CCSWITCH_JSON_FIXTURE), encoding="utf-8")
    return p


def _write_ccswitch_db(home: Path) -> Path:
    home.mkdir(parents=True, exist_ok=True)
    p = home / "cc-switch.db"
    con = sqlite3.connect(p)
    con.execute("CREATE TABLE providers (app_type TEXT, name TEXT, settings_config TEXT, "
                "website_url TEXT, category TEXT, notes TEXT)")
    con.execute("INSERT INTO providers VALUES (?,?,?,?,?,?)", (
        "claude", "DB Relay",
        json.dumps(CCSWITCH_JSON_FIXTURE["claude"]["providers"]["p1"]["settingsConfig"]),
        "", "", ""))
    con.commit()
    con.close()
    return p


@pytest.fixture()
def cc_home(tmp_path, monkeypatch):
    """把两个来源的家目录都指到 tmp。"""
    oc_home = tmp_path / ".openclaw-easel"
    cc_home = tmp_path / ".cc-switch"
    monkeypatch.setattr(lci, "HOME_OPENCLAW", oc_home)
    monkeypatch.setattr(lci, "HOME_CCSWITCH", cc_home)
    return oc_home, cc_home


@pytest.fixture()
def fake_env(tmp_path, monkeypatch):
    """隔离 .env 与 openclaw 同步，避免碰真实用户配置。"""
    env_file = tmp_path / ".env"
    env_file.write_text("OPENAI_BASE_URL=https://old.example.com/v1\nOPENAI_API_KEY=sk-old-key-000000\n",
                        encoding="utf-8")
    monkeypatch.setattr(web, "ENV_FILE", env_file)
    synced: list = []
    monkeypatch.setattr(web, "_sync_openclaw_chat",
                        lambda updates, keep, primary='': synced.append((updates, keep)) or "")
    return env_file, synced


# ---- 来源与解析 ----

def test_sources_endpoint_reports_availability(cc_home):
    _write_openclaw(cc_home[0])
    d = asyncio.run(web.api_import_sources())
    by_id = {s["id"]: s for s in d["sources"]}
    assert by_id["openclaw"]["available"] is True
    assert by_id["cc-switch"]["available"] is False          # tmp 里还没建
    assert by_id["cc-switch"]["detail"]
    assert {s["id"] for s in d["slots"]} == {"openai", "anthropic", "relay"}


def test_read_openclaw_candidates(cc_home):
    p = _write_openclaw(cc_home[0])
    cands, errors = lci.read_openclaw(p)
    by_name = {c["name"]: c for c in cands}
    assert not errors
    assert by_name["openai"]["compatible"] and by_name["openai"]["model"] == "deepseek-chat"
    assert by_name["openai"]["keyMasked"].endswith("1234»")
    assert by_name["broken"]["compatible"] is False
    assert "http(s)" in by_name["broken"]["skipReason"]
    assert by_name["oauthone"]["compatible"] is False
    assert "OAuth" in by_name["oauthone"]["skipReason"]


def test_read_ccswitch_legacy_json(cc_home):
    p = _write_ccswitch_json(cc_home[1])
    cands, errors = lci.read_ccswitch(p)
    by_name = {c["name"]: c for c in cands}
    assert not errors
    assert by_name["Relay A"]["protocol"] == "anthropic"
    assert by_name["Relay A"]["model"] == "claude-sonnet-4-6"
    assert by_name["Codex B"]["protocol"] == "openai"
    assert by_name["Codex B"]["model"] == "gpt-5-codex"
    assert all(c["compatible"] for c in cands)


def test_read_ccswitch_sqlite(cc_home):
    p = _write_ccswitch_db(cc_home[1])
    cands, errors = lci.read_ccswitch(p)
    assert not errors and len(cands) == 1
    assert cands[0]["name"] == "DB Relay" and cands[0]["protocol"] == "anthropic"


def test_ccswitch_path_prefers_db_then_json(cc_home):
    assert lci.ccswitch_path() is None
    _write_ccswitch_json(cc_home[1])
    assert lci.ccswitch_path().name == "config.json"
    _write_ccswitch_db(cc_home[1])
    assert lci.ccswitch_path().name == "cc-switch.db"


# ---- 预览：脱敏 + 覆盖预览 ----

def test_preview_never_leaks_plaintext_key(cc_home, fake_env):
    _write_ccswitch_json(cc_home[1])
    d = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source="cc-switch", slot="openai")))
    blob = json.dumps(d, ensure_ascii=False)
    assert "sk-ant-token-1234567890" not in blob and "sk-codex-key-1234567890" not in blob
    assert any(c["keyMasked"].startswith("«") for c in d["candidates"])
    assert d["note"]


def test_preview_overwrites_against_current_env(cc_home, fake_env):
    _write_openclaw(cc_home[0])
    d = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source="openclaw", slot="openai")))
    cand = next(c for c in d["candidates"] if c["name"] == "openai")
    fields = {o["field"]: o for o in cand["overwrites"]}
    assert fields["OPENAI_BASE_URL"]["current"] == "https://old.example.com/v1"
    assert fields["OPENAI_BASE_URL"]["incoming"] == "https://api.deepseek.com/v1"
    cur = fields["OPENAI_API_KEY"]["current"]
    assert "sk-old-key-000000" not in cur and ("…" in cur or "••••" in cur)   # 现值也只给脱敏
    assert fields["OPENAI_MODEL"]["incoming"] == "deepseek-chat"


def test_preview_unavailable_source(cc_home):
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source="cc-switch")))


def test_preview_explicit_path(cc_home, tmp_path):
    other = tmp_path / "elsewhere" / "cfg.json"
    other.parent.mkdir(parents=True, exist_ok=True)
    other.write_text(json.dumps(CCSWITCH_JSON_FIXTURE), encoding="utf-8")
    d = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source="cc-switch", path=str(other))))
    assert len(d["candidates"]) == 2


# ---- 导入：只写所选槽位 ----

def test_apply_writes_only_target_slot(cc_home, fake_env):
    env_file, synced = fake_env
    _write_ccswitch_json(cc_home[1])
    preview = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source="cc-switch", slot="openai")))
    cand = next(c for c in preview["candidates"] if c["name"] == "Codex B")
    d = asyncio.run(web.api_import_apply(web.ImportApplyRequest(
        source="cc-switch", id=cand["id"], slot="openai")))
    assert d["ok"] and d["applied"]["slot"] == "openai"
    text = env_file.read_text(encoding="utf-8")
    assert "OPENAI_BASE_URL=https://codex.example.com/v1" in text
    assert "OPENAI_API_KEY=sk-codex-key-1234567890" in text
    assert "OPENAI_MODEL=gpt-5-codex" in text
    assert "ANTHROPIC" not in text                     # 未选中的槽位不动
    assert synced and "openai" in synced[0][0]         # chat 同步被调用


def test_apply_keeps_custom_providers(cc_home, fake_env):
    _, synced = fake_env
    _write_ccswitch_json(cc_home[1])
    # 用真实 openclaw.json 时 keep 应包含既有 provider；这里只验证传入的 keep 不为空白逻辑：
    preview = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source="cc-switch")))
    cand = next(c for c in preview["candidates"] if c["name"] == "Codex B")
    asyncio.run(web.api_import_apply(web.ImportApplyRequest(source="cc-switch", id=cand["id"], slot="relay")))
    assert synced and synced[-1][0].get("relay")               # relay 槽位同步
    assert isinstance(synced[-1][1], set)                      # keep 是集合（现有键）


def test_apply_rejects_incompatible_and_unknown(cc_home, fake_env):
    env_file, _ = fake_env
    _write_openclaw(cc_home[0])
    before = env_file.read_text(encoding="utf-8")
    preview = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source="openclaw")))
    bad = next(c for c in preview["candidates"] if c["name"] == "oauthone")
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_import_apply(web.ImportApplyRequest(
            source="openclaw", id=bad["id"], slot="openai")))
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_import_apply(web.ImportApplyRequest(
            source="openclaw", id="deadbeef0000", slot="openai")))
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_import_apply(web.ImportApplyRequest(source="openclaw", id="", slot="openai")))
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_import_apply(web.ImportApplyRequest(
            source="openclaw", id=bad["id"], slot="nope")))
    assert env_file.read_text(encoding="utf-8") == before   # 任何拒绝都不改动现有配置


def test_apply_failure_keeps_env_untouched(cc_home, fake_env, monkeypatch):
    env_file, _ = fake_env
    _write_ccswitch_json(cc_home[1])
    preview = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source="cc-switch")))
    cand = next(c for c in preview["candidates"] if c["name"] == "Codex B")
    before = env_file.read_text(encoding="utf-8")

    def boom(_updates):
        raise web.HTTPException(400, "写入前校验失败")

    monkeypatch.setattr(web, "_write_env_direct", boom)
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_import_apply(web.ImportApplyRequest(
            source="cc-switch", id=cand["id"], slot="openai")))
    assert env_file.read_text(encoding="utf-8") == before
