"""Assemble a Windows x64 portable preview from explicitly prepared public runtimes.

This builder never installs or downloads a runtime. Dependency preparation belongs
on the build machine; extracting the resulting ZIP must not run pip/npm/winget.
The normal frontend checks rebuild from the checkout. A receipt written by
--prepare-frontend may be reused only while both source and output hashes match.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
import zipfile

from build_windows_release import allowed_source as release_source_allowed, frontend_notices
from bootstrapper import normalize_version, sha256_of

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = {
    "python": "runtime/python/python.exe",
    "node": "runtime/node/node.exe",
    "openclaw": "runtime/openclaw/node_modules/openclaw/openclaw.mjs",
    "ffmpeg": "runtime/ffmpeg/bin/ffmpeg.exe",
    "browserPath": "runtime/browsers",
}
COMPONENTS = ("python", "node", "openclaw", "ffmpeg", "browsers")
JUNK_DIRS = {"__pycache__", ".pytest_cache", ".git", ".cache"}
PRIVATE_NAMES = {
    ".env", ".npmrc", ".pypirc", ".netrc", "cookies", "cookies.json",
    "auth-profiles.json", "credentials.json", "storage_state.json", "storage-state.json",
    "wechat-publisher.yaml", "login data", "local state", "runtime-launch.json",
    "install-state.json", "workbench.json", "portable-state.json", "pyvenv.cfg",
    "id_rsa", "id_ed25519",
}


def relative_name(value: str) -> str:
    """Reject paths that Windows or ZIP extraction could interpret ambiguously."""
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("Expected a normalized relative path")
    parts = value.split("/")
    if any(not p or p in (".", "..") or p.endswith((" ", ".")) for p in parts):
        raise ValueError("Unsafe relative path")
    if any(ord(c) < 32 for c in value) or any(c in value for c in ':<>"|?*'):
        raise ValueError("Unsafe Windows path")
    if any(re.fullmatch(r"(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", p, re.I) for p in parts):
        raise ValueError("Reserved Windows path")
    return PurePosixPath(value).as_posix()


def private_name(name: str) -> bool:
    leaf = PurePosixPath(name).name.casefold()
    return leaf in PRIVATE_NAMES or leaf.startswith(".env.") or leaf.startswith("__editable__")


def allowed_source(name: str) -> bool:
    try:
        relative_name(name)
    except ValueError:
        return False
    if name != ".env.example" and private_name(name):
        return False
    if name.startswith("web/frontend/dist/"):
        return False  # Only the independently checked fresh frontend is copied.
    return release_source_allowed(name)


def is_link(path: Path) -> bool:
    attributes = getattr(path.lstat(), "st_file_attributes", 0)
    return path.is_symlink() or bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def public_files(root: Path, *, allow_app_template: bool = False) -> dict[str, Path]:
    if not root.is_dir() or is_link(root):
        raise ValueError("A component must be a real, explicitly prepared directory")
    result: dict[str, Path] = {}
    seen: set[str] = set()
    for folder, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            candidate = Path(folder) / name
            if is_link(candidate):
                raise ValueError(f"Linked runtime entry is not portable: {candidate.relative_to(root)}")
        directories[:] = [name for name in directories if name.casefold() not in JUNK_DIRS]
        if any(name.casefold() in (".venv", "venv") for name in directories):
            raise ValueError("Copying a virtual environment is not a portable Python distribution")
        for leaf in files:
            candidate = Path(folder) / leaf
            name = relative_name(candidate.relative_to(root).as_posix())
            if private_name(name) and not (allow_app_template and name == "app/.env.example"):
                raise ValueError(f"Private or machine-specific runtime entry: {name}")
            if leaf.endswith((".pyc", ".pyo", ".log")) or leaf == "direct_url.json":
                continue
            if name.casefold() in seen:
                raise ValueError(f"Case-insensitive runtime path collision: {name}")
            seen.add(name.casefold())
            result[name] = candidate
    return result


def file_records(files: dict[str, Path]) -> dict[str, dict]:
    return {name: {"sha256": sha256_of(path), "bytes": path.stat().st_size}
            for name, path in sorted(files.items())}


def tree_hash(records: dict[str, dict]) -> str:
    digest = hashlib.sha256()
    for name, entry in sorted(records.items()):
        digest.update(f"{name}\0{entry['sha256']}\0{entry['bytes']}\n".encode("utf-8"))
    return digest.hexdigest()


def public_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query:
        raise ValueError("Component provenance must be a public HTTPS URL without credentials or query strings")
    return value


@dataclass(frozen=True)
class Component:
    name: str
    path: Path
    version: str
    source: str
    licenses: tuple[str, ...]
    source_code: str | None = None
    expected_tree: str | None = None
    source_archive_sha256: str | None = None


def load_components(manifest: Path) -> dict[str, Component]:
    data = json.loads(manifest.read_text(encoding="utf-8-sig"))
    if data.get("schemaVersion") != 1 or set(data.get("components", {})) != set(COMPONENTS):
        raise ValueError("Prepared component manifest requires exactly python, node, openclaw, ffmpeg and browsers")
    result = {}
    for name in COMPONENTS:
        entry = data["components"][name]
        raw_path = Path(entry["path"])
        unresolved = raw_path if raw_path.is_absolute() else manifest.parent / raw_path
        if unresolved.exists() and is_link(unresolved):
            raise ValueError("Prepared component roots must not be linked directories")
        path = unresolved.resolve()
        if any(part.casefold() in (".venv", "venv") for part in path.parts):
            raise ValueError("Use prepared public runtimes, never a copied virtual environment")
        version = entry.get("version", "")
        if not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9_.+\-]{1,100}", version):
            raise ValueError(f"Missing or invalid component version: {name}")
        licenses = entry.get("licenses")
        if not isinstance(licenses, list) or not licenses or any(not isinstance(item, str) for item in licenses):
            raise ValueError(f"Explicit license files are required: {name}")
        for key in ("treeSha256", "sourceArchiveSha256"):
            if entry.get(key) is not None and not re.fullmatch(r"[a-fA-F0-9]{64}", entry[key]):
                raise ValueError(f"Invalid component checksum: {name}")
        result[name] = Component(name, path, version, public_url(entry["source"]),
            tuple(relative_name(item) for item in licenses),
            public_url(entry["sourceCode"]) if entry.get("sourceCode") else None,
            entry.get("treeSha256"), entry.get("sourceArchiveSha256"))
    return result


def require_files(files: dict[str, Path], names: tuple[str, ...], label: str) -> None:
    for name in names:
        if name not in files or not files[name].stat().st_size:
            raise ValueError(f"Missing {label} runtime file: {name}")


def validate_console_launcher(name: str, path: Path) -> None:
    """Accept freshly built distlib launchers, never a venv's absolute shebang."""
    if path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError(f"Unrecognized prepared Python console launcher: {name}")
    data = path.read_bytes()
    if name.endswith(".exe"):
        shebang = b'#!"<launcher_dir>\\..\\python.exe" -I -B\r\n'
        if not data.startswith(b"MZ") or data.count(shebang) != 1:
            raise ValueError(f"Python console launchers must use the verified relative shebang: {name}")
        payload = data.split(shebang, 1)[1]
        try:
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                if archive.namelist() != ["__main__.py"] or archive.getinfo("__main__.py").file_size > 65536:
                    raise ValueError("Unexpected console launcher payload")
                code = archive.read("__main__.py").decode("utf-8")
        except (zipfile.BadZipFile, UnicodeDecodeError) as error:
            raise ValueError(f"Invalid relative Python launcher ZIP: {name}") from error
        if re.search(r"(?i)(?:[a-z]:[\\/]|__editable__)", code):
            raise ValueError(f"Machine-specific console launcher payload: {name}")
    elif name.endswith(".cmd"):
        code = data.decode("ascii")
        if '"%~dp0..\\python.exe" -I -B ' not in code or re.search(r"(?i)[a-z]:[\\/]", code):
            raise ValueError(f"Python console command must use its bundled interpreter: {name}")
    else:
        raise ValueError(f"Unrecognized Python console launchers entry: {name}")


