"""本机已有 AI 配置的读取与归一（方案功能 C 第二步：可选的「从本机配置导入」）。

只读两个来源，且都由用户在界面上主动选择：
- OpenClaw：`~/.openclaw-easel/openclaw.json` 的 `models.providers`（本应用自己的配置）
- CC Switch：`~/.cc-switch/cc-switch.db`（v3+ SQLite）或 `~/.cc-switch/config.json`（≤2.x）

三条硬规矩：
1. 明文密钥只在进程内流转：预览接口必须删掉 `key` 字段再出网，只留脱敏值与指纹。
2. 不猜协议：认不出来的当作不兼容，宁可让用户手填。
3. OAuth 会话 / 刷新令牌 / 缺 Base URL / 缺密钥的配置一律标不兼容，不导入。
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import os
from urllib.parse import urlsplit
from pathlib import Path

HOME_CCSWITCH = Path.home() / ".cc-switch"
HOME_OPENCLAW = Path.home() / ".openclaw-easel"


def _mask(key: str) -> str:
    """与 app.py 的 _mask_key 同格式，避免同一界面两种脱敏风格。"""
    k = (key or "").strip()
    if not k:
        return ""
    return f"«{k[:5]}…{k[-4:]}»" if len(k) > 14 else "«已配置»"


def _valid_base(base: str) -> bool:
    b = (base or "").strip()
    try:
        url = urlsplit(b)
        return (url.scheme in ("http", "https") and bool(url.hostname)
                and url.port != 0 and not url.username and not url.password
                and not url.query and not url.fragment and not any(c.isspace() for c in b))
    except ValueError:
        return False


def public_base_url(base: str) -> str:
    """Invalid URLs may carry credentials in userinfo/query; never preview them."""
    return base if not base or _valid_base(base) else "（地址格式不兼容，已隐藏）"


def _cc_protocol(app_type: str, cfg: dict) -> str:
    if app_type == "claude":
        return "anthropic"
    if app_type == "codex":
        # Responses and Chat Completions have different request contracts.
        wire = _codex_options(str(cfg.get("config") or "")).get('wire_api')
        return "openai" if wire == "chat" else "openai-responses" if wire == "responses" else "unknown"
    return "unknown"


def _pick_base(obj: object) -> str:
    """递归找第一个 *base_url* 形态的字符串。"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str) and "base_url" in k.lower() and v.strip():
                return v.strip()
        for v in obj.values():
            got = _pick_base(v)
            if got:
                return got
    elif isinstance(obj, list):
        for x in obj:
            got = _pick_base(x)
            if got:
                return got
    return ""


def _pick_key(obj: object) -> str:
    """递归找第一个像密钥的字段值（*_API_KEY / *_AUTH_TOKEN / *_TOKEN / *_KEY）。"""
    cands: list[str] = []

    def walk(o: object) -> None:
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(k, str) and isinstance(v, str) and len(v) >= 16 \
                        and re.search(r"(API_KEY|AUTH_TOKEN|_TOKEN|_KEY)$", k):
                    cands.append(v)
                walk(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)

    walk(obj)
    return cands[0] if cands else ""


def _has_oauth(obj: object) -> bool:
    """配置里出现 OAuth 会话/刷新令牌字段 → 不导入（这些是登录态，不是可搬的 Key）。"""
    def walk(o: object) -> bool:
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(k, str) and re.search(r"refresh_token|access_token|id_token|oauth", k, re.I):
                    return True
                if walk(v):
                    return True
        elif isinstance(o, list):
            return any(walk(x) for x in o)
        return False

    return walk(obj)


def _toml_field(config: str, field: str) -> str:
    m = re.findall(rf'^{field}\s*=\s*"([^"]+)"', config or "", re.M)
    return m[-1].strip() if m else ""


