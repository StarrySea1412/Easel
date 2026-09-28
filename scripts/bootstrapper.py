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


def log(msg: str) -> None:
    print(f"[easel-installer] {msg}", flush=True)


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


def copy_missing(src: Path, dest: Path) -> None:
    """Copy missing files recursively, excluding links; never overwrite user data."""
    if src.is_symlink() or (hasattr(src, "is_junction") and src.is_junction()):
        return
    if dest.is_symlink() or (hasattr(dest, "is_junction") and dest.is_junction()):
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
        link, target = root / name, (dd / name).resolve()
        if link.resolve() == target:
            continue
        if link.is_symlink() or (hasattr(link, "is_junction") and link.is_junction()):
            raise RuntimeError(f"数据链接指向意外目录：{link}")
        if link.exists():
            backup = root / ".bundled-data-seed" / name
            backup.parent.mkdir(exist_ok=True)
            if not link.resolve().is_relative_to(root.resolve()) or not backup.resolve().is_relative_to(root.resolve()):
                raise RuntimeError("数据路径超出版本目录")
            link.rename(backup)
        if os.name == "nt":
            command = f"$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path {_ps_literal(link)} -Target {_ps_literal(target)} | Out-Null"
            result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", command], check=False)
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
    return subprocess.run(cmd, cwd=str(project_root), env=env).returncode


def activate(root: Path, dd: Path) -> Path:
    """Switch only after successful health checks; retain the previous launcher."""
    launcher = USER_DIR / "Easel.ps1"
    entry = root / ".venv" / "Scripts" / "easel.exe"
    text = (f"$env:EASEL_DATA_DIR = {_ps_literal(dd)}\n"
            f"Set-Location -LiteralPath {_ps_literal(root)}\n"
            f"& {_ps_literal(entry)} @args\nexit $LASTEXITCODE\n")
    previous = launcher.read_bytes() if launcher.exists() else None
    encoded = text.encode("utf-8-sig")
    if previous and previous != encoded:
        (USER_DIR / "Easel.previous.ps1").write_bytes(previous)
    temp = launcher.with_suffix(".ps1.tmp")
    temp.write_bytes(encoded)
    temp.replace(launcher)
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
            migrate_from: Path | None = None) -> int:
    with bootstrap_lock():
        return _install(version, allow_winget, zip_url, sha256, migrate_from)


def _install(version: str, allow_winget: bool, zip_url: str = "", sha256: str = "",
            migrate_from: Path | None = None) -> int:
    if os.name != "nt":
        raise RuntimeError("该安装入口仅支持 Windows 10/11")
    version = normalize_version(version)
    root = install_root(version)
    log(f"Easel v{version}；安装目录：{root}；持久数据：{data_root()}")
    log(f"目标磁盘可用空间：{shutil.disk_usage(USER_DIR).free / 1024**3:.1f} GiB；依赖安装仍需额外空间")
    log("安装阶段：系统检查 → OpenClaw → Python 依赖 → 前端 → Chromium → profile → skills → Gateway/Web 验证")
    if zip_url and not sha256:
        raise RuntimeError("自定义归档地址必须显式提供 --sha256")
    want = valid_sha256(sha256) if sha256 else ""
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
        log(f"安装未完成（退出码 {rc}）。修复后重新运行可继续；状态与日志：{dd}")
        return rc
    launcher = activate(root, dd)
    log(f'安装完成。启动：powershell -NoProfile -ExecutionPolicy Bypass -File "{launcher}" web')
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
    validate_url(data.get("url", ""))
    return data


def main(argv: list[str] | None = None) -> int:
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
    args = ap.parse_args(argv)
    try:
        bundled = embedded_release()
        if bundled and any((args.version, args.zip_url, args.sha256)):
            raise RuntimeError("发行 EXE 的版本/地址/校验值固定；测试覆盖请使用源码入口")
        version = bundled.get("version") or args.version
        if not version:
            ap.error("源码入口需要 --version")
        if bundled and not args.yes:
            log(f"准备安装 Easel v{version} → {install_root(version)}")
            log("需要联网下载依赖；系统工具缺失会停止，可使用 --allow-winget 显式允许安装。")
            if input("继续安装？[y/N] ").strip().lower() != "y":
                return 0
        return install(version, args.allow_winget, bundled.get("url", args.zip_url),
                       bundled.get("sha256", args.sha256), args.migrate_from)
    except (RuntimeError, OSError, ValueError, KeyError, zipfile.BadZipFile, EOFError) as exc:
        log(f"安装停止：{exc}")
        return 1
    except KeyboardInterrupt:
        log("安装已中断，重新运行以继续。")
        return 130


if __name__ == "__main__":
    result = main()
    if getattr(sys, "frozen", False) and len(sys.argv) == 1:
        try:
            input("按 Enter 关闭窗口。")
        except (EOFError, KeyboardInterrupt):
            pass
    sys.exit(result)