def python_site_directory(files: dict[str, Path]) -> str:
    active = [line.strip() for line in files["python312._pth"].read_text(encoding="utf-8-sig").splitlines()]
    directories = [name for name in ("site-packages", "Lib/site-packages") if name in active]
    if len(directories) != 1:
        raise ValueError("Embedded Python must enable exactly one vendored site-packages directory")
    return directories[0]


def validate_python_paths(files: dict[str, Path]) -> None:
    require_files(files, ("python.exe", "pythonw.exe", "python312.dll", "python312.zip", "python312._pth"), "Python 3.12 embedded")
    for name, path in files.items():
        if name.startswith("Scripts/"):
            if len(PurePosixPath(name).parts) != 2:
                raise ValueError("Nested Python console launchers are not supported")
            validate_console_launcher(name, path)
    lines = files["python312._pth"].read_text(encoding="utf-8-sig").splitlines()
    active = [line.strip() for line in lines]
    site = python_site_directory(files)
    hook_name = site + "/00-easel-portable-runtime.pth"
    require_files(files, (hook_name,), "portable bytecode policy")
    if files[hook_name].read_text(encoding="utf-8-sig").strip() != "import sys; sys.dont_write_bytecode = True":
        raise ValueError("Prepared Python must disable bytecode writes for every embedded child interpreter")
    if "import site" not in active or "../../app" not in active:
        raise ValueError("Embedded Python must enable its vendored site-packages with import site")
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or line == "import site":
            continue
        if line.startswith("import ") or "\\" in line or ":" in line or line.startswith("/"):
            raise ValueError("Embedded Python search paths must be bundle-relative")
        level = 2  # runtime/python, measured from the bundle root
        for part in PurePosixPath(line).parts:
            level += -1 if part == ".." else 0 if part == "." else 1
            if level < 0:
                raise ValueError("Embedded Python search path escapes the portable bundle")
    for name, path in files.items():
        if name.endswith(".pth"):
            contents = path.read_text(encoding="utf-8-sig")
            if re.search(r"(?i)(?:[a-z]:[\\/]|__editable__|(?:^|[\s'\"])/(?:home|users|tmp)/)", contents):
                raise ValueError(f"Machine-specific Python path: {name}")