def _codex_options(config: str) -> dict:
    """Only import the active provider; never mix endpoints from different TOML tables."""
    try:
        import tomllib
    except ImportError:  # Python 3.10: accept the unambiguous legacy flat form only.
        if '[' in config:
            return {}
        return {field: _toml_field(config, field) for field in ('base_url', 'wire_api', 'model')}
    try:
        data = tomllib.loads(config)
    except ValueError:
        return {}
    active = data.get('model_provider')
    if active is not None and not isinstance(active, str):
        return {}
    providers = data.get('model_providers', {})
    provider = providers.get(active, {}) if active and isinstance(providers, dict) else data if not active else {}
    if not isinstance(provider, dict):
        return {}
    return {'model': data.get('model', ''), 'base_url': provider.get('base_url', ''),
            'wire_api': provider.get('wire_api', '')}


def _cc_credentials(app_type: str, cfg: dict) -> tuple[str, str]:
    """Read the documented credential fields, not unrelated tokens or key length."""
    def value(obj: dict, name: str) -> str:
        item = obj.get(name)
        return item.strip() if isinstance(item, str) else ""

    if app_type == "claude":
        env = cfg.get("env") if isinstance(cfg.get("env"), dict) else {}
        return value(env, "ANTHROPIC_BASE_URL"), (value(env, "ANTHROPIC_AUTH_TOKEN")
                                                 or value(env, "ANTHROPIC_API_KEY"))
    if app_type == "codex":
        auth = cfg.get("auth") if isinstance(cfg.get("auth"), dict) else {}
        options = _codex_options(str(cfg.get("config") or ""))
        return value(options, "base_url"), value(auth, "OPENAI_API_KEY")
    return _pick_base(cfg), _pick_key(cfg)


def _model_hints(app_type: str, cfg: dict) -> list[str]:
    """保留配置里明确给出的全部模型，供用户选择，而不是只取第一项。"""
    env = cfg.get("env") if isinstance(cfg.get("env"), dict) else {}
    models: list[str] = []
    if app_type == "claude":
        for k, v in env.items():
            # CC Switch's *_MODEL_NAME fields are display labels, not model IDs.
            if isinstance(v, str) and re.fullmatch(r"ANTHROPIC_(DEFAULT_\w+_)?MODEL", k) and v.strip():
                models.append(re.sub(r"\[.*?\]$", "", v).strip())
    if app_type == "codex":
        got = _codex_options(str(cfg.get("config") or "")).get('model', '')
        if isinstance(got, str) and got.strip():
            models.append(got.strip())
    return list(dict.fromkeys(m for m in models if m))


def _expand_models(candidate: dict, models: list[str]) -> list[dict]:
    """每个模型拥有可重复读取的候选 ID，导入时仍校验完整候选指纹。"""
    unique = list(dict.fromkeys(m.strip() for m in models if isinstance(m, str) and m.strip()))
    if not unique:
        return [candidate]
    return [{**candidate, "model": model,
             "id": hashlib.sha1(f'{candidate["id"]}|{model}'.encode('utf-8')).hexdigest()[:12]
             if len(unique) > 1 else candidate["id"]} for model in unique]


def _candidate(source: str, name: str, base: str, key: str, protocol: str,
               app_type: str = "", cfg: dict | None = None, note: str = "", source_id: str = "") -> dict:
    """归一成导入候选。密钥明文只放在 `key` 里，出网前由端点删除。"""
    cfg = cfg if isinstance(cfg, dict) else {}
    base = (base or "").strip().rstrip("/")
    if app_type == 'codex' and isinstance(cfg.get('config'), str):
        base = str(_codex_options(cfg['config']).get('base_url') or '').strip().rstrip('/')
    key = (key or "").strip()
    cid = hashlib.sha1(f"{source}|{app_type}|{source_id}|{name}|{base}".encode("utf-8")).hexdigest()[:12]
    skip = ""
    if _has_oauth(cfg):
        skip = "检测到 OAuth 会话/刷新令牌，不导入"
    elif not base:
        skip = "缺少 Base URL"
    elif not _valid_base(base):
        skip = "Base URL 不是合法的 http(s) 地址"
    elif not key:
        skip = "没有可用的密钥（可能只存了 OAuth 登录态）"
    elif protocol == "openai-responses":
        skip = "此配置使用 Responses；当前对话通道仅支持 Chat Completions / Anthropic Messages，不能直接导入"
    elif protocol not in ("openai", "anthropic"):
        skip = "协议未明确或当前通道不支持，不能直接导入"
    elif any(c.isspace() for c in key):
        skip = "密钥包含空白字符"
    return {
        "id": cid,
        "source": source,
        "name": (name or (base if _valid_base(base) else "") or "未命名").strip()[:80],
        "baseUrl": base,
        "model": next(iter(_model_hints(app_type, cfg)), "") if cfg else "",
        "protocol": protocol,
        "appType": app_type,
        "note": note,
        "keyPresent": bool(key),
        "keyMasked": _mask(key),
        "key": key,                 # 内部字段：预览端点必须 pop 掉
        "compatible": not skip,
        "skipReason": skip,
    }


