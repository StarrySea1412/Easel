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
import urllib.error
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
        "config": 'model = "gpt-5-codex"\nbase_url = "https://codex.example.com/v1"\nwire_api = "chat"\n',
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


@pytest.fixture(autouse=True)
def cc_home(tmp_path, monkeypatch):
    """把两个来源的家目录都指到 tmp。"""
    oc_home = tmp_path / ".openclaw-easel"
    cc_home = tmp_path / ".cc-switch"
    monkeypatch.setattr(lci, "HOME_OPENCLAW", oc_home)
    monkeypatch.setattr(lci, "HOME_CCSWITCH", cc_home)
    monkeypatch.delenv('EASEL_PORTABLE', raising=False)
    monkeypatch.setattr(lci, '_windows_profile_home', lambda: None)
    monkeypatch.setenv('EASEL_OPENCLAW_STATE_DIR', str(oc_home))
    monkeypatch.setenv('HOME', str(tmp_path))
    monkeypatch.setenv('USERPROFILE', str(tmp_path))
    monkeypatch.setenv('EASEL_DATA_DIR', str(tmp_path / 'data'))
    monkeypatch.setattr(web, 'ENV_FILE', tmp_path / '.env')
    web._IMPORT_PREVIEWS.clear()
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
    assert by_name["openai"]["keyMasked"].endswith("1234")
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


def test_openclaw_all_models_are_selectable_and_apply_exact_choice(cc_home, fake_env):
    path = _write_openclaw(cc_home[0])
    data = json.loads(path.read_text(encoding='utf-8'))
    data['models']['providers']['openai']['models'] = [
        {'id': 'deepseek-chat'}, {'id': 'deepseek-reasoner'}, {'id': 'deepseek-chat'}, {},
    ]
    path.write_text(json.dumps(data), encoding='utf-8')
    preview = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source='openclaw')))
    candidates = [c for c in preview['candidates'] if c['name'] == 'openai']
    assert [c['model'] for c in candidates] == ['deepseek-chat', 'deepseek-reasoner']
    assert len({c['id'] for c in candidates}) == 2
    assert all(c['compatible'] and 'key' not in c for c in candidates)
    selected = candidates[1]
    result = asyncio.run(web.api_import_apply(web.ImportApplyRequest(
        source='openclaw', id=selected['id'], previewToken=selected['previewToken'])))
    assert result['ok']
    assert 'OPENAI_MODEL=deepseek-reasoner' in fake_env[0].read_text(encoding='utf-8')
    assert fake_env[1][-1][0]['openai']['model'] == 'deepseek-reasoner'


def test_ccswitch_claude_all_model_aliases_are_selectable(cc_home):
    path = _write_ccswitch_json(cc_home[1])
    data = json.loads(path.read_text(encoding='utf-8'))
    data['claude']['providers']['p1']['settingsConfig']['env'].update({
        'ANTHROPIC_DEFAULT_SONNET_MODEL': 'claude-sonnet-4-6[1m]',
        'ANTHROPIC_DEFAULT_OPUS_MODEL': 'claude-opus-4-6',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL': 'claude-haiku-4-5',
    })
    path.write_text(json.dumps(data), encoding='utf-8')
    candidates, errors = lci.read_ccswitch(path)
    models = [candidate for candidate in candidates if candidate['name'] == 'Relay A']
    assert not errors
    assert [candidate['model'] for candidate in models] == [
        'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5']
    assert len({candidate['id'] for candidate in models}) == 3
    assert lci.read_ccswitch(path)[0] == candidates


def test_large_model_list_keeps_first_choice_preview_valid(cc_home, fake_env):
    path = _write_openclaw(cc_home[0])
    data = json.loads(path.read_text(encoding='utf-8'))
    data['models']['providers']['openai']['models'] = [{'id': f'model-{i}'} for i in range(140)]
    path.write_text(json.dumps(data), encoding='utf-8')
    preview = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source='openclaw')))
    candidate = next(c for c in preview['candidates'] if c['model'] == 'model-0')
    result = asyncio.run(web.api_import_apply(web.ImportApplyRequest(
        source='openclaw', id=candidate['id'], previewToken=candidate['previewToken'])))
    assert result['ok']
    assert 'OPENAI_MODEL=model-0' in fake_env[0].read_text(encoding='utf-8')


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
    assert any("…" in c["keyMasked"] for c in d["candidates"])
    assert all(not any(mark in c["keyMasked"] for mark in "«»《》") for c in d["candidates"])
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
        source="cc-switch", id=cand["id"], slot="openai", previewToken=cand['previewToken'])))
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
    preview = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source="cc-switch", slot='relay')))
    cand = next(c for c in preview["candidates"] if c["name"] == "Relay A")
    asyncio.run(web.api_import_apply(web.ImportApplyRequest(source="cc-switch", id=cand["id"], slot="relay",
                                                           previewToken=cand['previewToken'])))
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
            source="cc-switch", id=cand["id"], slot="openai", previewToken=cand['previewToken'])))
    assert env_file.read_text(encoding="utf-8") == before


