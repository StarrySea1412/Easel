"""Start and stop one self-contained Windows ZIP, without an installer or downloads.

This deliberately does not reuse the source/installer launchers: a portable copy
owns its interpreters, home directory, configuration and process records. Only
Windows system utilities are used outside the extracted archive.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
import webbrowser


KIND = "easel-windows-portable"
STATE_FILE = "portable-processes.json"
IDENTITY_FILE = "portable-identity.json"
FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0)
LAYOUT = {
    "python": "runtime/python/python.exe",
    "node": "runtime/node/node.exe",
    "openclaw": "runtime/openclaw/node_modules/openclaw/openclaw.mjs",
    "ffmpeg": "runtime/ffmpeg/bin/ffmpeg.exe",
    "browserPath": "runtime/browsers",
}


@dataclass(frozen=True)
class Bundle:
    root: Path
    app: Path
    data: Path
    runtime: dict[str, Path]
    manifest: dict

    @property
    def workspace(self):
        return self.data / "openclaw" / "workspace"

    @property
    def config(self):
        return self.data / "openclaw" / "openclaw.json"

    @property
    def log_path(self):
        return self.data / "logs" / "portable-launch.log"


def _within(path: Path, root: Path) -> Path:
    resolved = path.resolve()
    if resolved == root.resolve() or not resolved.is_relative_to(root.resolve()):
        raise ValueError("便携包路径超出所属目录；未启动或停止任何服务。")
    return resolved


def _relative(root: Path, raw: object) -> Path:
    if not isinstance(raw, str) or not raw or "\0" in raw or ":" in raw:
        raise ValueError("便携清单路径无效。")
    value = PureWindowsPath(raw)
    if value.is_absolute() or value.drive or value.root or ".." in value.parts:
        raise ValueError("便携清单仅允许包内相对路径。")
    return _within(root.joinpath(*value.parts), root)


def load_bundle(root: Path, *, require_runtime: bool = True) -> Bundle:
    root = root.resolve()
    manifest = _read_json(root / "portable-manifest.json", required=True)
    if manifest.get("schemaVersion") != 1 or manifest.get("kind") != KIND:
        raise ValueError("不是受支持的 Easel Windows 便携包。")
    if manifest.get("app") != "app" or manifest.get("data") != "data":
        raise ValueError("便携包 app/data 布局无效，请重新解压官方便携包。")
    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict):
        raise ValueError("便携清单缺少运行环境。")
    paths = {}
    for name, expected in LAYOUT.items():
        raw = runtime.get(name)
        if not isinstance(raw, str) or raw.replace("\\", "/") != expected:
            raise ValueError(f"便携运行环境 {name} 的路径不符合包布局。")
        paths[name] = _relative(root, raw)
        if require_runtime and not (paths[name].is_dir() if name == "browserPath" else paths[name].is_file()):
            raise ValueError(f"便携包缺少 {name}；请完整解压，不会自动安装系统依赖。")
    if runtime.get("git"):
        paths["git"] = _relative(root, runtime["git"])
        if require_runtime and not paths["git"].is_file():
            raise ValueError("便携包缺少清单列出的 Git。")
    bundle = Bundle(root, _relative(root, "app"), _relative(root, "data"), paths, manifest)
    if require_runtime and not (bundle.app / "web/frontend/dist/index.html").is_file():
        raise ValueError("便携包缺少已构建的工作台页面，请重新解压。")
    return bundle


def _read_json(path: Path, *, required: bool = False) -> dict:
    if not path.exists() and not required:
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"无法读取 {path.name}；未根据损坏的记录操作进程。") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} 不是有效记录。")
    return value


def _write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def isolated_env(bundle: Bundle, source: dict | None = None) -> dict[str, str]:
    """Allowlist OS/network settings; never inherit credentials or tool search paths."""
    use_system_proxy = source is None
    source = os.environ if source is None else source
    allowed = {"systemroot", "windir", "comspec", "pathext", "os", "processor_architecture",
               "processor_identifier", "number_of_processors", "http_proxy", "https_proxy",
               "all_proxy", "no_proxy"}
    env = {key: value for key, value in source.items() if key.lower() in allowed}
    # Python's urllib reads Windows Internet Settings, while Node's model SDKs
    # need explicit environment proxies. Keep both runtimes on the same route.
    if use_system_proxy and os.name == 'nt' and not any(k.lower() in ('http_proxy', 'https_proxy', 'all_proxy') for k in env):
        for kind, value in urllib.request.getproxies().items():
            if kind in ('http', 'https'):
                env[kind.upper() + '_PROXY'] = value
    if any(k.lower() in ('http_proxy', 'https_proxy', 'all_proxy') for k in env):
        env['NODE_USE_ENV_PROXY'] = '1'
    system = Path(next((v for k, v in env.items() if k.lower() == "systemroot"), r"C:\Windows"))
    home = bundle.data / "home"
    python, node, entry = (bundle.runtime[k] for k in ("python", "node", "openclaw"))
    paths = [python.parent, python.parent / "Scripts", node.parent,
             entry.parent.parent / ".bin", entry.parent.parent.parent,
             bundle.runtime["ffmpeg"].parent]
    if bundle.runtime.get("git"):
        paths.append(bundle.runtime["git"].parent)
    paths.extend([system / "System32", system, system / "System32/WindowsPowerShell/v1.0"])
    env.update({
        "PATH": os.pathsep.join(map(str, paths)), "PATHEXT": ".COM;.EXE;.BAT;.CMD",
        # Windows expands this in native cache paths; leaving it unset creates
        # literal %SystemDrive% directories under the application working dir.
        "SystemDrive": system.drive,
        "HOME": str(home), "USERPROFILE": str(home),
        "HOMEDRIVE": home.drive, "HOMEPATH": str(home)[len(home.drive):],
        "APPDATA": str(home / "AppData/Roaming"), "LOCALAPPDATA": str(home / "AppData/Local"),
        "TEMP": str(bundle.data / "tmp"), "TMP": str(bundle.data / "tmp"),
        "TMPDIR": str(bundle.data / "tmp"),
        "XDG_CONFIG_HOME": str(home / ".config"), "XDG_DATA_HOME": str(home / ".local/share"),
        "XDG_CACHE_HOME": str(bundle.data / "cache"),
        "HF_HOME": str(bundle.data / "cache/huggingface"),
        "TORCH_HOME": str(bundle.data / "cache/torch"),
        "U2NET_HOME": str(bundle.data / "cache/u2net"),
        "MPLCONFIGDIR": str(bundle.data / "cache/matplotlib"),
        "NUMBA_CACHE_DIR": str(bundle.data / "cache/numba"),
        "PYTHONPYCACHEPREFIX": str(bundle.data / "cache/pycache"),
        "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONNOUSERSITE": "1",
        # Embedded Python ignores PYTHON* variables. Web also receives -B;
        # the prepared runtime's site policy covers later sys.executable jobs.
        "PYTHONDONTWRITEBYTECODE": "1",
        "EASEL_ROOT": str(bundle.app), "EASEL_DATA_DIR": str(bundle.data),
        "EASEL_PYTHON": str(python), "EASEL_HOST": "127.0.0.1", "EASEL_PORTABLE": "1",
        "EASEL_NODE_EXECUTABLE": str(node), "EASEL_OPENCLAW_ENTRY": str(entry),
        "EASEL_OPENCLAW_STATE_DIR": str(bundle.data / "openclaw"),
        "OPENCLAW_STATE_DIR": str(bundle.data / "openclaw"),
        "OPENCLAW_HOME": str(bundle.data / "openclaw-home"),
        "OPENCLAW_CONFIG_PATH": str(bundle.config),
        "OPENCLAW_NO_AUTO_UPDATE": "1",
        "EASEL_OPENCLAW_WORKSPACE": str(bundle.workspace),
        "OPENCLAW_RAW_STREAM": "1",
        "OPENCLAW_RAW_STREAM_PATH": str(bundle.data / "logs/raw-stream.jsonl"),
        "EASEL_RAW_STREAM_PATH": str(bundle.data / "logs/raw-stream.jsonl"),
        "PLAYWRIGHT_BROWSERS_PATH": str(bundle.runtime["browserPath"]),
        "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1",
        "CHROME_LOG_FILE": str(bundle.data / "logs/chromium.log"),
        "NPM_CONFIG_CACHE": str(bundle.data / "cache/npm"),
        "COREPACK_HOME": str(bundle.data / "cache/corepack"),
        "NODE_COMPILE_CACHE": str(bundle.data / "cache/node"),
    })
    # localhost must remain direct even when the user needs an outbound proxy.
    no_proxy = next((v for k, v in env.items() if k.lower() == "no_proxy"), "")
    env["NO_PROXY"] = ",".join(filter(None, [no_proxy, "localhost", "127.0.0.1", "::1"]))
    env["no_proxy"] = env["NO_PROXY"]
    return env


def prepare_directories(bundle: Bundle) -> None:
    names = ["logs", "tmp", "cache", "home", "home/AppData/Roaming", "home/AppData/Local",
             "openclaw", "openclaw/workspace", "openclaw-home", "profiles", "assets"]
    for name in names:
        path = _within(bundle.data / name, bundle.data)
        path.mkdir(parents=True, exist_ok=True)
    # An output location deliberately selected in Web settings can be external.
    # Do not replace that junction or traverse it during ZIP initialization.
    (bundle.data / "outputs").mkdir(exist_ok=True)


def redact(value: object, bundle: Bundle) -> str:
    text = str(value)
    secrets = []
    env_file = bundle.data / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            key, sep, val = line.partition("=")
            if sep and re.search(r"key|token|secret|pass|authorization", key, re.I):
                secrets.append(val.strip().strip("\"'"))
    def collect(value):
        if isinstance(value, dict):
            for key, val in value.items():
                if isinstance(val, str) and re.search(r"key|token|secret|pass|authorization", key, re.I):
                    secrets.append(val)
                else:
                    collect(val)
        elif isinstance(value, list):
            for item in value:
                collect(item)
    try:
        collect(_read_json(bundle.config))
    except (OSError, ValueError):
        pass
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[REDACTED]")
    text = re.sub(r"(?i)(bearer\s+)[^\s\"']+", r"\1[REDACTED]", text)
    return re.sub(r"(?i)((?:api[_-]?key|token|secret|password|authorization)[\"']?\s*[:=]\s*)[^\s,}\"']+",
                  r"\1[REDACTED]", text)


def log(bundle: Bundle, message: str) -> None:
    bundle.log_path.parent.mkdir(parents=True, exist_ok=True)
    with bundle.log_path.open("a", encoding="utf-8") as output:
        output.write(datetime.now(timezone.utc).isoformat(timespec="seconds") + " " + redact(message, bundle) + "\n")


@contextmanager
def bundle_lock(bundle: Bundle):
    bundle.data.mkdir(parents=True, exist_ok=True)
    with (bundle.data / "portable.lock").open("a+b") as handle:
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError("本副本正在启动或退出，请等待完成后重试。") from exc
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def available_port(preferred: int, *, strict: bool = False) -> int:
    if isinstance(preferred, bool) or not isinstance(preferred, int) or not 0 < preferred < 65536:
        raise ValueError("网关或工作台端口无效。")
    with socket.socket() as server:
        try:
            server.bind(("127.0.0.1", preferred))
        except OSError as exc:
            if strict:
                raise RuntimeError("自定义端口已被占用，未停止其他服务；请修改此副本的端口后重试。") from exc
            server.bind(("127.0.0.1", 0))
        return server.getsockname()[1]


def _valid_web_port(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value < 65536


def browser_storage_notice(identity: dict) -> str:
    change = identity.get("webPortChange")
    if not isinstance(change, dict) or not _valid_web_port(change.get("from")) \
            or change.get("to") != identity.get("webPort"):
        return ""
    return (f"原工作台端口 {change['from']} 已被占用，现使用端口 {change['to']}。"
            "浏览器草稿、会话等本地记录与原地址绑定，无法自动迁移；"
            "如有已导出的对话备份，请在新地址导入。未停止占用原端口的服务。")


def select_web_port(bundle: Bundle, identity: dict) -> tuple[int, bool]:
    """A browser origin belongs to this data directory, not to a shared default."""
    previous = identity.get("webPort")
    if previous is None:
        # Fresh ZIPs must not successively share 7860 and its browser storage.
        with socket.socket() as server:
            server.bind(("127.0.0.1", 0))
            selected = server.getsockname()[1]
    else:
        if not _valid_web_port(previous):
            raise ValueError("便携副本保存的工作台端口无效；未从进程记录猜测或抢占端口。")
        selected = available_port(previous)
    changed = previous is not None and previous != selected
    identity["webPort"] = selected
    if changed:
        identity["webPortChange"] = {"from": previous, "to": selected}
    _write_json(bundle.data / IDENTITY_FILE, identity)
    if changed:
        log(bundle, browser_storage_notice(identity))
    elif previous is None:
        log(bundle, f"首次为本副本分配工作台端口 {selected}；后续启动优先保持相同浏览器地址。")
    return selected, changed


def _minimal_config(bundle: Bundle, port: int) -> dict:
    return {"agents": {"defaults": {"workspace": str(bundle.workspace), "timeoutSeconds": 7200}},
            "memory": {"search": {"enabled": False}},
            "gateway": {"mode": "local", "bind": "loopback", "port": port,
                        "auth": {"mode": "none"},
                        "http": {"endpoints": {"chatCompletions": {"enabled": True}}}}}


def _digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _managed_file(bundle: Bundle, identity: dict, path: Path, content: bytes) -> None:
    path = _within(path, bundle.data)
    relative = path.relative_to(bundle.data).as_posix()
    files = identity.setdefault("managedFiles", {})
    if path.exists() and _digest(path.read_bytes()) not in (files.get(relative), _digest(content)):
        # A user may customize instructions/skills. Keep those exact bytes.
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    files[relative] = _digest(content)


def sync_workspace(bundle: Bundle, identity: dict, *, full: bool) -> None:
    if full:
        for source, target in ((bundle.app / "skills/openclaw", bundle.workspace / "skills"),
                               (bundle.app / "skills/shared", bundle.workspace / "shared")):
            if not source.is_dir():
                raise RuntimeError("便携包缺少技能文件，请重新完整解压。")
            for directory, folders, filenames in os.walk(source, followlinks=False):
                folders[:] = [f for f in folders if f not in ("__pycache__", "node_modules", ".git")]
                for name in filenames:
                    if name.endswith((".pyc", ".log")):
                        continue
                    item = Path(directory) / name
                    if item.is_symlink() or not item.resolve().is_relative_to(bundle.app):
                        raise RuntimeError("便携技能文件含指向包外的链接。")
                    _managed_file(bundle, identity, target / item.relative_to(source), item.read_bytes())
        for item in (bundle.app / "openclaw/workspace").glob("*.md"):
            content = item.read_bytes()
            if item.name == "AGENTS.md":
                content += ("\n\n## 便携运行路径约定（覆盖上文源码运行路径）\n\n"
                            "本副本的准确位置见 CONTEXT.md。脚本来自 EASEL_ROOT；配置 .env、画像、素材、"
                            "产物位于 EASEL_DATA_DIR，不能以源码目录是否存在 .env 判断配置。"
                            "支持 --env-file 的脚本使用 EASEL_DATA_DIR 下的 .env。"
                            "easel-profiles/ 指 EASEL_DATA_DIR/profiles/；outputs/ 与 assets/ 分别指 "
                            "EASEL_DATA_DIR 下的同名目录，不能写到技能副本或源码目录。"
                            "运行 Python 使用 EASEL_PYTHON，Windows 参数含空格时按 PowerShell 参数形式引用。\n"
                            ).encode("utf-8")
            _managed_file(bundle, identity, bundle.workspace / item.name, content)
    context = ("# 当前便携副本的运行路径\n\n"
               f"项目根目录（EASEL_ROOT）：{bundle.app}\n"
               f"持久数据目录（EASEL_DATA_DIR）：{bundle.data}\n"
               f"模型配置：{bundle.data / '.env'}\n"
               f"Python（EASEL_PYTHON）：{bundle.runtime['python']}\n"
               f"产物目录：{bundle.data / 'outputs'}\n"
               f"素材目录：{bundle.data / 'assets'}\n"
               f"画像目录：{bundle.data / 'profiles'}\n\n"
               "不要读取宿主机器的模型配置或账号登录态。此文件只描述路径，不包含密钥。\n")
    _managed_file(bundle, identity, bundle.workspace / "CONTEXT.md", context.encode("utf-8"))


def initialize(bundle: Bundle, identity: dict, *, gateway_port: int | None = None) -> tuple[dict, int]:
    """Rebind only values last written by this launcher; preserve user edits."""
    prepare_directories(bundle)
    moved = bool(identity.get("root") and identity["root"] != str(bundle.root))
    identity = dict(identity) if identity else {"schemaVersion": 1, "bundleId": uuid.uuid4().hex}
    owned = identity.setdefault("managedConfig", {})
    config = _read_json(bundle.config)
    created = not config
    if created:
        port = gateway_port or available_port(37289)
        config = _minimal_config(bundle, port)
        owned.update(workspace=str(bundle.workspace), gatewayPort=port)
    else:
        agents = config.get("agents") or {}
        if not isinstance(agents, dict) or not isinstance(agents.get("defaults") or {}, dict):
            raise RuntimeError("便携配置的 agents 格式无效；已保留原文件。")
        defaults = agents.get("defaults") or {}
        workspace = defaults.get("workspace")
        if moved and workspace == owned.get("workspace"):
            defaults["workspace"] = str(bundle.workspace)
            owned["workspace"] = str(bundle.workspace)
        elif workspace != str(bundle.workspace):
            raise RuntimeError("便携配置使用了自定义工作目录。已保留配置；不会自动改写或迁移该目录。")
        entries = list(agents.get("list") or []) if isinstance(agents.get("list"), list) else []
        if isinstance(agents.get("entries"), dict):
            entries.extend(agents["entries"].values())
        for entry in entries:
            if isinstance(entry, dict) and entry.get("workspace"):
                raw = entry["workspace"]
                if not isinstance(raw, str) or not Path(raw).is_absolute() \
                        or not Path(raw).resolve().is_relative_to(bundle.data):
                    raise RuntimeError("成员使用了包外或待迁移的自定义工作目录；已保留配置，未自动改写。")
        gateway = config.get("gateway") or {}
        if not isinstance(gateway, dict):
            raise RuntimeError("便携配置的 gateway 格式无效；已保留原文件。")
        # Do not weaken a user's auth mode or expose a portable service publicly.
        if gateway.get("bind", "loopback") != "loopback":
            raise RuntimeError("便携工作台只支持 loopback 网关；已保留自定义绑定配置，未启动服务。")
        previous = gateway.get("port", 37289)
        port = gateway_port or available_port(previous, strict=previous != owned.get("gatewayPort"))
        if previous == owned.get("gatewayPort"):
            gateway["port"] = port
            owned["gatewayPort"] = port
        elif gateway_port and gateway_port != previous:
            raise RuntimeError("已有网关端口与自定义配置不一致，未自动覆盖。")
    _write_json(bundle.config, config)
    env_file = bundle.data / ".env"
    if not env_file.exists():
        env_file.write_text("# 在 Easel 网页设置中添加自己的模型服务；此文件不含预设凭据。\nANTHROPIC_API_KEY=\n", encoding="utf-8")
    version = str(bundle.manifest.get("sourceCommit") or bundle.manifest.get("version") or "1")
    sync_workspace(bundle, identity, full=created or identity.get("sourceVersion") != version)
    identity.update(root=str(bundle.root), sourceVersion=version)
    _write_json(bundle.data / IDENTITY_FILE, identity)
    if moved:
        log(bundle, "检测到解压目录变化；仅重新绑定本副本先前托管的工作目录和未被修改的路径说明，用户配置与数据保留。")
    elif created:
        log(bundle, "初始化本副本空数据、无密钥配置和技能；没有下载或安装系统依赖。")
    return identity, port


_SNAPSHOT_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$request = $env:EASEL_PORTABLE_INSPECT | ConvertFrom-Json
$all = @(Get-CimInstance Win32_Process)
$byId = @{}
foreach ($item in $all) { $byId[[int]$item.ProcessId] = $item }
$wanted = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($itemId in $request.pids) { [void]$wanted.Add([int]$itemId) }
$listeners = @()
$requestedPorts = [int[]]@($request.ports)
if ($requestedPorts.Count -gt 0) {
    foreach ($connection in @(Get-NetTCPConnection -State Listen -LocalPort $requestedPorts -ErrorAction SilentlyContinue)) {
        if ($connection.LocalAddress -eq '127.0.0.1') {
            [void]$wanted.Add([int]$connection.OwningProcess)
            $listeners += @{port=[int]$connection.LocalPort;pid=[int]$connection.OwningProcess}
        }
    }
}
$queue = New-Object 'System.Collections.Generic.Queue[int]'
foreach ($itemId in $wanted) { $queue.Enqueue($itemId) }
while ($queue.Count -gt 0) {
    $item = $byId[$queue.Dequeue()]
    if ($item -and $item.ParentProcessId -gt 0 -and $wanted.Add([int]$item.ParentProcessId)) {
        $queue.Enqueue([int]$item.ParentProcessId)
    }
}
$records = @()
foreach ($itemId in $wanted) {
    $item = $byId[$itemId]
    if ($item) {
        $records += @{pid=[int]$item.ProcessId;parentId=[int]$item.ParentProcessId;
            created=$item.CreationDate.ToUniversalTime().ToString('o');
            executable=[string]$item.ExecutablePath;commandLine=[string]$item.CommandLine}
    }
}
@{processes=@($records);listeners=@($listeners)} | ConvertTo-Json -Depth 5 -Compress
"""


