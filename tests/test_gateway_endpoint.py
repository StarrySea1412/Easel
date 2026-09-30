"""gateway 端口解析的回归测试。

钉住的坑：Easel 用 ``--profile easel``，而 **OpenClaw 对非默认 profile 不用 18789** ——
它按 ``20000 + fnv1a32(profile) % 40000`` 算，easel → 37289（见 OpenClaw
dist/paths-*.mjs ``resolveGatewayPort``）。Easel 以前在 web/app.py、doctor、ping、
scripts/gateway.* 里各自写死 18789，于是「gateway 活着、面板常驻网关离线」，
``gateway.sh start`` 还会反复 --force 重启一个健康的 gateway。

修法是五端共用 easel/gateway_endpoint.py，且它的优先级与 OpenClaw 逐条对齐。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from easel import gateway_endpoint as ge  # noqa: E402

PORT_ENV_KEYS = ("OPENCLAW_GATEWAY_PORT", "EASEL_GATEWAY_PORT", "EASEL_GATEWAY_HOST")


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    """把 HOME / state dir 挪进 tmp，并且清掉会干扰端口判定的环境变量。"""
    for key in PORT_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("EASEL_OPENCLAW_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "home"))
    return tmp_path


def write_config(tmp_path, gateway: dict | None) -> None:
    cfg = {} if gateway is None else {"gateway": gateway}
    state = tmp_path / "state"
    state.mkdir(parents=True, exist_ok=True)
    (state / "openclaw.json").write_text(json.dumps(cfg), encoding="utf-8")


# ── profile 哈希：就是本 issue 的现场 ──────────────────────────────────


def test_profile_hash_matches_openclaw():
    """easel → 37289。算错这一位，就等于又写死了一个假端口。"""
    assert ge.profile_port("easel") == 37289


def test_default_profile_keeps_18789():
    """只有默认 profile 才是历史默认端口 —— 这正是当初写死 18789 的由来。"""
    assert ge.profile_port("default") == ge.DEFAULT_GATEWAY_PORT
    assert ge.profile_port("") == ge.DEFAULT_GATEWAY_PORT


def test_profile_hash_is_deterministic_and_in_range():
    for name in ("easel", "dev", "staging", "a" * 64):
        port = ge.profile_port(name)
        assert 20000 <= port < 60000
        assert port == ge.profile_port(name)


def test_profile_hash_is_case_sensitive():
    """OpenClaw 的 normalizeProfileName 只在判断是否等于 "default" 时转小写比较，
    参与哈希的仍是原始大小写——"Easel"/"easel" 是两个不同 profile，端口不同。"""
    assert ge.profile_port("Easel") == 45577
    assert ge.profile_port("EASEL") == 48137
    assert ge.profile_port("Easel") != ge.profile_port("easel")


def test_default_profile_name_is_case_insensitive():
    """「是不是 default」这一步判定，OpenClaw 确实是大小写不敏感的。"""
    assert ge.profile_port("Default") == ge.DEFAULT_GATEWAY_PORT
    assert ge.profile_port("DEFAULT") == ge.DEFAULT_GATEWAY_PORT


# ── 解析优先级：环境变量 > openclaw.json > profile 哈希 ────────────────


def test_env_wins_over_config_and_hash(isolated, monkeypatch):
    write_config(isolated, {"port": 37289})
    monkeypatch.setenv("OPENCLAW_GATEWAY_PORT", "19001")
    assert ge.resolve_gateway_port() == 19001
    assert ge.port_source() == "$OPENCLAW_GATEWAY_PORT"


def test_openclaw_env_beats_easel_env(isolated, monkeypatch):
    """gateway 进程只认 OPENCLAW_GATEWAY_PORT，两边冲突时必须跟随它，否则又错配。"""
    monkeypatch.setenv("EASEL_GATEWAY_PORT", "19002")
    monkeypatch.setenv("OPENCLAW_GATEWAY_PORT", "19001")
    assert ge.resolve_gateway_port() == 19001


def test_easel_env_alone_is_honored(isolated, monkeypatch):
    """继承 2026.9 起 gateway_questions 的历史行为：EASEL_GATEWAY_PORT 仍可覆盖。"""
    monkeypatch.setenv("EASEL_GATEWAY_PORT", "19003")
    assert ge.resolve_gateway_port() == 19003
    assert ge.port_source() == "$EASEL_GATEWAY_PORT"


def test_config_beats_hash(isolated):
    write_config(isolated, {"port": 19004})
    assert ge.resolve_gateway_port() == 19004
    assert ge.port_source() == "openclaw.json"


def test_hash_used_when_config_has_no_port(isolated):
    """配置文件存在但没写端口（--allow-unconfigured / 手写配置）→ 哈希兜底。"""
    write_config(isolated, {"mode": "local"})
    assert ge.resolve_gateway_port() == 37289


def test_hash_used_when_config_missing(isolated):
    assert ge.resolve_gateway_port() == 37289


# ── 环境变量写法：与 OpenClaw 的 parseGatewayPortEnvValue 对齐 ─────────


@pytest.mark.parametrize("raw,expected", [
    ("18789", 18789),
    ("  19001  ", 19001),
    ("127.0.0.1:19001", 19001),
    ("[::1]:19002", 19002),
    # OpenClaw 的解析就这么宽：host 部分随便写，只取冒号后的数字。跟着它走，
    # 免得它认、我们不认，又变成端口错配。
    ("1:2", 2),
])
def test_env_port_forms(isolated, monkeypatch, raw, expected):
    monkeypatch.setenv("OPENCLAW_GATEWAY_PORT", raw)
    assert ge.resolve_gateway_port() == expected


@pytest.mark.parametrize("raw", [
    "", "   ", "not-a-port", "0", "65536", "1:2:3", ":19001", "host:", "5.0", "+5",
])
def test_bad_env_port_falls_through(isolated, monkeypatch, raw):
    """非法值不能把解析卡死，也不能退到 0/65536 这种打不通的端口。"""
    monkeypatch.setenv("OPENCLAW_GATEWAY_PORT", raw)
    assert ge.resolve_gateway_port() == 37289


# ── 配置文件容错 ───────────────────────────────────────────────────────


@pytest.mark.parametrize("gateway,expected", [
    (None, 37289),                      # 没有 gateway 段
    ({}, 37289),                        # 空 gateway
    ({"port": None}, 37289),
    ({"port": "19005"}, 37289),         # 字符串：OpenClaw 也不认（typeof number 才用）
    ({"port": True}, 37289),            # bool 是 int 子类，必须排掉
    ({"port": 0}, 37289),
    ({"port": 70000}, 37289),
])
def test_config_rejects_unusable_ports(isolated, gateway, expected):
    write_config(isolated, gateway)
    assert ge.resolve_gateway_port() == expected


def test_config_corrupt_json_falls_through(isolated):
    state = isolated / "state"
    state.mkdir(parents=True, exist_ok=True)
    (state / "openclaw.json").write_text("{ not json", encoding="utf-8")
    assert ge.resolve_gateway_port() == 37289


# ── URL / host 拼装 ────────────────────────────────────────────────────


def test_urls_follow_resolved_port(isolated, monkeypatch):
    monkeypatch.setenv("OPENCLAW_GATEWAY_PORT", "19001")
    assert ge.healthz_url() == "http://127.0.0.1:19001/healthz"
    assert ge.chat_completions_url() == "http://127.0.0.1:19001/v1/chat/completions"


def test_ipv6_host_gets_brackets(isolated, monkeypatch):
    monkeypatch.setenv("EASEL_GATEWAY_HOST", "::1")
    assert ge.gateway_base_url() == "http://[::1]:37289"


# ── Windows 镜像实现（scripts/gateway.ps1）：同一套优先级，不许漂移 ────────
# gateway.ps1 没法 import Python，只能把解析逻辑镜像一份 —— 所以这里把两边拉到一起比。
# 没装 pwsh/powershell 就跳过；装了就会真跑（CI 的 ubuntu / windows runner 两边都预装了 pwsh）。

PWSH = shutil.which("pwsh") or shutil.which("powershell")

PROFILE_CASES = ["easel", "EASEL", "default", "dev"]
ENV_CASES = ["18789", "127.0.0.1:19007", "[::1]:19002", "1:2",
             "not-a-port", "0", "65536", "1:2:3", "5.0"]
CFG_FIXTURES = {
    "number": '{"gateway":{"port":19004}}',
    "string": '{"gateway":{"port":"19005"}}',
    "bool": '{"gateway":{"port":true}}',
    "zero": '{"gateway":{"port":0}}',
    "toobig": '{"gateway":{"port":70000}}',
    "fraction": '{"gateway":{"port":19006.5}}',
    "nogateway": '{"agents":{}}',
    "malformed": '{ not json',
}

# 只做两件事：① 从传进来的源码文本里取出三个函数的定义（不执行脚本主体）；② 把结果打成 JSON。
# 用例内容与源码都用 base64 传入，**不传任何路径**：
#   - 避免两边各维护一份用例造成二次漂移；
#   - Windows pwsh 在 WSL 下不认 POSIX 绝对路径（/home/... 被当成盘符相对路径），
#     而配置目录由 PS 自己建，两边都不需要路径翻译。
#   - 临时目录用 [System.IO.Path]::GetTempPath() 而不是 $env:TEMP：后者在 Linux pwsh
#     下是空的（CI ubuntu-latest 会跑到这条），前者两边都返回可用目录。
#   - ParseInput 而不是 ParseFile：UNC 路径（\\wsl.localhost\...）会让 ParseFile 解析失败。
_PS_HARNESS = r'''
param(
    [Parameter(Mandatory = $true)][string]$GatewayScriptB64,
    [Parameter(Mandatory = $true)][string]$FixturesB64,
    [Parameter(Mandatory = $true)][string]$EnvValues,
    [Parameter(Mandatory = $true)][string]$ProfileNames
)
$ErrorActionPreference = 'Stop'
function Decode-Utf8([string]$B64) {
    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($B64))
}
$src = Decode-Utf8 $GatewayScriptB64
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'gateway.ps1 parse error: ' + $errors[0] }
foreach ($fn in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    . ([scriptblock]::Create($fn.Extent.Text))
}
$out = [ordered]@{ hash = @(); env = [ordered]@{}; cfg = [ordered]@{} }
# hash 用数组而不是哈希表：PS 的哈希表键**不区分大小写**，'easel' 与 'EASEL' 会撞成一个键。
foreach ($name in $ProfileNames.Split(',')) { $out.hash += @{ name = $name; port = (Get-ProfilePort $name) } }
foreach ($raw in $EnvValues.Split(',')) { $out.env[$raw] = ConvertTo-GatewayPort $raw }
$fixtures = (Decode-Utf8 $FixturesB64) | ConvertFrom-Json
$cfgDir = Join-Path ([System.IO.Path]::GetTempPath()) ('easel-cfg-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
try {
    foreach ($prop in $fixtures.PSObject.Properties) {
        Set-Content -LiteralPath (Join-Path $cfgDir 'openclaw.json') -Value $prop.Value -Encoding UTF8
        $out.cfg[$prop.Name] = Get-ConfiguredPort $cfgDir
    }
    Remove-Item -LiteralPath (Join-Path $cfgDir 'openclaw.json') -Force
    $out.cfg['missing'] = Get-ConfiguredPort $cfgDir
}
finally {
    Remove-Item -Recurse -Force $cfgDir -ErrorAction SilentlyContinue
}
$out | ConvertTo-Json -Depth 6 -Compress
'''.lstrip()


def _b64(text: str) -> str:
    import base64
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


@pytest.mark.skipif(not PWSH, reason="需要 pwsh / powershell 才能回归 Windows 镜像实现")
def test_gateway_ps1_mirrors_resolver(isolated):
    """gateway.ps1 的端口解析必须与 easel/gateway_endpoint.py 逐例同解。"""
    harness = isolated / "harness.ps1"
    harness.write_text(_PS_HARNESS, encoding="utf-8")
    gateway_script = (PROJECT_ROOT / "scripts" / "gateway.ps1").read_text(encoding="utf-8")

    proc = subprocess.run(
        [PWSH, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(harness),
         "-GatewayScriptB64", _b64(gateway_script),
         "-FixturesB64", _b64(json.dumps(CFG_FIXTURES)),
         "-EnvValues", ",".join(ENV_CASES),
         "-ProfileNames", ",".join(PROFILE_CASES)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    assert proc.returncode == 0, proc.stderr
    got = json.loads(proc.stdout)

    got_hash = {row["name"]: row["port"] for row in got["hash"]}
    for name in PROFILE_CASES:
        assert got_hash[name] == ge.profile_port(name), name
    for raw in ENV_CASES:
        assert got["env"][raw] == (ge.parse_port_value(raw) or 0), raw

    state = isolated / "state"
    state.mkdir(parents=True, exist_ok=True)
    for key, payload in CFG_FIXTURES.items():
        (state / "openclaw.json").write_text(payload, encoding="utf-8")
        assert got["cfg"][key] == (ge.configured_port() or 0), key
    assert got["cfg"]["missing"] == 0


# ── 别再写死：源码层面钉住 ─────────────────────────────────────────────

GATEWAY_FILES = [
    "web/app.py",
    "easel/commands/doctor.py",
    "easel/commands/ping.py",
    "scripts/gateway.sh",
    "scripts/gateway.ps1",
]


@pytest.mark.parametrize("rel", GATEWAY_FILES)
def test_no_hardcoded_gateway_endpoint(rel):
    """别再用 ``<host>:18789`` 这种字面端点 —— 那正是本 issue 的病灶。

    只盯「端点字面量」和「shell 里直接喂端口」，不盯普通数字：doctor 的说明文字、
    gateway.ps1 里镜像 OpenClaw 的默认端口（只有 default profile 才是 18789）都合法。
    """
    text = (PROJECT_ROOT / rel).read_text(encoding="utf-8")
    for bad in ("127.0.0.1:18789", "localhost:18789", "[::1]:18789",
                "18789/healthz", "18789/v1", "_port_pid 18789", "GATEWAY_PORT=18789"):
        assert bad not in text, f"{rel} 仍有写死的端点：{bad}"


@pytest.mark.parametrize("rel,needle", [
    ("web/app.py", "from easel.gateway_endpoint import"),
    ("easel/commands/doctor.py", "from easel.gateway_endpoint import"),
    ("easel/commands/ping.py", "from easel.gateway_endpoint import"),
    ("scripts/gateway.sh", "resolve_gateway_port"),
    ("scripts/gateway.ps1", "Get-ConfiguredPort"),
    ("scripts/gateway.ps1", "Get-ProfilePort"),
])
def test_port_comes_from_resolver(rel, needle):
    """每个入口都必须真的去查端口，而不是自己造一个。"""
    assert needle in (PROJECT_ROOT / rel).read_text(encoding="utf-8")


def test_gateway_ps1_resolution_order():
    """gateway.ps1 的优先级顺序（环境变量 > 配置 > profile 哈希）不能被打乱。"""
    text = (PROJECT_ROOT / "scripts" / "gateway.ps1").read_text(encoding="utf-8")
    positions = [text.index(needle) for needle in (
        "$Port = ConvertTo-GatewayPort $env:OPENCLAW_GATEWAY_PORT",
        "$Port = ConvertTo-GatewayPort $env:EASEL_GATEWAY_PORT",
        "$Port = Get-ConfiguredPort $ConfigDir",
        "$Port = Get-ProfilePort $Profile",
    )]
    assert positions == sorted(positions)