def test_portable_source_discovery_uses_current_windows_profile_without_reading_it(cc_home, tmp_path, monkeypatch):
    profile = tmp_path / 'windows-profile'
    source = _write_ccswitch_db(profile / '.cc-switch')
    monkeypatch.setenv('EASEL_PORTABLE', '1')
    monkeypatch.setattr(lci, '_windows_profile_home', lambda: profile)
    monkeypatch.setattr(lci, 'read_ccswitch', lambda *_: pytest.fail('Source discovery must not read credentials'))
    result = asyncio.run(web.api_import_sources())
    found = next(item for item in result['sources'] if item['id'] == 'cc-switch')
    assert found['available'] and Path(found['path']) == source
    assert lci.HOME_CCSWITCH == cc_home[1]
    assert not list(cc_home[1].glob('*'))
    assert lci.openclaw_path() == cc_home[0] / 'openclaw.json'


def test_explicit_ccswitch_directory_and_bom_json_are_supported(cc_home):
    source = _write_ccswitch_json(cc_home[1])
    source.write_text(json.dumps(CCSWITCH_JSON_FIXTURE), encoding='utf-8-sig')
    resolved, error = lci.resolve_source('cc-switch', f'"{cc_home[1]}"')
    assert resolved == source and not error
    candidates, errors = lci.read_source('cc-switch', resolved)
    assert not errors and len(candidates) == 2


def test_ccswitch_display_names_are_not_model_ids_and_short_explicit_keys_are_retained(cc_home):
    data = json.loads(json.dumps(CCSWITCH_JSON_FIXTURE))
    env = data['claude']['providers']['p1']['settingsConfig']['env']
    env.update({'UNRELATED_TOKEN': 'not-the-provider-key', 'ANTHROPIC_AUTH_TOKEN': 'local-key',
                'ANTHROPIC_DEFAULT_SONNET_MODEL': 'claude-sonnet-4-6',
                'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME': '我的日常模型',
                'ANTHROPIC_DEFAULT_OPUS_MODEL': 'claude-opus-4-6',
                'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME': '深度思考显示名称'})
    path = _write_ccswitch_json(cc_home[1])
    path.write_text(json.dumps(data), encoding='utf-8')
    candidates, errors = lci.read_ccswitch(path)
    claude = [item for item in candidates if item['appType'] == 'claude']
    assert not errors
    assert [item['model'] for item in claude] == ['claude-sonnet-4-6', 'claude-opus-4-6']
    assert all(item['key'] == 'local-key' and item['compatible'] for item in claude)


def test_auto_preview_matches_protocol_and_apply_uses_the_confirmed_target(cc_home, fake_env):
    _write_ccswitch_json(cc_home[1])
    env_file, synced = fake_env
    original = env_file.read_text(encoding='utf-8')
    preview = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source='cc-switch', slot='auto')))
    assert preview['slot'] == 'auto'
    claude = next(item for item in preview['candidates'] if item['appType'] == 'claude')
    codex = next(item for item in preview['candidates'] if item['appType'] == 'codex')
    assert claude['compatible'] and claude['targetSlot'] == 'relay'
    assert codex['compatible'] and codex['targetSlot'] == 'openai'
    with pytest.raises(web.HTTPException) as rejected:
        asyncio.run(web.api_import_apply(web.ImportApplyRequest(source='cc-switch', id=claude['id'],
            slot='anthropic', previewToken=claude['previewToken'])))
    assert rejected.value.status_code == 409
    assert env_file.read_text(encoding='utf-8') == original
    result = asyncio.run(web.api_import_apply(web.ImportApplyRequest(source='cc-switch', id=claude['id'],
        slot=claude['targetSlot'], path=preview['path'], previewToken=claude['previewToken'])))
    assert result['ok'] and result['applied']['slot'] == 'relay'
    assert next(row for row in result['channels']['chat']['rows'] if row['slot'] == 'relay')['model'] == 'claude-sonnet-4-6'
    assert 'OPENAI_BASE_URL=https://old.example.com/v1' in env_file.read_text(encoding='utf-8')
    assert set(synced[-1][0]) == {'relay'}