def browser_directories(python_files: dict[str, Path]) -> tuple[str, ...]:
    manifest = python_files.get(python_site_directory(python_files) + "/playwright/driver/package/browsers.json")
    if not manifest:
        raise ValueError("Prepared Python must include Playwright's browser revision manifest")
    entries = {item["name"]: item for item in json.loads(manifest.read_text(encoding="utf-8"))["browsers"]}
    wanted = ("chromium", "chromium-headless-shell", "ffmpeg", "winldd")
    result = []
    for name in wanted:
        revision = str(entries.get(name, {}).get("revision", ""))
        if not revision.isdigit():
            raise ValueError(f"Missing pinned Windows browser revision: {name}")
        result.append(f"{name.replace('-', '_')}-{revision}")
    return tuple(result)


def component_files(components: dict[str, Component]) -> dict[str, dict[str, Path]]:
    files = {name: public_files(component.path) for name, component in components.items() if name != "browsers"}
    validate_python_paths(files["python"])
    if not components["python"].version.startswith("3.12."):
        raise ValueError("The portable Python dependency set requires Windows x64 Python 3.12")
    require_files(files["node"], ("node.exe",), "Node")
    require_files(files["openclaw"], ("node_modules/openclaw/openclaw.mjs", "node_modules/openclaw/package.json"), "OpenClaw")
    package = json.loads(files["openclaw"]["node_modules/openclaw/package.json"].read_text(encoding="utf-8"))
    if package.get("version") != components["openclaw"].version:
        raise ValueError("OpenClaw component version does not match its package.json")
    require_files(files["ffmpeg"], ("bin/ffmpeg.exe", "bin/ffprobe.exe"), "FFmpeg")
    # Only the exact, public browser revisions required by this Python package.
    # Playwright's .links directory contains developer-machine paths, not runtime.
    browser = components["browsers"]
    files["browsers"] = {}
    executables = ("chrome.exe", "chrome-headless-shell.exe", "ffmpeg-win64.exe", "PrintDeps.exe")
    for directory, executable in zip(browser_directories(files["python"]), executables):
        entries = public_files(browser.path / directory)
        if not any(Path(name).name == executable and path.stat().st_size for name, path in entries.items()):
            raise ValueError(f"Incomplete pinned browser runtime: {directory}/{executable}")
        for name, path in entries.items():
            files["browsers"][f"{directory}/{name}"] = path
    for name in browser.licenses:
        path = browser.path / name
        if not path.is_file() or is_link(path) or private_name(name):
            raise ValueError(f"Missing or unsafe browser license: {name}")
        files["browsers"][name] = path
    for name, component in components.items():
        require_files(files[name], component.licenses, f"{name} license")
    return files