# ---- OpenClaw（本应用自己的配置） ----

def openclaw_path() -> Path:
    return Path(os.environ.get("EASEL_OPENCLAW_STATE_DIR") or HOME_OPENCLAW) / "openclaw.json"


def read_openclaw(path: Path) -> tuple[list[dict], list[str]]:
    """读 openclaw.json 的 models.providers，将每个明确配置的模型作为候选。"""
    if not path.is_file():
        return [], [f"未找到 {path}"]
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as e:  # noqa: BLE001
        return [], [f"配置解析失败：{type(e).__name__}"]
    if not isinstance(data, dict) or not isinstance(data.get("models", {}), dict):
        return [], ["配置结构不兼容"]
    provs = data.get("models", {}).get("providers") or {}
    if not isinstance(provs, dict):
        return [], ["服务商列表结构不兼容"]
    out: list[dict] = []
    for pkey, pv in provs.items():
        if not isinstance(pv, dict):
            continue
        base = str(pv.get("baseUrl") or "").strip()
        key = str(pv.get("apiKey") or "").strip()
        models = pv.get("models") if isinstance(pv.get("models"), list) else []
        model_ids = [str(model.get("id") or "").strip() for model in models if isinstance(model, dict)]
        api = str(pv.get("api") or "")
        protocol = {"anthropic-messages": "anthropic", "openai-completions": "openai",
                    "openai-responses": "openai-responses"}.get(api, "unknown")
        if not api:
            protocol = {"openai": "openai", "anthropic": "anthropic", "relay": "anthropic"}.get(pkey, "unknown")
        cand = _candidate("openclaw", str(pkey), base, key, protocol,
                          app_type="openclaw", cfg=pv, note="来自本机 OpenClaw 配置")
        out.extend(_expand_models(cand, model_ids))
    return out, []


# ---- CC Switch ----