def test_auto_import_prefers_empty_slot_and_keeps_unrelated_existing_configuration(cc_home, fake_env):
    _write_ccswitch_json(cc_home[1])
    env_file, synced = fake_env
    original = env_file.read_text(encoding='utf-8') + 'EASEL_LLM_BASE_URL=https://keep.example/v1\nEASEL_LLM_API_KEY=keep-relay-key\nVIDEO_MODEL=keep-video-model\n'
    env_file.write_text(original, encoding='utf-8')
    oc = cc_home[0] / 'openclaw.json'
    oc.parent.mkdir(parents=True)
    oc.write_text(json.dumps({'models': {'providers': {'relay': {'api': 'anthropic-messages',
        'baseUrl': 'https://keep.example/v1', 'apiKey': 'keep-relay-key'}, 'untouched-custom': {'apiKey': 'custom-test-key'}}}}), encoding='utf-8')
    original_oc = oc.read_bytes()
    preview = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source='cc-switch', slot='auto')))
    selected = next(item for item in preview['candidates'] if item['appType'] == 'claude')
    assert selected['targetSlot'] == 'anthropic'
    assert all(item['field'].startswith('ANTHROPIC_') for item in selected['overwrites'])
    asyncio.run(web.api_import_apply(web.ImportApplyRequest(source='cc-switch', id=selected['id'],
        slot='anthropic', previewToken=selected['previewToken'])))
    updated = env_file.read_text(encoding='utf-8')
    assert all(line in updated for line in original.splitlines())
    assert oc.read_bytes() == original_oc  # This fixture spies on OpenClaw writes.
    assert synced[-1][1] == {'relay', 'untouched-custom'}
    assert set(synced[-1][0]) == {'anthropic'}


def test_same_name_and_endpoint_ccswitch_rows_keep_distinct_database_identities(cc_home, fake_env):
    cc_home[1].mkdir()
    path = cc_home[1] / 'cc-switch.db'
    with sqlite3.connect(path) as con:
        con.execute('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT)')
        for identity, key in [('first', 'first-fixture-key'), ('second', 'second-fixture-key')]:
            cfg = json.loads(json.dumps(CCSWITCH_JSON_FIXTURE['codex']['providers']['p2']['settingsConfig']))
            cfg['auth']['OPENAI_API_KEY'] = key
            con.execute('INSERT INTO providers VALUES (?,?,?,?)', (identity, 'codex', 'Same provider', json.dumps(cfg)))
    preview = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source='cc-switch')))
    assert len({item['id'] for item in preview['candidates']}) == 2
    selected = preview['candidates'][1]
    asyncio.run(web.api_import_apply(web.ImportApplyRequest(source='cc-switch', id=selected['id'],
        previewToken=selected['previewToken'])))
    assert 'OPENAI_API_KEY=second-fixture-key' in fake_env[0].read_text(encoding='utf-8')


@pytest.mark.parametrize('unsafe_base', [
    'https://fixture-user:fixture-password@host.example/v1',
    'https://host.example/v1?key=fixture-query-secret',
    'https://host.example/v1#fixture-fragment-secret',
])
def test_preview_hides_credentials_embedded_in_rejected_urls(cc_home, fake_env, unsafe_base):
    path = _write_ccswitch_json(cc_home[1])
    data = json.loads(path.read_text(encoding='utf-8'))
    data['claude']['providers']['p1']['settingsConfig']['env']['ANTHROPIC_BASE_URL'] = unsafe_base
    path.write_text(json.dumps(data), encoding='utf-8')
    preview = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source='cc-switch', slot='auto')))
    selected = next(item for item in preview['candidates'] if item['appType'] == 'claude')
    blob = json.dumps(preview)
    assert not selected['compatible'] and 'previewToken' not in selected
    assert all(secret not in blob for secret in ['fixture-password', 'fixture-query-secret', 'fixture-fragment-secret'])
    assert selected['baseUrl'] == '（地址格式不兼容，已隐藏）'