def snapshot(bundle: Bundle, *, ports=(), pids=()) -> dict:
    if os.name != "nt":
        raise RuntimeError("此便携包只支持 Windows x64。")
    env = isolated_env(bundle)
    env["EASEL_PORTABLE_INSPECT"] = json.dumps({"ports": list(ports), "pids": list(pids)})
    powershell = Path(env.get("SystemRoot", env.get("SYSTEMROOT", r"C:\Windows"))) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    try:
        result = subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-Command", _SNAPSHOT_SCRIPT],
                                env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                timeout=30, creationflags=FLAGS)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("读取本副本的进程状态超时，服务可能仍在运行；请稍后重试。未停止任何程序。") from exc
    if result.returncode:
        raise RuntimeError("无法核验本副本进程归属；没有操作其他进程。")
    try:
        data = json.loads(result.stdout)
        return {"processes": {int(p["pid"]): p for p in data["processes"]},
                "listeners": {int(p["port"]): int(p["pid"]) for p in data["listeners"]}}
    except (ValueError, TypeError, KeyError) as exc:
        raise RuntimeError("进程核验结果无效；没有操作其他进程。") from exc


def _same_path(left, right) -> bool:
    return str(left).replace("/", "\\").casefold() == str(right).replace("/", "\\").casefold()


