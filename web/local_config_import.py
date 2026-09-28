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
    return bool(re.match(r"^https?://[^\s@]+$", b))


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


def _model_hint(app_type: str, cfg: dict) -> str:
    """从配置里取一个模型名提示（取不到就空着，让用户用「获取模型」或手填）。"""
    env = cfg.get("env") if isinstance(cfg.get("env"), dict) else {}
    if app_type == "claude":
        for k, v in env.items():
            if isinstance(v, str) and re.match(r"ANTHROPIC_(DEFAULT_\w+_)?MODEL(_NAME)?$", k) and v.strip():
                return re.sub(r"\[.*?\]$", "", v).strip()
    if app_type == "codex":
        got = _toml_field(str(cfg.get("config") or ""), "model")
        if got:
            return got
    return ""


def _candidate(source: str, name: str, base: str, key: str, protocol: str,
               app_type: str = "", cfg: dict | None = None, note: str = "") -> dict:
    """归一成导入候选。密钥明文只放在 `key` 里，出网前由端点删除。"""
    cfg = cfg if isinstance(cfg, dict) else {}
    base = (base or "").strip().rstrip("/")
    if not base and isinstance(cfg.get("config"), str):
        base = _toml_field(cfg["config"], "base_url").strip().rstrip("/")   # codex 型配置把地址写在 TOML 文本里
    key = (key or "").strip()
    cid = hashlib.sha1(f"{source}|{name}|{base}".encode("utf-8")).hexdigest()[:12]
    skip = ""
    if _has_oauth(cfg):
        skip = "检测到 OAuth 会话/刷新令牌，不导入"
    elif not base:
        skip = "缺少 Base URL"
    elif not _valid_base(base):
        skip = "Base URL 不是合法的 http(s) 地址"
    elif not key:
        skip = "没有可用的密钥（可能只存了 OAuth 登录态）"
    return {
        "id": cid,
        "source": source,
        "name": (name or base or "未命名").strip()[:80],
        "baseUrl": base,
        "model": _model_hint(app_type, cfg) if cfg else "",
        "protocol": "anthropic" if protocol == "anthropic" else "openai",
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
    return HOME_OPENCLAW / "openclaw.json"


def read_openclaw(path: Path) -> tuple[list[dict], list[str]]:
    """读 openclaw.json 的 models.providers → 候选列表（跳过 app 自身保留的槽位）。"""
    if not path.is_file():
        return [], [f"未找到 {path}"]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        return [], [f"配置解析失败：{type(e).__name__}"]
    provs = ((data or {}).get("models") or {}).get("providers") or {}
    out: list[dict] = []
    for pkey, pv in provs.items():
        if not isinstance(pv, dict):
            continue
        base = str(pv.get("baseUrl") or "").strip()
        key = str(pv.get("apiKey") or "").strip()
        models = pv.get("models") if isinstance(pv.get("models"), list) else []
        mid = ""
        if models and isinstance(models[0], dict):
            mid = str(models[0].get("id") or "").strip()
        protocol = "anthropic" if str(pkey).lower().startswith("anthropic") else "openai"
        cand = _candidate("openclaw", str(pkey), base, key, protocol,
                          app_type="openclaw", cfg=pv, note="来自本机 OpenClaw 配置")
        if mid:
            cand["model"] = mid
        out.append(cand)
    return out, []


# ---- CC Switch ----

def ccswitch_path() -> Path | None:
    db = HOME_CCSWITCH / "cc-switch.db"
    if db.is_file():
        return db
    js = HOME_CCSWITCH / "config.json"
    if js.is_file():
        return js
    return None


def _read_ccswitch_sqlite(path: Path) -> tuple[list[dict], list[str]]:
    con = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    out: list[dict] = []
    errors: list[str] = []
    try:
        rows = con.execute("SELECT app_type, name, settings_config FROM providers").fetchall()
    except sqlite3.OperationalError as e:
        con.close()
        return [], [f"数据库结构不兼容：{e}"]
    for r in rows:
        raw = r["settings_config"]
        try:
            cfg = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except Exception:  # noqa: BLE001
            errors.append(f"{r['name']}: settings_config 不是 JSON，已跳过")
            continue
        protocol = "anthropic" if str(r["app_type"]).lower().startswith("claude") else "openai"
        cand = _candidate("cc-switch", str(r["name"]), _pick_base(cfg), _pick_key(cfg),
                          protocol, app_type=str(r["app_type"]), cfg=cfg)
        out.append(cand)
    con.close()
    return out, errors


def _read_ccswitch_json(path: Path) -> tuple[list[dict], list[str]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        return [], [f"配置解析失败：{type(e).__name__}"]
    out: list[dict] = []
    errors: list[str] = []
    for app_type, section in (data or {}).items():
        if not isinstance(section, dict):
            continue
        for pid, p in (section.get("providers") or {}).items():
            if not isinstance(p, dict):
                continue
            cfg = p.get("settingsConfig") if isinstance(p.get("settingsConfig"), dict) else {}
            protocol = "anthropic" if str(app_type).lower().startswith("claude") else "openai"
            name = str(p.get("name") or pid)
            try:
                out.append(_candidate("cc-switch", name, _pick_base(cfg), _pick_key(cfg),
                                      protocol, app_type=str(app_type), cfg=cfg))
            except Exception as e:  # noqa: BLE001  单条坏了不影响整体
                errors.append(f"{app_type}/{name}: {type(e).__name__}")
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
        p = Path(explicit_path.strip()).expanduser()
        return (p, "") if p.is_file() else (None, f"指定路径不存在：{p}")
    if source == "openclaw":
        p = openclaw_path()
        return (p, "") if p.is_file() else (None, f"未找到 {p}")
    if source == "cc-switch":
        p = ccswitch_path()
        return (p, "") if p else (None, "未找到 ~/.cc-switch 下的 cc-switch.db 或 config.json")
    return None, f"不认识的来源：{source}"


def read_source(source: str, path: Path) -> tuple[list[dict], list[str]]:
    if source == "openclaw":
        return read_openclaw(path)
    if source == "cc-switch":
        return read_ccswitch(path)
    return [], [f"不认识的来源：{source}"]