def test_responses_remains_explicitly_incompatible_and_does_not_change_target(cc_home, fake_env):
    path = _write_ccswitch_json(cc_home[1])
    data = json.loads(path.read_text(encoding='utf-8'))
    cfg = data['codex']['providers']['p2']['settingsConfig']
    cfg['config'] = cfg['config'].replace('wire_api = "chat"', 'wire_api = "responses"')
    path.write_text(json.dumps(data), encoding='utf-8')
    before = fake_env[0].read_bytes()
    preview = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source='cc-switch', slot='auto')))
    selected = next(item for item in preview['candidates'] if item['appType'] == 'codex')
    assert selected['protocol'] == 'openai-responses' and not selected['compatible']
    assert 'Responses' in selected['skipReason'] and 'previewToken' not in selected
    assert fake_env[0].read_bytes() == before


def discovery_args(cc_home, app_type='codex'):
    path = _write_ccswitch_json(cc_home[1])
    preview = asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source='cc-switch', slot='auto')))
    candidate = next(c for c in preview['candidates'] if c['appType'] == app_type)
    return path, candidate, dict(source='cc-switch', path=str(path), id=candidate['id'],
                                slot=candidate['targetSlot'], previewToken=candidate['previewToken'])


@pytest.mark.parametrize('app_type', ['codex', 'claude'])
def test_source_discovery_uses_exact_source_auth_protocol_without_saving(cc_home, fake_env, monkeypatch, app_type):
    path, candidate, args = discovery_args(cc_home, app_type)
    before = web._model_file_snapshot()
    original_source = path.read_bytes()
    observed = []
    key = 'sk-codex-key-1234567890' if app_type == 'codex' else 'sk-ant-token-1234567890'
    class Response:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self, limit):
            assert limit == 512 * 1024
            return json.dumps({'data': [{'id': 'provider-model-a'}, {'id': 'provider-model-b'}]}).encode()
    class Opener:
        def open(self, request, timeout):
            observed.append(request)
            assert timeout == 10
            return Response()
    def opener(handler):
        assert handler is web._NoRedirect
        return Opener()
    monkeypatch.setattr(web, '_ssrf_safe', lambda _: True)
    monkeypatch.setattr(web.urllib.request, 'build_opener', opener)
    result = asyncio.run(web.api_import_discover(web.ImportApplyRequest(**args)))
    assert result['ok'] and result['models'] == ['provider-model-a', 'provider-model-b']
    assert result['keySource'] == 'source' and result['protocol'] == candidate['protocol']
    assert result['previewToken'] == candidate['previewToken']
    assert result['source'] == candidate['baseUrl'] and result['slot'] == candidate['targetSlot']
    request = observed[0]
    expected_suffix = '/v1/models' if app_type == 'claude' else '/models'
    assert request.full_url == candidate['baseUrl'] + expected_suffix
    assert request.get_method() == 'GET'
    assert (request.get_header('X-api-key') == key if app_type == 'claude' else request.get_header('Authorization') == 'Bearer ' + key)
    assert key not in json.dumps(result)
    assert web._model_file_snapshot() == before and path.read_bytes() == original_source
    assert fake_env[1] == []