def matches_process(saved: dict | None, actual: dict | None) -> bool:
    if not saved or not actual:
        return False
    return all(saved.get(key) and saved.get(key) == actual.get(key) for key in ("pid", "created", "commandLine")) \
        and bool(saved.get("executable")) and _same_path(saved["executable"], actual.get("executable"))


def service_owned(record: dict, observed: dict) -> bool:
    return any(matches_process(saved, observed["processes"].get(saved.get("pid")))
               for saved in (record.get("rootProcess"), record.get("listenerProcess")) if saved)


def service_listening(record: dict, observed: dict) -> bool:
    listener = record.get("listenerProcess")
    return bool(listener and matches_process(listener, observed["processes"].get(listener.get("pid")))
                and observed["listeners"].get(record.get("port")) == listener.get("pid"))


def _command_has_argument(command: str, argument: str) -> bool:
    return bool(re.search(r'(?:^|\s)"?' + re.escape(argument.replace("/", "\\")) + r'"?(?=\s|$)',
                          command.replace("/", "\\"), re.I))


def _record_paths(name: str, record: dict, root: Path) -> bool:
    """A copied/edited state file cannot confer ownership of an unrelated PID."""
    if name not in ("web", "gateway") or not isinstance(record, dict):
        return False
    port = record.get("port")
    if isinstance(port, bool) or not isinstance(port, int) or not 0 < port < 65536:
        return False
    executable = root / LAYOUT["python" if name == "web" else "node"]
    script = root / ("app/web/app.py" if name == "web" else LAYOUT["openclaw"])
    original = record.get("rootProcess")
    if not isinstance(original, dict) or not _same_path(original.get("executable"), executable):
        return False
    if not _command_has_argument(str(original.get("commandLine", "")), str(script)):
        return False
    for process in (original, record.get("listenerProcess")):
        if process is None:
            continue
        if not isinstance(process, dict) or not isinstance(process.get("pid"), int) or process["pid"] <= 0 \
                or not process.get("created") or not process.get("commandLine") \
                or not _same_path(process.get("executable"), executable):
            return False
        if name == "web" and not _command_has_argument(str(process["commandLine"]), str(script)):
            return False
        if name == "gateway":
            cmd = str(process["commandLine"])
            if not re.search(r"(?:^|\s)--profile\s+easel(?:\s|$)", cmd) \
                    or not re.search(r"(?:^|\s)--port\s+" + str(port) + r"(?:\s|$)", cmd):
                return False
    return True


