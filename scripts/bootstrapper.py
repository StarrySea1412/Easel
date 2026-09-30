"""Windows online installer; release EXEs embed a fixed version, URL and SHA-256."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import http.client
import json
import os
import re
import shutil
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

RELEASE_API = "https://api.github.com/repos/ZJU-REAL/Easel/releases"
USER_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "Easel"
DOWNLOAD_TIMEOUT = 120
MAX_DOWNLOAD_RETRY = 3
RETRY_BACKOFF = (5, 15)
MAX_ARCHIVE_BYTES = 2 * 1024**3
MARKER = ".easel-release.json"
_LOG_HOOK = None
_DLL_SEARCH_LOCK = threading.RLock()


def _set_dll_directory(path: str | None) -> None:
    import ctypes
    if not ctypes.windll.kernel32.SetDllDirectoryW(path):
        raise ctypes.WinError()


@contextmanager
def system_dll_search():
    """External programs must not inherit the frozen installer's temporary DLLs.

    Windows propagates SetDllDirectory to child processes. A long-lived Node
    Gateway otherwise loads VCRUNTIME140.dll from _MEI, preventing the one-file
    bootloader from cleaning up and leaving a modal warning on installer exit.
    """
    if os.name != 'nt' or not getattr(sys, 'frozen', False):
        yield
        return
    with _DLL_SEARCH_LOCK:
        _set_dll_directory(None)
        try:
            yield
        finally:
            _set_dll_directory(str(sys._MEIPASS))


def external_popen(*args, **kwargs):
    with system_dll_search():
        return subprocess.Popen(*args, **kwargs)


def external_run(*args, **kwargs):
    with system_dll_search():
        return subprocess.run(*args, **kwargs)


def log(msg: str) -> None:
    line = f"[easel-installer] {msg}"
    if _LOG_HOOK is not None:
        _LOG_HOOK(line)
    elif sys.stdout is not None:
        print(line, flush=True)


def redact_install_output(value: str, base: Path) -> str:
    """Mirror install_runner.redact before displaying PowerShell output."""
    values = dict(os.environ)
    try:
        for line in (base / ".env").read_text(encoding="utf-8-sig").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, secret = line.split("=", 1)
                values[key.strip()] = secret.strip().strip("\"'")
    except OSError:
        pass
    for key, secret in values.items():
        if secret and re.search(r"key|token|secret|password|authorization", key, re.I):
            value = value.replace(secret, "[REDACTED]")
    value = re.sub(r"(?i)(bearer\s+)[^\s\"']+", r"\1[REDACTED]", value)
    value = re.sub(
        r"(?i)([\"']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)[\"']?\s*[:=]\s*)[\"']?[^\s,}\"']+",
        r"\1[REDACTED]", value,
    )
    value = re.sub(r"(?i)(https?://)[^/\s@]+@", r"\1[REDACTED]@", value)
    return value


def normalize_version(version: str) -> str:
    if not isinstance(version, str):
        raise RuntimeError("版本必须是字符串")
    version = version.removeprefix("v")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?", version):
        raise RuntimeError("版本必须是 0.2.1 或 0.2.1-rc.1 格式")
    return version


def validate_url(url: str) -> str:
    if not isinstance(url, str):
        raise RuntimeError("下载地址必须是 HTTPS 字符串")
    p = urllib.parse.urlsplit(url)
    if p.scheme != "https" or not p.hostname or p.username or p.password or p.fragment or p.query:
        raise RuntimeError("下载地址必须是无凭证、无查询参数的 HTTPS URL")
    return url


def valid_sha256(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", value):
        raise RuntimeError("没有有效 SHA-256，拒绝安装未验证归档")
    return value.lower()


def _transient(exc: Exception) -> bool:
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code in (408, 429, 500, 502, 503, 504)
    if isinstance(exc, urllib.error.URLError):
        return not isinstance(exc.reason, (PermissionError, ValueError, ssl.SSLCertVerificationError))
    return isinstance(exc, (TimeoutError, ConnectionError, http.client.IncompleteRead))


def _request(url: str, consume):
    validate_url(url)
    for attempt in range(MAX_DOWNLOAD_RETRY):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "easel-installer"})
            with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as resp:
                if hasattr(resp, "geturl") and urllib.parse.urlsplit(resp.geturl()).scheme != "https":
                    raise RuntimeError("拒绝下载重定向到非 HTTPS 地址")
                return consume(resp)
        except (urllib.error.URLError, OSError, http.client.IncompleteRead) as exc:
            code = f"HTTP {exc.code}" if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__
            if not _transient(exc) or attempt + 1 == MAX_DOWNLOAD_RETRY:
                raise RuntimeError(f"下载失败：{code}（共 {attempt + 1} 次尝试）") from exc
            delay = RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)]
            log(f"下载暂时失败（{code}），{delay}s 后重试")
            time.sleep(delay)


def fetch_release(version: str) -> dict:
    version = normalize_version(version)
    data = _request(f"{RELEASE_API}/tags/v{version}", lambda r: json.loads(r.read(2**20)))
    if data.get("tag_name") != f"v{version}" or data.get("draft"):
        raise RuntimeError("Release 版本不匹配或尚未发布")
    assets = [{"name": a["name"], "url": a["browser_download_url"], "size": a["size"]}
              for a in data.get("assets", [])]
    if not assets:
        raise RuntimeError("Release 没有附带归档资产")
    return {"tag": data["tag_name"], "assets": assets}


def pick_archive(assets: list[dict], version: str) -> dict:
    name = f"Easel-{normalize_version(version)}-windows.zip"
    matches = [a for a in assets if a["name"] == name]
    if len(matches) != 1:
        raise RuntimeError(f"Release 必须包含唯一的 {name} 归档")
    return matches[0]


def _sidecar_sha256(url: str) -> str:
    content = _request(url + ".sha256", lambda r: r.read(4096).decode("ascii").strip())
    return valid_sha256(content.split()[0] if content else "")


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download_with_retry(url: str, dest: Path, expected_sha256: str = "") -> Path:
    validate_url(url)
    want = valid_sha256(expected_sha256 or _sidecar_sha256(url))
    part = dest.with_name(dest.name + ".part")

    def consume(resp):
        size = 0
        with part.open("wb") as f:
            while chunk := resp.read(1 << 20):
                size += len(chunk)
                if size > MAX_ARCHIVE_BYTES:
                    raise RuntimeError("归档超过允许的大小")
                f.write(chunk)
    try:
        _request(url, consume)
        if sha256_of(part) != want:
            raise RuntimeError("归档 SHA-256 校验失败，已拒绝安装")
        part.replace(dest)
        return dest
    finally:
        part.unlink(missing_ok=True)


def install_root(version: str) -> Path:
    return USER_DIR / "versions" / normalize_version(version)


def _safe_members(z: zipfile.ZipFile) -> None:
    members = z.infolist()
    if len(members) > 100_000 or sum(m.file_size for m in members) > MAX_ARCHIVE_BYTES:
        raise RuntimeError("解压后的归档过大")
    seen: set[str] = set()
    spellings: dict[str, str] = {}
    for member in members:
        name = member.filename
        parts = PurePosixPath(name).parts
        if not parts or name.startswith("/") or "\\" in name or "\x00" in name:
            raise RuntimeError(f"归档含不安全路径：{name!r}")
        for part in parts:
            if part in (".", "..") or part.endswith((".", " ")) or re.search(r'[<>:"|?*\x00-\x1f]', part) or re.fullmatch(
                    r"(?i:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?", part):
                raise RuntimeError(f"归档含不安全路径：{name!r}")
        if stat.S_IFMT(member.external_attr >> 16) not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise RuntimeError("归档不允许符号链接或特殊文件")
        key = "/".join(parts).casefold()
        if key in seen:
            raise RuntimeError("归档包含重复路径")
        seen.add(key)
        for i in range(1, len(parts) + 1):
            spelling = "/".join(parts[:i])
            if spellings.setdefault(spelling.casefold(), spelling) != spelling:
                raise RuntimeError("归档包含 Windows 大小写冲突路径")


def extract_to(zip_path: Path, dest: Path, version: str | None = None,
               digest: str | None = None) -> Path:
    """Validate, flatten a single wrapper and atomically publish the directory."""
    if dest.exists() and any(dest.iterdir()):
        raise RuntimeError(f"目标目录已非空，保留原目录，请检查：{dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".easel-extract-", dir=dest.parent) as temp:
        stage = Path(temp) / "payload"
        stage.mkdir()
        with zipfile.ZipFile(zip_path) as z:
            _safe_members(z)
            required = sum(member.file_size for member in z.infolist())
            if shutil.disk_usage(dest.parent).free < required + 16 * 1024**2:
                raise RuntimeError("目标磁盘空间不足，尚未写入版本目录")
            z.extractall(stage)
        entries = list(stage.iterdir())
        source = entries[0] if len(entries) == 1 and entries[0].is_dir() else stage
        if not (source / "setup.ps1").is_file():
            raise RuntimeError("归档缺少 setup.ps1")
        if version is not None:
            manifest = json.loads((source / "release-manifest.json").read_text(encoding="utf-8"))
            if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1 or manifest.get("version") != version:
                raise RuntimeError("归档清单版本不匹配")
            for required in ("easel/install_runner.py", "web/frontend/dist/index.html", "requirements-windows.lock"):
                if not (source / required).is_file():
                    raise RuntimeError(f"归档缺少 {required}")
            (source / MARKER).write_text(json.dumps({"version": version, "sha256": digest}), encoding="utf-8")
        if dest.exists():
            dest.rmdir()
        source.replace(dest)
    return dest


def data_root() -> Path:
    return USER_DIR / "data"


def is_link(path: Path) -> bool:
    """Detect Windows junctions on Python 3.10/3.11 as well as symlinks."""
    if path.is_symlink():
        return True
    try:
        return bool(getattr(path.lstat(), "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))
    except OSError:
        return False


def copy_missing(src: Path, dest: Path) -> None:
    """Copy missing files recursively, excluding links; never overwrite user data."""
    if is_link(src):
        return
    if is_link(dest):
        raise RuntimeError(f"迁移目标不能是目录链接：{dest}")
    if src.is_dir():
        dest.mkdir(parents=True, exist_ok=True)
        for child in src.iterdir():
            copy_missing(child, dest / child.name)
    elif src.is_file() and not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Publish a complete file without overwriting anything a concurrent user created.
        with tempfile.NamedTemporaryFile(dir=dest.parent, prefix=".easel-copy-", delete=False) as target:
            temp = Path(target.name)
            try:
                with src.open("rb") as source:
                    shutil.copyfileobj(source, target)
            except BaseException:
                target.close()
                temp.unlink(missing_ok=True)
                raise
        try:
            try:
                os.link(temp, dest)
            except FileExistsError:
                pass
        finally:
            temp.unlink(missing_ok=True)


def init_data_dir(src_root: Path) -> Path:
    dd = data_root()
    dd.mkdir(parents=True, exist_ok=True)
    if src_root.resolve() == dd.resolve():
        return dd
    for name in ("profiles", "outputs", "assets"):
        (dd / name).mkdir(exist_ok=True)
        copy_missing(src_root / name, dd / name)
    copy_missing(src_root / ".env", dd / ".env")
    return dd


def _ps_literal(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def link_data_dirs(root: Path, dd: Path) -> None:
    """Junctions support legacy skills that resolve data relative to their source."""
    for name in ("profiles", "outputs", "assets"):
        link, target = root / name, (dd / name).absolute()
        if link.resolve() == target.resolve():
            continue
        if is_link(link):
            raise RuntimeError(f"数据链接指向意外目录：{link}")
        if link.exists():
            backup = root / ".bundled-data-seed" / name
            backup.parent.mkdir(exist_ok=True)
            if not link.resolve().is_relative_to(root.resolve()) or not backup.resolve().is_relative_to(root.resolve()):
                raise RuntimeError("数据路径超出版本目录")
            link.rename(backup)
        if os.name == "nt":
            command = f"$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path {_ps_literal(link)} -Target {_ps_literal(target)} | Out-Null"
            result = external_run(["powershell", "-NoProfile", "-NonInteractive", "-Command", command], check=False)
            if result.returncode:
                raise RuntimeError(f"创建数据目录链接失败：{link}")
        else:
            link.symlink_to(target, target_is_directory=True)


def run_setup(project_root: Path, dd: Path, allow_winget: bool,
              migrate_from: Path | None = None) -> int:
    env = os.environ.copy()
    env.update(EASEL_DATA_DIR=str(dd), PYTHONUTF8="1",
               EASEL_INSTALL_ALLOW_WINGET="1" if allow_winget else "0")
    env.pop("EASEL_INSTALL_MIGRATE_FROM", None)
    if migrate_from is not None:
        env["EASEL_INSTALL_MIGRATE_FROM"] = str(migrate_from.resolve())
    # setup creates the external Python venv; frozen sys.executable is not Python.
    cmd = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
           "-File", str(project_root / "setup.ps1"), "-NonInteractive", "-DataDir", str(dd)]
    if allow_winget:
        cmd.append("-AllowWinget")
    # Both GUI and --yes are windowed EXE paths: always drain the child output.
    # Inheriting invalid console handles can stall print() after a verbose phase.
    proc = external_popen(cmd, cwd=str(project_root), env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                            text=True, encoding="utf-8", errors="replace",
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    assert proc.stdout is not None
    for line in proc.stdout:
        if line.strip():
            log(redact_install_output(line.rstrip(), dd))
    return proc.wait()


def write_gui_launcher(root: Path, dd: Path) -> Path:
    """Publish a Unicode Windows Script Host entry; pythonw keeps consoles hidden."""
    pythonw = root / ".venv" / "Scripts" / "pythonw.exe"
    script = root / "scripts" / "desktop_launcher.py"
    command = subprocess.list2cmdline([str(pythonw), str(script), "--root", str(root), "--data-dir", str(dd)])

    def vb_string(value: str | Path) -> str:
        return '"' + str(value).replace('"', '""') + '"'

    content = (
        'Option Explicit\r\nDim shell, files, result\r\n'
        'Set shell = CreateObject("WScript.Shell")\r\n'
        'Set files = CreateObject("Scripting.FileSystemObject")\r\n'
        f'If Not files.FileExists({vb_string(pythonw)}) Or Not files.FileExists({vb_string(script)}) Then\r\n'
        '  MsgBox "启动文件缺失，请重新运行 Easel 安装器修复。", 16, "Easel"\r\n'
        '  WScript.Quit 1\r\nEnd If\r\n'
        f'shell.CurrentDirectory = {vb_string(root)}\r\n'
        'On Error Resume Next\r\n'
        f'result = shell.Run({vb_string(command)}, 0, False)\r\n'
        'If Err.Number <> 0 Then\r\n'
        '  MsgBox "无法启动 Easel，请重新运行安装器修复。", 16, "Easel"\r\n'
        '  WScript.Quit 1\r\nEnd If\r\n')
    destination = USER_DIR / "打开 Easel.vbs"
    temporary = destination.with_suffix(".vbs.tmp")
    # WSH understands UTF-16 BOM; ANSI would corrupt Chinese install paths.
    temporary.write_text(content, encoding="utf-16")
    temporary.replace(destination)
    return destination


def activate(root: Path, dd: Path) -> Path:
    """Switch only after successful health checks; retain the previous launcher."""
    launcher = USER_DIR / "Easel.ps1"
    entry = root / ".venv" / "Scripts" / "easel.exe"
    npm_prefix = root / ".tools" / "npm"
    # setup.ps1 records the compatible Node directory (winget's portable copy may
    # sit outside PATH); pin it so the launcher never falls back to an old Node.
    prefixes = []
    if npm_prefix.is_dir():
        prefixes.append(npm_prefix)
    node_marker = root / ".tools" / "node-dir.txt"
    try:
        node_dir = node_marker.read_text(encoding="utf-8-sig").strip()
    except OSError:
        node_dir = ""
    if node_dir and Path(node_dir).is_dir():
        prefixes.append(Path(node_dir))
    path_prefix = "".join(f"{_ps_literal(p)} + ';' + " for p in prefixes)
    text = (f"$env:EASEL_DATA_DIR = {_ps_literal(dd)}\n"
            "$env:EASEL_HOST = '127.0.0.1'\n"
            f"$env:Path = {path_prefix}$env:Path\n"
            f"Set-Location -LiteralPath {_ps_literal(root)}\n"
            f"if ($args.Count -eq 0) {{ & {_ps_literal(root / '.venv/Scripts/python.exe')} {_ps_literal(root / 'scripts/start_workspace.py')} --root {_ps_literal(root)} --data-dir {_ps_literal(dd)}; exit $LASTEXITCODE }}\n"
            f"$runtime = Get-Content -LiteralPath {_ps_literal(dd / 'runtime-launch.json')} -Raw -Encoding UTF8 | ConvertFrom-Json\n"
            "$env:EASEL_OPENCLAW_STATE_DIR = $runtime.stateDir\n"
            "$env:OPENCLAW_STATE_DIR = $runtime.stateDir\n"
            f"$env:OPENCLAW_HOME = {_ps_literal(dd / 'openclaw-home')}\n"
            "$env:OPENCLAW_GATEWAY_PORT = [string]$runtime.gatewayPort\n"
            f"& {_ps_literal(entry)} @args\nexit $LASTEXITCODE\n")
    previous = launcher.read_bytes() if launcher.exists() else None
    encoded = text.encode("utf-8-sig")
    if previous and previous != encoded:
        (USER_DIR / "Easel.previous.ps1").write_bytes(previous)
    temp = launcher.with_suffix(".ps1.tmp")
    temp.write_bytes(encoded)
    temp.replace(launcher)
    (USER_DIR / "Start-Easel.cmd").write_text(
        '@echo off\r\nsetlocal\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Easel.ps1" %*\r\n'
        'set "EASEL_EXIT=%ERRORLEVEL%"\r\nif not "%EASEL_EXIT%"=="0" pause\r\nexit /b %EASEL_EXIT%\r\n', encoding="ascii")
    write_gui_launcher(root, dd)
    return launcher


@contextmanager
def bootstrap_lock():
    """Serialize download, migration and activation, including pre-Python setup."""
    USER_DIR.mkdir(parents=True, exist_ok=True)
    with (USER_DIR / "bootstrap.lock").open("a+b") as handle:
        if os.fstat(handle.fileno()).st_size == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise RuntimeError("另一个 Easel 引导安装器正在运行") from exc
        else:
            import fcntl
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise RuntimeError("另一个 Easel 引导安装器正在运行") from exc
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def install(version: str, allow_winget: bool, zip_url: str = "", sha256: str = "",
            migrate_from: Path | None = None, archive_path: Path | None = None) -> int:
    with bootstrap_lock():
        return _install(version, allow_winget, zip_url, sha256, migrate_from, archive_path)


PHASE_TITLES = {p["id"]: p["title"] for p in (
    {"id": "system", "title": "检查系统环境"},
    {"id": "openclaw", "title": "安装 OpenClaw"},
    {"id": "pydeps", "title": "安装 Python 依赖"},
    {"id": "frontend", "title": "构建 Web 前端"},
    {"id": "chromium", "title": "安装浏览器内核 Chromium"},
    {"id": "profile", "title": "准备账号 profile"},
    {"id": "skills", "title": "同步 skills"},
    {"id": "gateway", "title": "启动本地服务"},
)}
PHASE_HINTS = {
    "system": "缺少系统工具（Git/Node/Python 等）。重新运行安装器，在「缺失系统工具时自动用 winget 安装？[Y/n]」直接回车即可自动补装。",
    "openclaw": "需要联网。检查网络后重新运行安装器，会自动重试。",
    "pydeps": "下载依赖需要联网。换个网络（如手机热点）后重新运行安装器即可。",
    "frontend": "重新运行安装器；若仍失败，请把窗口上方最后几行报错截图反馈。",
    "chromium": "浏览器内核下载需要联网。检查网络后重新运行安装器。",
    "profile": "重新运行安装器即可。",
    "skills": "重新运行安装器即可。",
    "gateway": "端口可能被占用：先关闭旧的 Easel 窗口/服务，再重新运行安装器；仍失败请重启电脑后重试。",
}


def _report_setup_failure(dd: Path) -> None:
    """setup.ps1 退出码非 0：读 install-state.json，用人话指出失败步骤、报错与下一步。"""
    log("安装未完成，已停在失败步骤。")
    try:
        state = json.loads((dd / "install-state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    phases = state.get("phases") if isinstance(state, dict) else None
    failed = next(((pid, v) for pid, v in (phases or {}).items()
                   if isinstance(v, dict) and v.get("status") == "failed"), None)
    if failed:
        pid, view = failed
        log(f"失败步骤：{PHASE_TITLES.get(pid, pid)}")
        detail = str(view.get("detail") or "").strip()
        if detail:
            log(f"报错信息：{redact_install_output(detail, dd)[:200]}")
        log(f"下一步：{PHASE_HINTS.get(pid, '按报错信息处理后，重新运行安装器。')}")
    else:
        log("下一步：向上滚动查看窗口中的报错；修复后重新运行安装器，已成功的步骤会自动跳过、从断点继续。")
    log(f"状态与日志目录：{dd}")


def _install(version: str, allow_winget: bool, zip_url: str = "", sha256: str = "",
            migrate_from: Path | None = None, archive_path: Path | None = None) -> int:
    if os.name != "nt":
        raise RuntimeError("该安装入口仅支持 Windows 10/11")
    version = normalize_version(version)
    root = install_root(version)
    log(f"Easel v{version}；安装目录：{root}；持久数据：{data_root()}")
    log(f"目标磁盘可用空间：{shutil.disk_usage(USER_DIR).free / 1024**3:.1f} GiB；依赖安装仍需额外空间")
    log("安装阶段：系统检查 → OpenClaw → Python 依赖 → 前端 → Chromium → profile → skills → Gateway/Web 验证")
    if (zip_url or archive_path) and not sha256:
        raise RuntimeError("自定义归档地址必须显式提供 --sha256")
    want = valid_sha256(sha256) if sha256 else ""
    if archive_path is not None:
        archive_path = archive_path.resolve()
        if not archive_path.is_file() or sha256_of(archive_path) != want:
            raise RuntimeError("内嵌/本地归档不存在或 SHA-256 校验失败")
    marker = root / MARKER
    if marker.is_file():
        saved = json.loads(marker.read_text(encoding="utf-8"))
        if not isinstance(saved, dict):
            raise RuntimeError("已有发行校验记录损坏")
        valid_sha256(saved.get("sha256", ""))
        if saved.get("version") != version or (want and saved["sha256"] != want):
            raise RuntimeError("已安装目录与请求发行包不一致，请保留旧目录并使用新版本")
        if not (root / "setup.ps1").is_file():
            raise RuntimeError("已有版本目录损坏，缺少 setup.ps1")
        log("恢复已经校验的版本目录")
    else:
        if root.exists() and any(root.iterdir()):
            raise RuntimeError("已有版本目录未包含校验记录，拒绝执行")
        if archive_path is not None:
            extract_to(archive_path, root, version, want)
        else:
            if not zip_url:
                zip_url = pick_archive(fetch_release(version)["assets"], version)["url"]
            validate_url(zip_url)
            want = want or _sidecar_sha256(zip_url)
            with tempfile.TemporaryDirectory(prefix="easel-download-") as temp:
                archive = download_with_retry(zip_url, Path(temp) / "release.zip", want)
                extract_to(archive, root, version, want)
        log("归档 SHA-256 校验与解压完成")
    if migrate_from is not None:
        if not migrate_from.is_dir():
            raise RuntimeError("迁移来源目录不存在")
        init_data_dir(migrate_from)
    dd = init_data_dir(root)
    link_data_dirs(root, dd)
    rc = (run_setup(root, dd, allow_winget, migrate_from=migrate_from)
          if migrate_from is not None else run_setup(root, dd, allow_winget))
    if rc:
        _report_setup_failure(dd)
        return rc
    launcher = activate(root, dd)
    log(f"安装完成。日常使用请双击：{USER_DIR / '打开 Easel.vbs'}")
    log("首次打开工作台后可在设置页配置模型。")
    return 0


def embedded_release() -> dict:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    path = base / "release.json"
    if not path.is_file():
        if getattr(sys, "frozen", False):
            raise RuntimeError("发行 EXE 缺少内嵌校验清单")
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError("内嵌发行清单损坏")
    normalize_version(data.get("version"))
    valid_sha256(data.get("sha256"))
    if data.get("url"):
        validate_url(data["url"])
    archive_name = data.get("archive")
    if archive_name is not None:
        expected = f"Easel-{normalize_version(data['version'])}-windows.zip"
        if archive_name != expected:
            raise RuntimeError("内嵌归档文件名与版本不匹配")
        if not (base / archive_name).is_file():
            raise RuntimeError("发行 EXE 缺少内嵌 ZIP")
    elif getattr(sys, "frozen", False):
        raise RuntimeError("发行 EXE 缺少内嵌 ZIP 名称")
    return data


def bundled_archive(release: dict) -> Path | None:
    name = release.get("archive")
    if not name:
        return None
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    return base / name


def self_test(release: dict, archive: Path | None) -> None:
    """Verify the embedded payload and native GUI without installing anything."""
    if not release or archive is None:
        raise RuntimeError("自检需要内嵌 release.json 与 ZIP")
    if not archive.is_file() or sha256_of(archive) != valid_sha256(release["sha256"]):
        raise RuntimeError("内嵌 ZIP SHA-256 校验失败")
    with zipfile.ZipFile(archive) as z:
        _safe_members(z)
        if z.testzip() is not None:
            raise RuntimeError("内嵌 ZIP CRC 校验失败")
        names = set(z.namelist())
        for required in ("setup.ps1", "easel/install_runner.py", "web/frontend/dist/index.html",
                         "requirements-windows.lock", "release-manifest.json"):
            if required not in names:
                raise RuntimeError(f"内嵌 ZIP 缺少 {required}")
        manifest = json.loads(z.read("release-manifest.json"))
        if manifest.get("schemaVersion") != 1 or manifest.get("version") != release["version"]:
            raise RuntimeError("内嵌 ZIP 清单版本不匹配")
    import tkinter as tk
    root = tk.Tk()
    root.withdraw()
    try:
        root.update()
    finally:
        root.destroy()
    log(f"自检通过：Easel v{release['version']}；GUI 与内嵌归档可用；未安装任何文件")


def launch_gui(version: str, release: dict, archive: Path | None,
               migrate_from: Path | None = None) -> int:
    """Run the existing installer on a worker and show its phases in Tk."""
    import queue
    import threading
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    global USER_DIR, _LOG_HOOK
    events: queue.Queue[tuple[str, object]] = queue.Queue()
    window = tk.Tk()
    window.title(f"Easel v{version} 安装向导")
    window.geometry("760x570")
    window.minsize(650, 480)
    path_value = tk.StringVar(value=str(USER_DIR))
    phase_value = tk.StringVar(value="准备就绪")
    progress_value = tk.IntVar(value=0)
    allow_value = tk.BooleanVar(value=True)
    running = False
    succeeded = False
    opening = False

    outer = ttk.Frame(window, padding=20)
    outer.pack(fill="both", expand=True)
    ttk.Label(outer, text=f"安装 Easel v{version}", font=("Segoe UI", 18, "bold")).pack(anchor="w")
    ttk.Label(outer, text="工作台、Gateway 和浏览器组件将安装到选定目录；账号资料会保存在 data 子目录。",
              wraplength=700).pack(anchor="w", pady=(4, 18))
    ttk.Label(outer, text="安装位置").pack(anchor="w")
    location = ttk.Frame(outer)
    location.pack(fill="x", pady=(4, 12))
    path_entry = ttk.Entry(location, textvariable=path_value)
    path_entry.pack(side="left", fill="x", expand=True)

    def browse() -> None:
        chosen = filedialog.askdirectory(parent=window, title="选择 Easel 安装目录", initialdir=path_value.get())
        if chosen:
            path_value.set(chosen)

    browse_button = ttk.Button(location, text="浏览…", command=browse)
    browse_button.pack(side="left", padx=(8, 0))
    check = ttk.Checkbutton(outer, text="缺少 Git、Node.js、Python 或 FFmpeg 时，自动用 winget 安装",
                            variable=allow_value)
    check.pack(anchor="w", pady=(0, 14))
    ttk.Label(outer, textvariable=phase_value).pack(anchor="w")
    bar = ttk.Progressbar(outer, maximum=len(PHASE_TITLES), variable=progress_value)
    bar.pack(fill="x", pady=(5, 14))
    log_frame = ttk.Frame(outer)
    log_frame.pack(fill="both", expand=True)
    output = tk.Text(log_frame, height=14, wrap="word", state="disabled", font=("Consolas", 9))
    scrollbar = ttk.Scrollbar(log_frame, orient="vertical", command=output.yview)
    output.configure(yscrollcommand=scrollbar.set)
    output.pack(side="left", fill="both", expand=True)
    scrollbar.pack(side="right", fill="y")
    buttons = ttk.Frame(outer)
    buttons.pack(fill="x", pady=(14, 0))

    def append_line(line: str) -> None:
        output.configure(state="normal")
        output.insert("end", line + "\n")
        if int(output.index("end-1c").split(".")[0]) > 2500:
            output.delete("1.0", "501.0")
        output.see("end")
        output.configure(state="disabled")

    def sink(line: str) -> None:
        events.put(("log", redact_install_output(line, data_root())))

    def worker(destination: Path, allow_winget: bool) -> None:
        global USER_DIR, _LOG_HOOK
        USER_DIR = destination
        _LOG_HOOK = sink
        try:
            rc = install(version, allow_winget, release.get("url", ""), release.get("sha256", ""),
                         migrate_from=migrate_from, archive_path=archive)
            events.put(("done", rc))
        except Exception as exc:  # Keep the GUI responsive even on an unexpected installer failure.
            events.put(("log", redact_install_output(f"[easel-installer] 安装停止：{exc}", data_root())))
            events.put(("done", 1))
        finally:
            _LOG_HOOK = None

    def open_workspace() -> None:
        nonlocal opening
        if opening:
            return
        opening = True
        start_button.configure(state="disabled")
        phase_value.set("正在启动本地工作台…")

        def launch() -> None:
            root = install_root(version)
            python = root / '.venv/Scripts/python.exe'
            try:
                result = external_run([str(python), str(root / 'scripts/start_workspace.py'),
                    '--root', str(root), '--data-dir', str(data_root()), '--no-browser'],
                    cwd=root, capture_output=True, text=True, encoding='utf-8', errors='replace',
                    env=dict(os.environ, PYTHONUTF8='1'),
                    timeout=480, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                if result.returncode:
                    events.put(('opened', result.stderr.strip() or '启动失败，请查看 data/logs/launch.log'))
                    return
                state = json.loads((data_root() / 'workbench.json').read_text(encoding='utf-8'))
                events.put(('opened', {'url': f"http://127.0.0.1:{int(state['port'])}/"}))
            except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
                events.put(('opened', f'无法启动工作台：{exc}'))

        threading.Thread(target=launch, daemon=True).start()

    def begin() -> None:
        nonlocal running
        if running or succeeded:
            return
        raw = path_value.get().strip()
        if not raw:
            messagebox.showerror("安装位置无效", "请选择安装目录。", parent=window)
            return
        try:
            destination = Path(raw).expanduser().resolve()
        except (OSError, RuntimeError, ValueError):
            messagebox.showerror("安装位置无效", "无法解析安装目录。", parent=window)
            return
        if destination == Path(destination.anchor) or not destination.is_absolute():
            messagebox.showerror("安装位置无效", "请选具体的安装目录。", parent=window)
            return
        running = True
        phase_value.set("正在校验发行包并安装…")
        bar.configure(mode="indeterminate")
        bar.start(12)
        start_button.configure(state="disabled")
        browse_button.configure(state="disabled")
        path_entry.configure(state="disabled")
        check.configure(state="disabled")
        threading.Thread(target=worker, args=(destination, allow_value.get()), daemon=True).start()

    start_button = ttk.Button(buttons, text="开始安装", command=begin)
    start_button.pack(side="right")
    close_button = ttk.Button(buttons, text="关闭")
    close_button.pack(side="right", padx=(0, 8))

    def poll() -> None:
        nonlocal running, succeeded, opening
        while True:
            try:
                kind, value = events.get_nowait()
            except queue.Empty:
                break
            if kind == "log":
                append_line(str(value))
            elif kind == "done":
                running = False
                bar.stop()
                bar.configure(mode="determinate")
                succeeded = value == 0
                path_entry.configure(state="normal")
                browse_button.configure(state="normal")
                check.configure(state="normal")
                if succeeded:
                    progress_value.set(len(PHASE_TITLES))
                    phase_value.set("安装完成。点击“打开工作台”启动本地服务。")
                    start_button.configure(text="打开工作台", command=open_workspace, state="normal")
                    append_line(f"日常启动入口：{USER_DIR / '打开 Easel.vbs'}")
                else:
                    phase_value.set("安装未完成。问题处理后点击“重试安装”，会从失败阶段继续。")
                    start_button.configure(text="重试安装", state="normal")
            elif kind == "opened":
                opening = False
                start_button.configure(state="normal")
                if isinstance(value, dict) and value.get("url"):
                    phase_value.set("工作台已就绪，正在打开浏览器。")
                    import webbrowser
                    try:
                        if not webbrowser.open(value["url"]):
                            append_line(f"浏览器未自动打开，请访问 {value['url']}")
                    except OSError:
                        append_line(f"浏览器未自动打开，请访问 {value['url']}")
                else:
                    phase_value.set("工作台启动失败；请查看提示后重试。")
                    append_line(str(value))
                    messagebox.showerror("打开工作台失败", str(value), parent=window)
        if running:
            try:
                state = json.loads((Path(path_value.get()).expanduser() / "data" / "install-state.json").read_text(encoding="utf-8"))
                phases = state.get("phases", {})
                done = sum(isinstance(v, dict) and v.get("status") in ("ok", "skipped") for v in phases.values())
                if str(bar.cget("mode")) != "determinate":
                    bar.stop()
                    bar.configure(mode="determinate")
                progress_value.set(min(done, len(PHASE_TITLES)))
                active = next((PHASE_TITLES.get(pid, pid) for pid, view in phases.items()
                               if isinstance(view, dict) and view.get("status") in ("running", "retry", "failed")), None)
                if active:
                    phase_value.set(f"已完成 {done}/{len(PHASE_TITLES)} 阶段 · {active}")
            except (OSError, ValueError, AttributeError):
                pass
        window.after(150, poll)

    def on_close() -> None:
        if running or opening:
            messagebox.showinfo("正在处理", "请等待当前操作完成。", parent=window)
        else:
            window.destroy()

    window.protocol("WM_DELETE_WINDOW", on_close)
    close_button.configure(command=on_close)
    append_line("发行包已内嵌在安装器中；Python 依赖、OpenClaw 和 Chromium 仍需联网安装。")
    window.after(150, poll)
    window.mainloop()
    return 0 if succeeded else 1


def main(argv: list[str] | None = None) -> int:
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Easel Windows 在线引导安装器（校验、分阶段、可恢复）")
    ap.add_argument("--version", help="源码运行时指定版本，如 0.2.1；EXE 内置版本")
    ap.add_argument("--allow-winget", action="store_true", help="允许 winget 安装缺失的系统工具")
    ap.add_argument("--zip-url", default="", help="HTTPS 发行包地址；必须同时提供 --sha256")
    ap.add_argument("--sha256", default="", help="期望的 64 位 SHA-256")
    ap.add_argument("--migrate-from", type=Path, help="从已有源码目录复制缺失用户数据，保留原文件")
    ap.add_argument("--yes", action="store_true", help="确认安装内置发行包，省略首次确认提示")
    ap.add_argument("--archive", type=Path, help="源码入口从本地发行 ZIP 安装，需同时传 --sha256")
    ap.add_argument("--install-dir", type=Path, help="安装目录，默认 %%LOCALAPPDATA%%/Easel")
    ap.add_argument("--gui", action="store_true", help="显示 Windows 原生安装窗口")
    ap.add_argument("--self-test", action="store_true", help="只读校验 GUI 与内嵌 ZIP，不执行安装")
    args = ap.parse_args(argv)
    try:
        global USER_DIR
        bundled = embedded_release()
        if bundled and any((args.version, args.zip_url, args.sha256, args.archive)):
            raise RuntimeError("发行 EXE 的版本/地址/校验值固定；测试覆盖请使用源码入口")
        version = bundled.get("version") or args.version
        if not version:
            ap.error("源码入口需要 --version")
        if args.install_dir is not None:
            USER_DIR = args.install_dir.expanduser().resolve()
        archive = bundled_archive(bundled) or args.archive
        if args.self_test:
            self_test(bundled or {"version": version, "sha256": args.sha256}, archive)
            return 0
        if args.gui or (getattr(sys, "frozen", False) and not args.yes):
            return launch_gui(version, bundled or {"url": args.zip_url, "sha256": args.sha256}, archive,
                              migrate_from=args.migrate_from)
        allow_winget = args.allow_winget
        if bundled and not args.yes:
            log(f"准备安装 Easel v{version} → {install_root(version)}")
            log("需要联网：Python 依赖、浏览器内核、OpenClaw 会自动安装；"
                "系统工具（Git/Node/Python/FFmpeg）缺失时经你确认后用 winget 安装。")
            if not allow_winget:
                # 小白默认：直接回车=允许自动安装缺失的系统工具；填 n 才逐项手动装。
                answer = input("缺失系统工具时自动用 winget 安装？[Y/n] ").strip().lower()
                allow_winget = answer not in ("n", "no")
            if input("继续安装？[Y/n] ").strip().lower() in ("n", "no"):
                return 0
        extra = {"archive_path": archive} if archive is not None else {}
        return install(version, allow_winget, bundled.get("url", args.zip_url),
                       bundled.get("sha256", args.sha256), args.migrate_from, **extra)
    except (RuntimeError, OSError, ValueError, KeyError, zipfile.BadZipFile, EOFError) as exc:
        log(f"安装停止：{exc}")
        log("重新运行安装器可从断点继续，已成功的步骤不会重复安装；若反复出现，请截图上方提示反馈。")
        if getattr(sys, "frozen", False) and not args.yes and not args.self_test:
            try:
                from tkinter import messagebox
                messagebox.showerror("Easel 安装器", f"安装器无法启动：{exc}")
            except Exception:
                pass
        return 1
    except KeyboardInterrupt:
        log("安装已中断，重新运行以继续。")
        return 130


if __name__ == "__main__":
    result = main()
    sys.exit(result)