def test_model_selection_returns_immutable_token_same_deadline_and_confirm_saves_exact_model(cc_home, fake_env, monkeypatch):
    path, candidate, args = discovery_args(cc_home)
    original_source = path.read_bytes()
    monkeypatch.setattr(web, '_discover_models', lambda *_: {'ok': True, 'kind': 'ok', 'message': 'two', 'models': ['model-a', 'model-b']})
    before = web._model_file_snapshot()
    original = dict(web._IMPORT_PREVIEWS[candidate['previewToken']])
    asyncio.run(web.api_import_discover(web.ImportApplyRequest(**args)))
    first = asyncio.run(web.api_import_model(web.ImportModelRequest(**args, model='model-a')))
    second = asyncio.run(web.api_import_model(web.ImportModelRequest(**args, model='model-b')))
    chained = asyncio.run(web.api_import_model(web.ImportModelRequest(**{**args, 'previewToken': first['previewToken']}, model='model-b')))
    assert len({first['previewToken'], second['previewToken'], candidate['previewToken']}) == 3
    assert first['id'] == second['id'] == candidate['id']
    assert first['model'] == 'model-a' and second['model'] == 'model-b'
    for selected in (first, second, chained):
        record = web._IMPORT_PREVIEWS[selected['previewToken']]
        assert record['expires'] == original['expires']
        assert record['model'] == selected['model'] and record['target'] == original['target']
        assert record['candidate'] == original['candidate'] and 'key' not in selected
    assert web._IMPORT_PREVIEWS[candidate['previewToken']]['model'] == original['model']
    assert any(v['field'] == 'OPENAI_MODEL' and v['incoming'] == 'model-b' for v in second['overwrites'])
    assert web._model_file_snapshot() == before and fake_env[1] == []
    chosen_args = {**args, 'previewToken': second['previewToken']}
    result = asyncio.run(web.api_import_apply(web.ImportApplyRequest(**chosen_args)))
    assert result['ok'] and web._read_env()['OPENAI_MODEL'] == 'model-b'
    assert fake_env[1][-1][0]['openai']['model'] == 'model-b'
    assert next(r for r in result['channels']['chat']['rows'] if r['slot'] == 'openai')['model'] == 'model-b'
    assert 'sk-codex-key-1234567890' not in json.dumps(result)
    assert path.read_bytes() == original_source
    with pytest.raises(web.HTTPException) as changed:
        asyncio.run(web.api_import_apply(web.ImportApplyRequest(**{**args, 'previewToken': first['previewToken']})))
    assert changed.value.status_code == 409


@pytest.mark.parametrize('operation', ['discover', 'model'])
@pytest.mark.parametrize('mutation', ['expired', 'source', 'target', 'slot', 'candidate', 'path'])
def test_source_model_operations_reject_preview_drift_before_network_or_writes(cc_home, fake_env, monkeypatch, tmp_path, operation, mutation):
    path, candidate, args = discovery_args(cc_home)
    record = web._IMPORT_PREVIEWS[candidate['previewToken']]
    record['discoveredModels'] = ['model-a']
    if mutation == 'expired':
        record['expires'] = web.time.monotonic() - 1
    elif mutation == 'source':
        value = json.loads(path.read_text(encoding='utf-8'))
        value['codex']['providers']['p2']['settingsConfig']['auth']['OPENAI_API_KEY'] = 'changed-source-key'
        path.write_text(json.dumps(value), encoding='utf-8')
    elif mutation == 'target':
        fake_env[0].write_text(fake_env[0].read_text(encoding='utf-8') + 'OTHER=external-change\n', encoding='utf-8')
    elif mutation == 'slot':
        args['slot'] = 'relay'
    elif mutation == 'candidate':
        args['id'] = 'not-the-previewed-candidate'
    else:
        other = tmp_path / 'other-source.json'
        other.write_bytes(path.read_bytes())
        args['path'] = str(other)
    before = web._model_file_snapshot()
    monkeypatch.setattr(web, '_discover_models', lambda *_: pytest.fail('invalid preview must not send provider request'))
    with pytest.raises(web.HTTPException) as error:
        if operation == 'discover':
            asyncio.run(web.api_import_discover(web.ImportApplyRequest(**args)))
        else:
            asyncio.run(web.api_import_model(web.ImportModelRequest(**args, model='model-a')))
    assert error.value.status_code == 409
    assert web._model_file_snapshot() == before and fake_env[1] == []


@pytest.mark.parametrize('change', ['expiry', 'source', 'target'])
def test_slow_source_discovery_revalidates_preview_after_response(cc_home, fake_env, monkeypatch, change):
    path, candidate, args = discovery_args(cc_home)
    def discover(*_):
        if change == 'expiry':
            web._IMPORT_PREVIEWS[candidate['previewToken']]['expires'] = web.time.monotonic() - 1
        elif change == 'source':
            value = json.loads(path.read_text(encoding='utf-8'))
            value['codex']['providers']['p2']['settingsConfig']['auth']['OPENAI_API_KEY'] = 'changed-source-key'
            path.write_text(json.dumps(value), encoding='utf-8')
        else:
            fake_env[0].write_text('OTHER=external-change\n', encoding='utf-8')
        return {'ok': True, 'kind': 'ok', 'models': ['model-a'], 'message': 'ok'}
    monkeypatch.setattr(web, '_discover_models', discover)
    with pytest.raises(web.HTTPException) as error:
        asyncio.run(web.api_import_discover(web.ImportApplyRequest(**args)))
    assert error.value.status_code == 409
    assert 'discoveredModels' not in web._IMPORT_PREVIEWS[candidate['previewToken']]
    assert fake_env[1] == []