def _service_snapshot(bundle: Bundle, state: dict) -> dict:
    records = list((state.get("services") or {}).values())
    pids = [p["pid"] for r in records for p in (r.get("rootProcess"), r.get("listenerProcess")) if p and p.get("pid")]
    ports = [r["port"] for r in records if isinstance(r.get("port"), int) and 0 < r["port"] < 65536]
    return snapshot(bundle, ports=ports, pids=pids) if records else {"processes": {}, "listeners": {}}


def _state(bundle: Bundle) -> tuple[dict, dict]:
    identity = _read_json(bundle.data / IDENTITY_FILE)
    state = _read_json(bundle.data / STATE_FILE)
    if identity and (identity.get("schemaVersion") != 1 or not re.fullmatch(r"[a-f0-9]{32}", str(identity.get("bundleId", "")))):
        raise RuntimeError("便携副本身份记录无效；未操作服务。")
    if "webPort" in identity and not _valid_web_port(identity["webPort"]):
        raise RuntimeError("便携副本保存的工作台端口无效；未操作服务。")
    if state and (state.get("schemaVersion") != 1 or state.get("bundleId") != identity.get("bundleId")
                  or not isinstance(state.get("services"), dict)):
        raise RuntimeError("便携进程记录与本副本不一致；未操作服务。")
    if state and (not isinstance(state.get("root"), str) or not Path(state["root"]).is_absolute()
                  or any(not _record_paths(name, record, Path(state["root"]))
                         for name, record in state["services"].items())):
        raise RuntimeError("便携进程记录含不属于其包目录的程序；未操作服务。")
    return identity, state