def indexed_files(root: Path) -> dict[str, Path]:
    names = subprocess.check_output(["git", "ls-files", "--cached", "-z"], cwd=root).decode("utf-8").split("\0")
    result = {}
    for name in names:
        if not name or not allowed_source(name):
            continue
        path = root / name
        if not path.is_file() or is_link(path) or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"Indexed source is missing or linked: {name}")
        result[name] = path
    require_files(result, ("scripts/portable_launcher.py", "scripts/portable_entry.cs", "web/app.py", "LICENSE"), "Git-indexed application")
    return result


def frontend_source_hash(root: Path) -> str:
    names = subprocess.check_output(["git", "ls-files", "--cached", "-z", "--", "web/frontend"], cwd=root).decode("utf-8").split("\0")
    source = {name: root / name for name in names if name and allowed_source(name)
              and not name.startswith("web/frontend/dist/")}
    if not source or "web/frontend/package-lock.json" not in source:
        raise ValueError("Frontend source and lockfile must be Git-indexed")
    for name, path in source.items():
        if not path.is_file() or is_link(path) or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"Frontend source is missing or linked: {name}")
    return tree_hash(file_records(source))


def frontend_output(root: Path) -> dict[str, dict]:
    files = public_files(root / "web/frontend/dist")
    require_files(files, ("index.html",), "frontend")
    return file_records(files)


def prepare_frontend(root: Path, receipt: Path | None = None, *, node_dir: Path | None = None) -> dict:
    env = os.environ.copy()
    env["EASEL_CLEAN_FRONTEND_BUILD"] = "1"
    if node_dir is not None:
        env["PATH"] = str(node_dir) + os.pathsep + env.get("PATH", "")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm", path=env.get("PATH"))
    node = shutil.which("node.exe" if os.name == "nt" else "node", path=env.get("PATH"))
    if not npm or not node:
        raise RuntimeError("npm and Node are required on the build machine to rebuild the frontend")
    before = frontend_source_hash(root)
    frontend = root / "web/frontend"
    subprocess.run([npm, "ci"], cwd=frontend, env=env, check=True)
    tests = sorted({*frontend.glob("tests/*.test.mjs"),
                    *frontend.glob("src/components/agent-office/__tests__/*.test.mjs")})
    if not tests:
        raise RuntimeError("Frontend acceptance tests are missing")
    subprocess.run([node, "--test", "--test-concurrency=2", *(path.relative_to(frontend).as_posix() for path in tests)],
                   cwd=frontend, env=env, check=True)
    for args in (("run", "lint"), ("run", "build")):
        subprocess.run([npm, *args], cwd=frontend, env=env, check=True)
    if frontend_source_hash(root) != before:
        raise RuntimeError("Frontend source changed during checks; rebuild the current source")
    result = {"schemaVersion": 1, "kind": "easel-frontend-build-receipt", "sourceSha256": before,
              "files": frontend_output(root), "checks": ["npm ci", "node --test --test-concurrency=2", "npm run lint", "npm run build"]}
    if receipt is not None:
        receipt.parent.mkdir(parents=True, exist_ok=True)
        receipt.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def verify_frontend_receipt(root: Path, receipt: Path) -> dict:
    record = json.loads(receipt.read_text(encoding="utf-8-sig"))
    if record.get("schemaVersion") != 1 or record.get("kind") != "easel-frontend-build-receipt":
        raise ValueError("Unrecognized frontend build receipt")
    if record.get("sourceSha256") != frontend_source_hash(root) or record.get("files") != frontend_output(root):
        raise ValueError("Frontend source or dist differs from the checked build receipt; rebuild before packaging")
    expected = ["npm ci", "node --test --test-concurrency=2", "npm run lint", "npm run build"]
    if record.get("checks") != expected:
        raise ValueError("Frontend build receipt does not record all required checks")
    return record