def test_selection_requires_ids_discovered_for_this_token(cc_home, fake_env, monkeypatch):
    path, candidate, args = discovery_args(cc_home)
    before = web._model_file_snapshot()
    with pytest.raises(web.HTTPException) as missing:
        asyncio.run(web.api_import_model(web.ImportModelRequest(**args, model='gpt-5-codex')))
    assert missing.value.status_code == 400
    monkeypatch.setattr(web, '_discover_models', lambda *_: {'ok': True, 'models': ['model-a'], 'kind': 'ok'})
    asyncio.run(web.api_import_discover(web.ImportApplyRequest(**args)))
    for model in ('not-listed', 'gpt-5-codex', '   '):
        with pytest.raises(web.HTTPException) as rejected:
            asyncio.run(web.api_import_model(web.ImportModelRequest(**args, model=model)))
        assert rejected.value.status_code == 400
    other = next(c for c in asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source='cc-switch', slot='auto')))['candidates'] if c['appType'] == 'claude')
    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_import_model(web.ImportModelRequest(**{**args, 'id': other['id'], 'slot': other['targetSlot'], 'previewToken': other['previewToken']}, model='model-a')))
    assert web._model_file_snapshot() == before


def test_source_discovery_redacts_provider_echo_and_filters_secret_model_ids(cc_home, fake_env, monkeypatch):
    path, candidate, args = discovery_args(cc_home)
    key = 'sk-codex-key-1234567890'
    monkeypatch.setattr(web, '_discover_models', lambda *_: {'ok': True, 'models': [key, 'echo-' + key, 'valid-model', 'unsafe\nmodel'],
                                                          'kind': 'ok', 'message': 'echo ' + key})
    result = asyncio.run(web.api_import_discover(web.ImportApplyRequest(**args)))
    assert result['models'] == ['valid-model'] and key not in json.dumps(result)
    selected = asyncio.run(web.api_import_model(web.ImportModelRequest(**args, model='valid-model')))
    assert key not in json.dumps(selected) and 'key' not in selected


def test_source_discovery_reuses_private_target_rejection_without_credentials_request(cc_home, fake_env, monkeypatch):
    path = _write_ccswitch_json(cc_home[1])
    value = json.loads(path.read_text(encoding='utf-8'))
    cfg = value['codex']['providers']['p2']['settingsConfig']
    cfg['config'] = cfg['config'].replace('https://codex.example.com/v1', 'http://127.0.0.1:9/v1')
    path.write_text(json.dumps(value), encoding='utf-8')
    candidate = next(c for c in asyncio.run(web.api_import_preview(web.ImportPreviewRequest(source='cc-switch', slot='auto')))['candidates'] if c['appType'] == 'codex')
    monkeypatch.setattr(web, '_ssrf_safe', lambda _: False)
    monkeypatch.setattr(web, '_ssrf_safe_allow_local', lambda: False)
    monkeypatch.setattr(web.urllib.request, 'build_opener', lambda *_: pytest.fail('private source target must not be contacted'))
    result = asyncio.run(web.api_import_discover(web.ImportApplyRequest(source='cc-switch', path=str(path),
        id=candidate['id'], slot=candidate['targetSlot'], previewToken=candidate['previewToken'])))
    assert not result['ok'] and result['kind'] == 'blocked_target' and result['models'] == []
    assert 'discoveredModels' not in web._IMPORT_PREVIEWS[candidate['previewToken']]


def test_source_discovery_reuses_no_redirect_handler(cc_home, fake_env, monkeypatch):
    path, candidate, args = discovery_args(cc_home)
    class Opener:
        def open(self, request, timeout):
            raise urllib.error.HTTPError(request.full_url, 302, 'redirect', {}, None)
    def build(handler):
        assert handler is web._NoRedirect and handler().redirect_request(None) is None
        return Opener()
    monkeypatch.setattr(web, '_ssrf_safe', lambda _: True)
    monkeypatch.setattr(web.urllib.request, 'build_opener', build)
    result = asyncio.run(web.api_import_discover(web.ImportApplyRequest(**args)))
    assert not result['ok'] and result['kind'] == 'redirect_blocked'