def _current_records(bundle: Bundle, identity: dict, state: dict, observed: dict) -> dict:
    if state and state.get("root") != str(bundle.root):
        if any(service_owned(record, observed) for record in state["services"].values()):
            raise RuntimeError("原解压目录的服务仍在运行；请先从原副本退出，再移动整个目录。未停止原服务。")
        return {"schemaVersion": 1, "bundleId": identity.get("bundleId"), "root": str(bundle.root), "services": {}}
    return state or {"schemaVersion": 1, "bundleId": identity.get("bundleId"), "root": str(bundle.root), "services": {}}


def _save_state(bundle: Bundle, state: dict) -> None:
    _write_json(bundle.data / STATE_FILE, state)


def _http_ready(url: str, *, expected: bytes | None = None) -> bool:
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=2) as response:
            if response.status != 200:
                return False
            if expected is not None and response.read(len(expected) + 1) != expected:
                return False
        if expected is not None:
            with opener.open(url + "api/status", timeout=3) as response:
                value = json.load(response)
                return response.status == 200 and isinstance(value, dict) and "gateway" in value and "skills" in value
        return True
    except (OSError, ValueError):
        return False


def validate_config(bundle: Bundle, env: dict) -> None:
    # Check Node without importing OpenClaw first: its recovery launcher can
    # offer to install another runtime when the current Node is incompatible.
    node_check = subprocess.run([str(bundle.runtime["node"]), "-e",
        "const [a,b]=process.versions.node.split('.').map(Number);"
        "if(!((a===24&&b>=16)||(a===26&&b>=1)||a>26))process.exit(2);"
        "if(!process.getBuiltinModule('node:sqlite'))process.exit(3);"],
        cwd=bundle.app, env=env, capture_output=True, timeout=15, creationflags=FLAGS)
    if node_check.returncode:
        raise RuntimeError("包内 Node 版本或 SQLite 支持不匹配；不会下载其他运行时，请重新获取完整便携包。")
    # A successful schema check is reusable only for the exact config and
    # bundled runtime. The gateway still validates its config on every start.
    cache_path = bundle.data / 'portable-config-validation.json'
    fingerprint = hashlib.sha256(bundle.config.read_bytes() + bundle.runtime['openclaw'].read_bytes()
        + json.dumps(bundle.manifest.get('components', {}), sort_keys=True).encode()).hexdigest()
    try:
        cached = _read_json(cache_path)
    except (OSError, ValueError):
        cached = {}
    if cached.get('fingerprint') == fingerprint:
        log(bundle, '配置和内置运行时未变，复用已通过的配置检查；网关启动仍核验配置。')
        return
    with tempfile.TemporaryFile(dir=bundle.data / "tmp") as captured:
        process = subprocess.Popen([str(bundle.runtime["node"]), str(bundle.runtime["openclaw"]),
                                    "--profile", "easel", "config", "validate"],
                                   cwd=bundle.app, env=env, stdin=subprocess.DEVNULL,
                                   stdout=captured, stderr=subprocess.STDOUT, creationflags=FLAGS)
        try:
            # First launch can spend over a minute loading the bundled modules
            # on Windows; keep a bound while allowing the cold validation pass.
            process.wait(timeout=120)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            _terminate_created(process, bundle)
            raise RuntimeError("本副本配置验证超时或被中断；已清理本次验证进程，请查看日志。") from None
        captured.seek(0)
        detail = redact(captured.read().decode("utf-8", errors="replace"), bundle)
    if process.returncode:
        log(bundle, "包内 OpenClaw 配置验证失败：" + detail[-2400:])
        raise RuntimeError("包内 OpenClaw 配置验证失败；保留用户配置，请查看本副本日志。")
    try:
        _write_json(cache_path, {'fingerprint': fingerprint})
    except OSError:
        log(bundle, '配置检查已通过，缓存无法写入；下次启动将重新检查。')