def compiler_path() -> Path:
    windows = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    for architecture in ("Framework64", "Framework"):
        path = windows / "Microsoft.NET" / architecture / "v4.0.30319" / "csc.exe"
        if path.is_file():
            return path
    raise RuntimeError("Windows .NET Framework C# compiler was not found; build the Windows preview on Windows")


def compile_launcher(root: Path, destination: Path) -> None:
    subprocess.run([str(compiler_path()), "/nologo", "/target:winexe", "/platform:x64", "/optimize+",
        "/utf8output", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
        "/reference:System.Web.Extensions.dll", "/out:" + str(destination), str(root / "scripts/portable_entry.cs")], check=True)


def command_file(action: str) -> str:
    if action not in ("start", "stop", "status"):
        raise ValueError("Unsupported launcher action")
    flags = "" if action == "start" else " --no-browser --json"
    return ("@echo off\r\nsetlocal DisableDelayedExpansion\r\n"
        '"%~dp0runtime\\python\\python.exe" -I -B "%~dp0app\\scripts\\portable_launcher.py" '
        + action + ' --root "%~dp0."' + flags + "\r\nif errorlevel 1 pause\r\n")


def instructions(version: str) -> str:
    return (f"Easel {version} Windows x64 便携预览版\n\n"
        "1. 将 ZIP 完整解压到较短的可写目录（例如 C:\\Easel），不要在压缩包预览中运行。\n"
        "2. 双击 Easel.exe，等待显示就绪，浏览器会打开工作台。\n"
        "3. 在工作台的设置中配置你自己的模型服务，再登录需要使用的平台。\n"
        "4. 保持控制窗口打开；关闭窗口会停止本副本的服务。也可点击“停止服务”。\n"
        "5. 搬迁或备份时，先停止服务，再移动整个文件夹；个人资料保存在 data。\n\n"
        "本包内置 Python、Node、OpenClaw、FFmpeg 与匹配的 Chromium，无需安装开发工具。\n"
        "适用于 Windows 10/11 x64；图形入口使用系统自带 .NET Framework。\n"
        "若图形窗口不可用，可双击“启动 Easel.cmd”；关闭命令窗口不代表服务已停止，\n"
        "请用“停止 Easel.cmd”结束本副本。不要手动删除仍在运行的目录。\n\n"
        "本地工作台可离线打开；在线模型、热榜、平台登录及发布需要联网。\n"
        "语音识别、抠图等功能可能首次下载各自的模型权重，权重未预装。\n"
        "包内没有账号、密钥、登录态或预配置模型。预览版尚未作代码签名。\n"
        "portable-manifest.json 记录组件版本与来源；checksums.sha256 可核验包内文件。\n"
        "第三方许可证随组件保留；对外转发请同时保留这些文件与源码来源。\n")


def distribution_files(bundle: Path):
    """Never inspect or distribute a used copy's personal data directory."""
    for folder, directories, files in os.walk(bundle, followlinks=False):
        if Path(folder) == bundle:
            directories[:] = [name for name in directories if name.casefold() != "data"]
            files = [name for name in files if name.casefold() != "data"]
        for name in directories + files:
            if is_link(Path(folder) / name):
                raise ValueError("Portable bundle contains linked distribution entries")
        for name in files:
            yield Path(folder) / name