def test_transcribe_settings_read_real_model_and_base_defaults(cc_home, fake_env):
    row = next(r for r in web._model_channels()['channels']['transcribe']['rows'] if r.get('slot') == 'siliconflow')
    assert row['model'] == 'XingChenAGI/XingChenGSR-V1.0'
    assert row['baseUrl'] == 'https://api.siliconflow.cn/v1'
    assert row['modelEditable'] and row['baseEditable']
    fake_env[0].write_text(fake_env[0].read_text(encoding='utf-8') +
        'SILICONFLOW_ASR_MODEL=provider-asr-model\nSILICONFLOW_BASE_URL=https://asr.example/v1\n', encoding='utf-8')
    row = next(r for r in web._model_channels()['channels']['transcribe']['rows'] if r.get('slot') == 'siliconflow')
    assert row['model'] == 'provider-asr-model' and row['baseUrl'] == 'https://asr.example/v1'


def test_transcribe_model_can_save_reopen_and_empty_draft_preserves_configuration(cc_home, fake_env):
    before = fake_env[0].read_text(encoding='utf-8')
    result = asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(channel='transcribe', rows=[
        web.ModelSaveRow(slot='siliconflow', model='available-asr-model', baseUrl='https://asr.example/v1', key='test-asr-key')])))
    row = next(r for r in result['channels']['transcribe']['rows'] if r.get('slot') == 'siliconflow')
    assert result['ok'] and row['model'] == 'available-asr-model' and row['baseUrl'] == 'https://asr.example/v1'
    assert web._read_env()['SILICONFLOW_ASR_MODEL'] == 'available-asr-model'
    assert all(line in fake_env[0].read_text(encoding='utf-8') for line in before.splitlines())
    snapshot = web._model_file_snapshot()
    with pytest.raises(web.HTTPException) as empty:
        asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(channel='transcribe', rows=[web.ModelSaveRow(slot='siliconflow')])))
    assert empty.value.status_code == 400 and web._model_file_snapshot() == snapshot
    assert 'test-asr-key' not in json.dumps(result) and fake_env[1] == []


def test_transcribe_model_rejects_environment_injection_without_writes(cc_home, fake_env):
    before = web._model_file_snapshot()
    with pytest.raises(web.HTTPException) as invalid:
        asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(channel='transcribe', rows=[
            web.ModelSaveRow(slot='siliconflow', model='asr-model\nOTHER=must-not-write')])))
    assert invalid.value.status_code == 400 and web._model_file_snapshot() == before


def test_transcribe_saved_key_and_implicit_base_can_change_only_model(cc_home, fake_env):
    fake_env[0].write_text(fake_env[0].read_text(encoding='utf-8') + 'SILICONFLOW_API_KEY=existing-asr-test-key\n', encoding='utf-8')
    displayed = next(r for r in web._model_channels()['channels']['transcribe']['rows'] if r.get('slot') == 'siliconflow')
    assert displayed['baseUrl'] == 'https://api.siliconflow.cn/v1'
    result = asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(channel='transcribe', rows=[
        web.ModelSaveRow(slot='siliconflow', model='selected-asr-model', baseUrl=displayed['baseUrl'], key='')])))
    assert result['ok']
    saved = web._read_env()
    assert saved['SILICONFLOW_ASR_MODEL'] == 'selected-asr-model'
    assert saved['SILICONFLOW_API_KEY'] == 'existing-asr-test-key'
    assert saved['SILICONFLOW_BASE_URL'] == displayed['baseUrl']
    assert 'existing-asr-test-key' not in json.dumps(result) and fake_env[1] == []


def test_transcribe_saved_key_and_implicit_base_still_reject_actual_address_change(cc_home, fake_env):
    fake_env[0].write_text(fake_env[0].read_text(encoding='utf-8') + 'SILICONFLOW_API_KEY=existing-asr-test-key\n', encoding='utf-8')
    before = web._model_file_snapshot()
    with pytest.raises(web.HTTPException) as rejected:
        asyncio.run(web.api_settings_models_save(web.ModelSaveRequest(channel='transcribe', rows=[
            web.ModelSaveRow(slot='siliconflow', model='selected-asr-model', baseUrl='https://different-asr.example/v1', key='')])))
    assert rejected.value.status_code == 400 and '重新填写' in rejected.value.detail
    assert web._model_file_snapshot() == before and fake_env[1] == []