def _terminate_created(process, bundle: Bundle) -> None:
    """Only for a child whose Popen handle this invocation still owns."""
    if process.poll() is not None:
        return
    if os.name == "nt":
        system = Path(os.environ.get("SystemRoot", r"C:\Windows"))
        subprocess.run([str(system / "System32/taskkill.exe"), "/PID", str(process.pid), "/T", "/F"],
                       env=isolated_env(bundle), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=10, creationflags=FLAGS)
    else:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def _launch_service(bundle: Bundle, state: dict, name: str, command: list[str], env: dict,
                    port: int, *, expected: bytes | None = None) -> None:
    output_path = bundle.data / "logs" / ("portable-" + name + ".log")
    with output_path.open("ab") as output:
        process = subprocess.Popen(command, cwd=bundle.app, env=env, stdin=subprocess.DEVNULL,
                                   stdout=output, stderr=output,
                                   creationflags=FLAGS | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    success = False
    try:
        initial = snapshot(bundle, pids=[process.pid])["processes"].get(process.pid)
        if not initial or not initial.get("created") or not initial.get("commandLine") \
                or not _same_path(initial.get("executable"), command[0]):
            raise RuntimeError(f"无法确认新 {name} 进程身份，已撤销本次启动。")
        record = {"port": port, "rootProcess": initial, "listenerProcess": None}
        state["services"][name] = record
        _save_state(bundle, state)
        url = f"http://127.0.0.1:{port}/" + ("healthz" if name == "gateway" else "")
        # Cold module loading can exceed two minutes on Windows while the
        # freshly extracted runtime is scanned. Keep progress visible and
        # permit it to finish, with a bounded wait and owned-process cleanup.
        deadline = time.monotonic() + (300 if name == "gateway" else 90)
        while time.monotonic() < deadline:
            if _http_ready(url, expected=expected):
                observed = snapshot(bundle, ports=[port], pids=[process.pid])
                listener_pid = observed["listeners"].get(port)
                listener = observed["processes"].get(listener_pid)
                cursor, visited = listener, set()
                while cursor and cursor.get("pid") not in visited:
                    visited.add(cursor["pid"])
                    if matches_process(initial, cursor):
                        break
                    cursor = observed["processes"].get(cursor.get("parentId"))
                if not cursor or not matches_process(initial, cursor) or not listener \
                        or not _same_path(listener.get("executable"), command[0]):
                    raise RuntimeError(f"{name} 端口属于其他服务；未复用或停止对方进程。")
                record["listenerProcess"] = listener
                _save_state(bundle, state)
                success = True
                log(bundle, f"本副本 {name} 就绪，端口 {port}，进程归属已核验。")
                return
            if process.poll() is not None:
                break
            time.sleep(0.4)
        raise RuntimeError(f"本副本 {name} 启动失败或超时，请查看 {output_path.name}。")
    finally:
        if not success:
            _terminate_created(process, bundle)
            state["services"].pop(name, None)
            _save_state(bundle, state)


def _stop_service(bundle: Bundle, record: dict, observed: dict) -> bool:
    # An unrelated reused PID is never a reason to stop that process.
    if not service_owned(record, observed):
        return False
    root = record.get("rootProcess")
    listener = record.get("listenerProcess")
    owner = root if root and matches_process(root, observed["processes"].get(root.get("pid"))) else listener
    if not owner:
        return False
    # Refresh immediately before taskkill, narrowing the PID-reuse window.
    current = snapshot(bundle, pids=[owner["pid"]])
    if not matches_process(owner, current["processes"].get(owner["pid"])):
        return False
    system = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    result = subprocess.run([str(system / "System32/taskkill.exe"), "/PID", str(owner["pid"]), "/T", "/F"],
                            env=isolated_env(bundle), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            timeout=10, creationflags=FLAGS)
    if result.returncode:
        raise RuntimeError("本副本服务未能退出，已保留归属记录，请重试退出。")
    return True


def status(bundle: Bundle) -> dict:
    identity, state = _state(bundle)
    observed = _service_snapshot(bundle, state)
    state = _current_records(bundle, identity, state, observed)
    services = {name: bool(service_listening(record, observed)) for name, record in state["services"].items()}
    running = bool(services.get("web") and services.get("gateway"))
    port = (state["services"].get("web") or {}).get("port")
    notice = browser_storage_notice(identity)
    return {"ok": True, "running": running, "services": services,
            "url": f"http://127.0.0.1:{port}/" if services.get("web") else "",
            "message": ("本副本工作台正在运行。" if running else "本副本工作台尚未运行。") + notice,
            "browserStorageNotice": notice,
            "logPath": str(bundle.log_path), "bundleId": identity.get("bundleId")}


def stop(bundle: Bundle) -> dict:
    with bundle_lock(bundle):
        identity, state = _state(bundle)
        observed = _service_snapshot(bundle, state)
        state = _current_records(bundle, identity, state, observed)
        stopped, foreign = [], []
        for name in ("web", "gateway"):
            record = state["services"].get(name)
            if not record:
                continue
            if _stop_service(bundle, record, observed):
                stopped.append(name)
            elif record.get("port") in observed["listeners"]:
                foreign.append(name)
            state["services"].pop(name, None)
            _save_state(bundle, state)
        message = "本副本工作台已退出，数据已保留。"
        if foreign:
            message += " 原记录端口现由其他进程使用，未操作对方服务。"
        log(bundle, message)
        return {"ok": True, "running": False, "stopped": stopped, "url": "", "message": message,
                "logPath": str(bundle.log_path)}


def ensure_local_device_pairing(bundle: Bundle, env: dict) -> None:
    """Initialize this copy's canonical CLI identity through the owned gateway.

    Use its normal signed loopback handshake, never copy identities or write the
    pairing database directly while the gateway owns its SQLite writer.
    """
    config = _read_json(bundle.config, required=True)
    if config.get('gateway', {}).get('bind') != 'loopback':
        raise RuntimeError('便携设备初始化仅支持本副本的本机网关。')
    code = '''from easel.gateway_questions import GatewayClient
c = GatewayClient(timeout=12, scopes=['operator.admin', 'operator.read', 'operator.write'])
try:
    c.connect()
    if 'operator.admin' not in c.granted_scopes:
        raise RuntimeError('local device permissions unavailable')
finally:
    c.close()
'''
    try:
        result = subprocess.run([str(bundle.runtime['python']), '-B', '-c', code],
                                cwd=bundle.app, env=env, capture_output=True,
                                timeout=25, creationflags=FLAGS)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError('本机设备配对核验超时，工作台尚未就绪。') from None
    if result.returncode:
        raise RuntimeError('本机设备配对或权限核验失败，请检查本副本网关日志。')
    log(bundle, '本副本设备配对和模型选择所需权限已核验；未调用模型。')


def start(bundle: Bundle, *, no_browser: bool = False) -> dict:
    began = time.monotonic()
    timings = {}
    previous = ('processCheck', began)
    def phase(name: str, message: str) -> None:
        nonlocal previous
        now = time.monotonic()
        timings[previous[0]] = round(now - previous[1], 3)
        previous = (name, now)
        _write_json(bundle.data / 'portable-startup.json',
                    {'phase': name, 'message': message, 'elapsedSeconds': round(now - began, 1)})
        log(bundle, f'启动阶段：{message}（{now - began:.1f} 秒）')
    with bundle_lock(bundle):
        phase('processCheck', '正在检查本副本服务…')
        identity, state = _state(bundle)
        observed = _service_snapshot(bundle, state)
        state = _current_records(bundle, identity, state, observed)
        services = state["services"]
        owned = {name: service_owned(record, observed) for name, record in services.items()}
        if owned.get("web") and owned.get("gateway"):
            web_port, gateway_port = services["web"]["port"], services["gateway"]["port"]
            expected = (bundle.app / "web/frontend/dist/index.html").read_bytes()
            if not all(service_listening(services[name], observed) for name in ("web", "gateway")) \
                    or not _http_ready(f"http://127.0.0.1:{web_port}/", expected=expected) \
                    or not _http_ready(f"http://127.0.0.1:{gateway_port}/healthz"):
                raise RuntimeError("本副本服务仍在运行但未就绪；请先点击退出，再重新启动。")
            # Upgrade an already running preview only after checking its exact
            # owned process and HTTP identity; unverified state is never a port source.
            if identity.get("webPort") != web_port:
                identity["webPort"] = web_port
                _write_json(bundle.data / IDENTITY_FILE, identity)
            env = isolated_env(bundle)
            env['EASEL_GATEWAY_PORT'] = env['OPENCLAW_GATEWAY_PORT'] = str(gateway_port)
            phase('pairing', '正在核验本机设备权限…')
            ensure_local_device_pairing(bundle, env)
            result = {"ok": True, "running": True, "url": f"http://127.0.0.1:{web_port}/",
                      "webPort": web_port, "gatewayPort": gateway_port, "reused": True,
                      "portChanged": False, "bundleId": identity["bundleId"],
                      "message": "已打开正在运行的本副本工作台。" + browser_storage_notice(identity),
                      "browserStorageNotice": browser_storage_notice(identity),
                      "logPath": str(bundle.log_path)}
        else:
            if owned.get("web"):
                raise RuntimeError("本副本工作台还在运行而网关不可用；请先退出本副本，再重新启动。")
            # Stale/foreign records are discarded only after identity checking.
            for name in list(services):
                if not owned.get(name):
                    services.pop(name)
            existing_gateway = services.get("gateway")
            phase('prepare', '正在准备本副本的数据和技能…')
            identity, gateway_port = initialize(bundle, identity,
                                                 gateway_port=existing_gateway.get("port") if existing_gateway else None)
            state.update(bundleId=identity["bundleId"], root=str(bundle.root))
            _save_state(bundle, state)
            env = isolated_env(bundle)
            env["OPENCLAW_GATEWAY_PORT"] = env["EASEL_GATEWAY_PORT"] = str(gateway_port)
            phase('configValidation', '正在检查模型配置…')
            validate_config(bundle, env)
            started = []
            try:
                if not existing_gateway:
                    phase('gateway', '正在加载内置模型网关…')
                    command = [str(bundle.runtime["node"]), str(bundle.runtime["openclaw"]), "--profile", "easel",
                               "gateway", "run", "--allow-unconfigured", "--bind", "loopback", "--port", str(gateway_port)]
                    _launch_service(bundle, state, "gateway", command, env, gateway_port)
                    started.append("gateway")
                phase('pairing', '正在核验本机设备权限…')
                ensure_local_device_pairing(bundle, env)
                web_port, port_changed = select_web_port(bundle, identity)
                env["EASEL_PORT"] = str(web_port)
                expected = (bundle.app / "web/frontend/dist/index.html").read_bytes()
                phase('web', '正在启动网页工作台…')
                _launch_service(bundle, state, "web", [str(bundle.runtime["python"]), "-B", "-s", str(bundle.app / "web/app.py")],
                                env, web_port, expected=expected)
                started.append("web")
            except BaseException:
                observed = _service_snapshot(bundle, state)
                for name in reversed(started):
                    record = services.get(name)
                    if record and _stop_service(bundle, record, observed):
                        services.pop(name, None)
                _save_state(bundle, state)
                log(bundle, "本次启动未完成；已撤销本次新建的可核验进程，保留数据及先前运行的服务。")
                raise
            result = {"ok": True, "running": True, "url": f"http://127.0.0.1:{web_port}/",
                      "webPort": web_port, "gatewayPort": gateway_port, "bundleId": identity["bundleId"],
                      "reused": False, "portChanged": port_changed,
                      "previousUrl": f"http://127.0.0.1:{identity['webPortChange']['from']}/" if port_changed else "",
                      "browserStorageNotice": browser_storage_notice(identity),
                      "message": "工作台已就绪，请在设置中添加自己的模型服务。" + browser_storage_notice(identity),
                      "logPath": str(bundle.log_path)}
    phase('ready', '工作台已就绪，正在打开页面…' if not no_browser else '工作台已就绪。')
    result.update(startupSeconds=round(time.monotonic() - began, 3), startupTimings=timings)
    if not no_browser:
        webbrowser.open(result["url"])
    return result


def main(argv=None) -> int:
    # The GUI reads a UTF-8 pipe even on machines whose console code page is
    # cp936. Paths and JSON messages must survive Chinese/space directory names.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("start", "status", "stop"))
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    bundle = None
    try:
        if os.name != "nt":
            raise RuntimeError("此便携包只支持 Windows x64。")
        bundle = load_bundle(args.root, require_runtime=args.command == "start")
        result = start(bundle, no_browser=args.no_browser) if args.command == "start" \
            else status(bundle) if args.command == "status" else stop(bundle)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        message = redact(exc, bundle) if bundle else str(exc)
        if bundle:
            try:
                log(bundle, message)
                _write_json(bundle.data / 'portable-startup.json', {'phase': 'error', 'message': message[:300]})
            except OSError:
                pass
        result = {"ok": False, "running": False, "url": "", "message": message, "error": message,
                  "logPath": str(bundle.log_path) if bundle else ""}
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(result["message"])
        if result.get("url"):
            print(result["url"])
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