def smoke_shared_scripts(bundle: Path) -> None:
    """Launch the actual embedded interpreter, which ignores normal script paths."""
    env = {key: value for key, value in os.environ.items() if key.lower() in ('systemroot', 'windir', 'temp', 'tmp', 'path')}
    env.update(EASEL_ROOT=str(bundle / 'app'), EASEL_DATA_DIR=str(bundle / 'data'), PYTHONIOENCODING='utf-8',
               USERPROFILE=str(bundle / 'data/home'), HOME=str(bundle / 'data/home'))
    for name in ('ai_image.py', 'ai_video.py', 'ai_music.py', 'voice_clone.py', 'channels_readback.py', 'xhs_readback.py'):
        result = subprocess.run([str(bundle / RUNTIME['python']), '-B',
            str(bundle / 'app/skills/shared/scripts' / name), '--help'], cwd=bundle / 'app',
            capture_output=True, env=env, timeout=30, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode:
            raise RuntimeError(f'Embedded script startup failed: {name}; portable export rejected')


def assemble(root: Path, bundle: Path, components: dict[str, Component], inputs: dict[str, dict[str, Path]], frontend: dict) -> dict:
    source = indexed_files(root)
    source_records = file_records(source)
    source_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root).decode("ascii").strip()
    if not re.fullmatch(r"[a-f0-9]{40,64}", source_commit):
        raise ValueError("Invalid source commit")
    source_dirty = bool(subprocess.check_output(["git", "diff", "HEAD", "--name-only"], cwd=root).strip())
    import tomllib
    version = normalize_version(tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"])
    bundle.mkdir(parents=True, exist_ok=False)
    for name, path in source.items():
        destination = bundle / "app" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
    # Hash again after copying: a preview may include indexed working changes,
    # but sourceCommit must never hide concurrent edits during assembly.
    copied_source = {name: bundle / "app" / name for name in source}
    if file_records(copied_source) != source_records:
        raise RuntimeError("Application source changed while copying")
    if frontend.get("sourceSha256") != frontend_source_hash(root) or frontend.get("files") != frontend_output(root):
        raise ValueError("The frontend changed after its acceptance checks")
    for name in frontend["files"]:
        destination = bundle / "app/web/frontend/dist" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / "web/frontend/dist" / name, destination)
    if file_records({name: bundle / "app/web/frontend/dist" / name for name in frontend["files"]}) != frontend["files"]:
        raise RuntimeError("Frontend output changed while copying")
    (bundle / "app/THIRD_PARTY_FRONTEND_LICENSES.txt").write_text(frontend_notices(root), encoding="utf-8")
    metadata = {}
    notices = []
    for name, component in components.items():
        for relative, path in inputs[name].items():
            destination = bundle / "runtime" / name / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
        records = file_records({relative: bundle / "runtime" / name / relative for relative in inputs[name]})
        checksum = tree_hash(records)
        if component.expected_tree and component.expected_tree.casefold() != checksum:
            raise ValueError(f"Prepared component checksum mismatch: {name}")
        metadata[name] = {"version": component.version, "source": component.source,
            "treeSha256": checksum, "files": len(records), "bytes": sum(item["bytes"] for item in records.values()),
            "licenses": [f"runtime/{name}/{path}" for path in component.licenses]}
        if component.source_code:
            metadata[name]["sourceCode"] = component.source_code
        if component.source_archive_sha256:
            metadata[name]["sourceArchiveSha256"] = component.source_archive_sha256
        for license_name in component.licenses:
            notice = inputs[name][license_name].read_text(encoding="utf-8-sig", errors="replace")
            notices.append(f"\n{'=' * 72}\n{name} {component.version} / {license_name}\n{component.source}\n\n{notice}")
    (bundle / "THIRD_PARTY_LICENSES.txt").write_text("Bundled runtime component notices\n" + "\n".join(notices), encoding="utf-8")
    smoke_shared_scripts(bundle)
    compile_launcher(bundle / "app", bundle / "Easel.exe")
    for filename, action in (("启动 Easel.cmd", "start"), ("停止 Easel.cmd", "stop"), ("检查 Easel.cmd", "status")):
        (bundle / filename).write_bytes(command_file(action).encode("ascii"))
    (bundle / "开始使用.txt").write_text(instructions(version), encoding="utf-8-sig")
    (bundle / "data").mkdir()
    manifest = {"schemaVersion": 1, "kind": "easel-windows-portable", "version": version,
        "channel": "preview", "platform": "win32-x64", "app": "app", "data": "data", "runtime": RUNTIME,
        "sourceCommit": source_commit, "sourceDirty": source_dirty, "sourceIndexedOnly": True,
        "sourceTreeSha256": tree_hash(source_records), "frontend": frontend,
        "components": metadata, "checksums": "checksums.sha256"}
    (bundle / "portable-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    records = file_records({path.relative_to(bundle).as_posix(): path for path in distribution_files(bundle)})
    (bundle / "checksums.sha256").write_text("".join(f"{item['sha256']}  {name}\n" for name, item in records.items()), encoding="utf-8")
    return manifest


def verify_bundle(bundle: Path) -> dict:
    manifest = json.loads((bundle / "portable-manifest.json").read_text(encoding="utf-8-sig"))
    if (manifest.get("schemaVersion") != 1 or manifest.get("kind") != "easel-windows-portable"
            or manifest.get("runtime") != RUNTIME or manifest.get("app") != "app"
            or manifest.get("data") != "data" or manifest.get("checksums") != "checksums.sha256"):
        raise ValueError("Unrecognized portable manifest")
    listed: set[str] = set()
    for line in (bundle / "checksums.sha256").read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  (.+)", line)
        if not match:
            raise ValueError("Invalid portable checksum record")
        digest, name = match.groups()
        relative_name(name)
        if PurePosixPath(name).parts[0].casefold() == "data":
            raise ValueError("Personal data must never appear in the distribution checksum inventory")
        if name.casefold() in listed:
            raise ValueError("Duplicate portable checksum entry")
        listed.add(name.casefold())
        target = bundle / name
        if not target.is_file() or is_link(target) or not target.resolve().is_relative_to(bundle.resolve()) or sha256_of(target) != digest:
            raise ValueError(f"Portable file checksum mismatch: {name}")
    if not listed or "portable-manifest.json" not in listed or "easel.exe" not in listed:
        raise ValueError("Incomplete portable checksum inventory")
    actual = {path.relative_to(bundle).as_posix().casefold() for path in distribution_files(bundle)}
    if actual != listed | {"checksums.sha256"}:
        raise ValueError("Portable bundle contains unlisted files")
    return manifest


def write_archive(bundle: Path, output: Path, manifest: dict) -> Path:
    # Explorer defaults to extracting into a folder named after the ZIP. Keep
    # that folder short; complete version/source hashes remain in the manifest.
    suffix = manifest["sourceTreeSha256"][:4]
    name = f"Easel-preview-{manifest['sourceCommit'][:7]}-{suffix}.zip"
    archive = output / name
    if archive.exists() or archive.with_suffix(".zip.sha256").exists():
        raise FileExistsError("A portable preview with this source identity already exists; use a new output directory")
    verify_bundle(bundle)
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as target:
        for path in sorted(distribution_files(bundle)):
            target.write(path, path.relative_to(bundle).as_posix())
        target.writestr("data/", b"")
    archive.with_suffix(".zip.sha256").write_text(f"{sha256_of(archive)}  {archive.name}\n", encoding="ascii")
    return archive


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--components", type=Path, help="Prepared public component manifest; never a venv or installed user-data directory")
    parser.add_argument("--output", type=Path, default=ROOT / "dist/portable-preview")
    parser.add_argument('--directory-only', action='store_true', help='Keep an unpacked runnable Easel directory; do not create a ZIP')
    parser.add_argument("--prepare-frontend", type=Path, metavar="RECEIPT", help="Run frontend checks/build and write a reusable verified receipt, then exit")
    parser.add_argument("--frontend-receipt", type=Path, help="Reuse only a receipt whose source AND dist hashes still match")
    parser.add_argument("--verify-bundle", type=Path, help="Check every distributed file in an extracted portable bundle, then exit")
    args = parser.parse_args(argv)
    if args.verify_bundle:
        verify_bundle(args.verify_bundle.resolve())
        print("Portable bundle checksums verified")
        return 0
    if args.prepare_frontend:
        prepare_frontend(ROOT, args.prepare_frontend.resolve())
        return 0
    if not args.components:
        parser.error("--components is required for assembly")
    components = load_components(args.components.resolve())
    inputs = component_files(components)
    frontend = verify_frontend_receipt(ROOT, args.frontend_receipt.resolve()) if args.frontend_receipt else prepare_frontend(ROOT, node_dir=components["node"].path)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if args.directory_only:
        bundle = output / 'Easel-fixed'
        assemble(ROOT, bundle, components, inputs, frontend)
        verify_bundle(bundle)
        print(f'Unpacked portable preview ready for acceptance: {bundle}')
        return 0
    with tempfile.TemporaryDirectory(prefix=".easel-portable-build-", dir=output) as temporary:
        bundle = Path(temporary) / "bundle"
        manifest = assemble(ROOT, bundle, components, inputs, frontend)
        archive = write_archive(bundle, output, manifest)
    print(f"Portable preview ready for acceptance, not published: {archive}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