def _windows_profile_home() -> Path | None:
    """Ask Windows for the current user's profile, independently of portable HOME."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        buffer = ctypes.create_unicode_buffer(32768)
        # CSIDL_PROFILE; this does not enumerate other users or read credentials.
        if ctypes.windll.shell32.SHGetFolderPathW(None, 0x0028, None, 0, buffer) == 0 and buffer.value:
            return Path(buffer.value)
    except (AttributeError, OSError):
        pass
    return None


def _ccswitch_file(directory: Path) -> Path | None:
    db = directory / "cc-switch.db"
    if db.is_file():
        return db
    js = directory / "config.json"
    if js.is_file():
        return js
    return None


def ccswitch_path() -> Path | None:
    # Runtime HOME remains isolated. Only this user-requested import source uses
    # the current Windows profile; source discovery itself reads no file content.
    if os.environ.get("EASEL_PORTABLE") == "1":
        profile = _windows_profile_home()
        if profile is not None:
            path = _ccswitch_file(profile / ".cc-switch")
            if path is not None:
                return path
    return _ccswitch_file(HOME_CCSWITCH)


def _read_ccswitch_sqlite(path: Path) -> tuple[list[dict], list[str]]:
    con = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    out: list[dict] = []
    errors: list[str] = []
    try:
        columns = {row[1] for row in con.execute("PRAGMA table_info(providers)")}
        source_id = "id" if "id" in columns else "''"
        rows = con.execute(f"SELECT {source_id} AS source_id, app_type, name, settings_config FROM providers").fetchall()
    except sqlite3.OperationalError:
        con.close()
        return [], ["数据库结构不兼容"]
    for r in rows:
        raw = r["settings_config"]
        try:
            cfg = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except Exception:  # noqa: BLE001
            errors.append("settings_config 不是 JSON，已跳过")
            continue
        if not isinstance(cfg, dict):
            errors.append("settings_config 结构不兼容，已跳过")
            continue
        app_type = str(r["app_type"])
        protocol = _cc_protocol(app_type, cfg)
        base, key = _cc_credentials(app_type, cfg)
        cand = _candidate("cc-switch", str(r["name"]), base, key,
                          protocol, app_type=app_type, cfg=cfg, source_id=str(r["source_id"]))
        out.extend(_expand_models(cand, _model_hints(str(r["app_type"]), cfg)))
    con.close()
    return out, errors


def _read_ccswitch_json(path: Path) -> tuple[list[dict], list[str]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as e:  # noqa: BLE001
        return [], [f"配置解析失败：{type(e).__name__}"]
    out: list[dict] = []
    errors: list[str] = []
    if not isinstance(data, dict):
        return [], ["配置结构不兼容"]
    for app_type, section in (data or {}).items():
        if not isinstance(section, dict):
            continue
        providers = section.get("providers") or {}
        if not isinstance(providers, dict):
            errors.append("服务商列表结构不兼容，已跳过")
            continue
        for pid, p in providers.items():
            if not isinstance(p, dict):
                continue
            cfg = p.get("settingsConfig") if isinstance(p.get("settingsConfig"), dict) else {}
            protocol = _cc_protocol(str(app_type), cfg)
            name = str(p.get("name") or pid)
            try:
                base, key = _cc_credentials(str(app_type), cfg)
                cand = _candidate("cc-switch", name, base, key,
                                  protocol, app_type=str(app_type), cfg=cfg, source_id=str(pid))
                out.extend(_expand_models(cand, _model_hints(str(app_type), cfg)))
            except Exception as e:  # noqa: BLE001  单条坏了不影响整体
                errors.append(f"条目解析失败：{type(e).__name__}")
    return out, errors


def read_ccswitch(path: Path) -> tuple[list[dict], list[str]]:
    if not path.is_file():
        return [], [f"未找到 {path}"]
    if path.suffix.lower() == ".db":
        return _read_ccswitch_sqlite(path)
    return _read_ccswitch_json(path)


SOURCES: dict[str, dict] = {
    "openclaw": {"label": "OpenClaw 配置（本机）", "note": "本应用自己的网关配置，只读"},
    "cc-switch": {"label": "CC Switch", "note": "读取其 provider 列表，只读，不回明文密钥"},
}


def resolve_source(source: str, explicit_path: str = "") -> tuple[Path | None, str]:
    """定位来源文件 → (路径, 错误)。explicit_path 是用户主动指定的其它位置。"""
    if explicit_path.strip():
        supplied = explicit_path.strip()
        if len(supplied) >= 2 and supplied[0] == supplied[-1] and supplied[0] in ('"', "'"):
            supplied = supplied[1:-1]
        p = Path(supplied).expanduser()
        if source == "cc-switch" and p.is_dir():
            found = _ccswitch_file(p)
            return (found, "") if found else (None, "指定目录下未找到 cc-switch.db 或 config.json")
        return (p, "") if p.is_file() else (None, f"指定路径不存在：{p}")
    if source == "openclaw":
        p = openclaw_path()
        return (p, "") if p.is_file() else (None, f"未找到 {p}")
    if source == "cc-switch":
        p = ccswitch_path()
        return (p, "") if p else (None, "未找到当前用户的 CC Switch 配置，可指定 .cc-switch 目录或配置文件")
    return None, f"不认识的来源：{source}"


def read_source(source: str, path: Path) -> tuple[list[dict], list[str]]:
    try:
        if source == "openclaw":
            return read_openclaw(path)
        if source == "cc-switch":
            return read_ccswitch(path)
    except (OSError, sqlite3.Error, ValueError, TypeError):
        return [], ["无法读取来源配置，请检查文件格式和访问权限"]
    return [], [f"不认识的来源：{source}"]
