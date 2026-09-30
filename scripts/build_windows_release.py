"""Build a self-contained Windows installer and its verified payload (does not publish).

Run with Windows CPython 3.12. Every package build runs npm ci, test, lint and
build first. Resolve the runtime lock once per release, then retain it with
the release artifacts. Only Git-indexed files and freshly built frontend dist
are packaged; local credentials, profiles, caches and outputs cannot leak in.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from bootstrapper import RELEASE_REPOSITORY, normalize_version, sha256_of

ROOT = Path(__file__).resolve().parents[1]
OPENCLAW_VERSION = "2026.9.6"


def lock_from_report(report: dict) -> str:
    packages = {}
    for item in report["install"]:
        meta = item["metadata"]
        name, version = meta["name"], meta["version"]
        if name.lower() == "easel":
            continue
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or not re.fullmatch(r"[A-Za-z0-9_.+!-]+", version):
            raise RuntimeError("Unexpected package name/version in pip report")
        packages[name.lower().replace("_", "-")] = f"{name}=={version}"
    if not {"setuptools", "wheel"}.issubset(packages):
        raise RuntimeError("The lock must include setuptools and wheel")
    return "# Generated on Windows CPython 3.12; retain this lock for this release.\n" + "\n".join(
        packages[name] for name in sorted(packages)) + "\n"


def resolve_lock(dest: Path) -> None:
    if sys.version_info[:2] != (3, 12) or sys.platform != "win32":
        raise RuntimeError("Resolve release dependencies on Windows CPython 3.12")
    with tempfile.TemporaryDirectory(prefix="easel-lock-") as temp:
        report = Path(temp) / "report.json"
        subprocess.run([sys.executable, "-m", "pip", "install", "--dry-run", "--ignore-installed",
                        "--report", str(report), str(ROOT), "setuptools>=68", "wheel"], check=True)
        dest.write_text(lock_from_report(json.loads(report.read_text(encoding="utf-8"))), encoding="utf-8")


def allowed_source(name: str) -> bool:
    parts = Path(name).parts
    if not parts or parts[0] in (".git", ".github", ".scratch", ".venv", ".tools", "data", "tests", "dist", "build"):
        return False
    if any(p in ("node_modules", "__pycache__", ".pytest_cache") for p in parts):
        return False
    leaf = parts[-1].lower()
    if leaf.startswith(".env") and leaf != ".env.example":
        return False
    if leaf in ("cookies.json", "wechat-publisher.yaml", "install-state.json") or leaf.endswith((".log", ".pyc")):
        return False
    if parts[0] == "profiles" and (len(parts) < 2 or parts[1] != "_template"):
        return False
    if parts[0] == "outputs" and leaf != ".gitkeep":
        return False
    if parts[:3] == ("assets", "readme", "videos"):
        return False  # Hundreds of MB of documentation demos are not runtime dependencies.
    if parts[:3] == ("web", "static", "showcase"):
        return False  # README-only demo videos; the app never serves this tree.
    if parts[0] == "assets" and not (len(parts) > 1 and parts[1] == "readme") and leaf not in (
            "icon.png", "icon-transparent.png", "icon-noword.png", ".gitkeep"):
        return False
    return True


def frontend_notices(root: Path) -> str:
    notices = []
    modules = root / "web/frontend/node_modules"
    for folder, dirs, files in os.walk(modules):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if re.match(r"^(license|licence|copying|notice)(\.|$)", name, re.I):
                path = Path(folder) / name
                if not path.is_symlink():
                    notices.append(f"\n{'=' * 72}\n{path.relative_to(modules).as_posix()}\n\n"
                                   + path.read_text(encoding="utf-8", errors="replace"))
    if not notices:
        raise RuntimeError("Frontend dependency licenses missing; run npm ci first")
    return "Third-party frontend dependency notices\n" + "\n".join(sorted(notices))


def build_frontend(root: Path) -> None:
    """Build this checkout from its lockfile; an existing dist is never reused."""
    npm = shutil.which("npm.cmd" if sys.platform == "win32" else "npm")
    if npm is None:
        raise RuntimeError("npm is required to verify and rebuild the release frontend")
    frontend = root / "web/frontend"
    for args in (("ci",), ("test",), ("run", "lint"), ("run", "build")):
        subprocess.run([npm, *args], cwd=frontend, check=True)


def build_archive(root: Path, archive: Path, version: str, lock: Path) -> None:
    if not (root / "web/frontend/dist/index.html").is_file():
        raise RuntimeError("Release frontend build did not produce dist/index.html")
    listed = subprocess.check_output(["git", "ls-files", "--cached", "-z"], cwd=root).decode("utf-8").split("\0")
    files = sorted({name for name in listed if name and allowed_source(name)})
    source_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root).decode("ascii").strip()
    source_dirty = bool(subprocess.check_output(["git", "diff", "HEAD", "--name-only"], cwd=root).strip())
    manifest = {"schemaVersion": 1, "version": version,
        "sourceCommit": source_commit, "sourceDirty": source_dirty, "sourceIndexedOnly": True,
        "dependencies": {
        "openclaw": OPENCLAW_VERSION, "python": "3.12", "pythonLock": "requirements-windows.lock"}}
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for name in files:
            path = root / name
            if path.is_symlink() or not path.is_file():
                raise RuntimeError(f"Indexed source is missing or linked: {name}")
            z.write(path, name)
        for path in sorted((root / "web/frontend/dist").rglob("*")):
            if path.is_symlink():
                raise RuntimeError("Frontend dist must not contain symlinks")
            if path.is_file():
                z.write(path, path.relative_to(root).as_posix())
        z.writestr("release-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        z.write(lock, "requirements-windows.lock")
        z.writestr("THIRD_PARTY_FRONTEND_LICENSES.txt", frontend_notices(root))
    archive.with_suffix(".zip.sha256").write_text(f"{sha256_of(archive)}  {archive.name}\n", encoding="ascii")


def build_exe(output: Path, release: Path, archive: Path, version: str) -> None:
    if not archive.is_file() or not archive.with_suffix(".zip.sha256").is_file():
        raise RuntimeError("Windows payload or its SHA-256 file is missing")
    notices = []
    for package in ("pyinstaller", "pyinstaller-hooks-contrib", "altgraph", "pefile", "pywin32-ctypes", "packaging"):
        dist = importlib.metadata.distribution(package)
        for file in dist.files or []:
            if re.match(r"^(license|copying|notice)(\.|$)", file.name, re.I):
                notices.append(f"\n{package} / {file}\n" + dist.locate_file(file).read_text(encoding="utf-8", errors="replace"))
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
    if not python_license.is_file():
        raise RuntimeError("CPython LICENSE.txt is required for the bundled interpreter")
    notices.append("\nCPython\n" + python_license.read_text(encoding="utf-8", errors="replace"))
    license_file = output / "THIRD_PARTY_BOOTSTRAPPER_LICENSES.txt"
    license_file.write_text("\n".join(notices), encoding="utf-8")
    # Do not accidentally bundle DLLs or run UPX from unrelated tools on the build host.
    env = os.environ.copy()
    env.pop("PYTHONPATH", None)
    env.pop("PYTHONHOME", None)
    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    env["PATH"] = os.pathsep.join(map(str, (Path(sys.prefix) / "Scripts", Path(sys.base_prefix),
        Path(sys.base_prefix) / "DLLs", system_root / "System32", system_root)))
    with tempfile.TemporaryDirectory(prefix="easel-pyinstaller-") as temp:
        frozen_dir = Path(temp) / "frozen"
        subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
                        "--windowed", "--noupx", "--name", f"Easel-Setup-{version}", "--distpath", str(frozen_dir),
                        "--workpath", str(Path(temp) / "work"), "--specpath", temp,
                        "--add-data", f"{release}{os.pathsep}.",
                        "--add-data", f"{archive}{os.pathsep}.",
                        "--add-data", f"{archive.with_suffix('.zip.sha256')}{os.pathsep}.",
                        "--add-data", f"{license_file}{os.pathsep}.", str(ROOT / "scripts/bootstrapper.py")], check=True, env=env)
        exe = output / f"Easel-Setup-{version}.exe"
        os.replace(frozen_dir / exe.name, exe)
    exe.with_suffix(".exe.sha256").write_text(f"{sha256_of(exe)}  {exe.name}\n", encoding="ascii")


def build_user_bundle(output: Path, version: str) -> Path:
    """The user ZIP opens the same GUI installer, without a console bootstrap."""
    exe = output / f"Easel-Setup-{version}.exe"
    checksum = exe.with_suffix(".exe.sha256")
    if not exe.is_file() or not checksum.is_file():
        raise RuntimeError("GUI installer and checksum must exist before user packaging")
    if checksum.read_text(encoding="ascii").split()[0] != sha256_of(exe):
        raise RuntimeError("GUI installer checksum does not match")
    package = output / f"Easel-{version}-Windows-GUI.zip"
    instructions = (
        f"Easel {version} — 图形安装器 + 网页工作台\n\n"
        f"1. 将压缩包完整解压到一个文件夹。\n2. 双击 {exe.name}。\n"
        "3. 在安装向导中选择安装位置，点击“开始安装”，查看各阶段进度。\n"
        "4. 安装成功后点击“打开工作台”，浏览器会自动打开。\n"
        "5. 以后双击安装目录里的“打开 Easel.vbs”启动；失败时会显示重试提示。\n\n"
        "首次安装需要联网下载运行依赖；这个包不是完全离线运行时包。\n"
        "账号和模型服务由你在工作台中连接，包内不含预置账号、密码或 API Key。\n"
        "升级请选择原安装目录；个人资料保存在 data 子目录。\n"
        "本测试版未作代码签名，SHA-256 校验文件随包提供。\n"
    )
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        archive.write(exe, exe.name)
        archive.write(checksum, checksum.name)
        archive.writestr("开始使用.txt", instructions.encode("utf-8-sig"))
        licenses = output / "THIRD_PARTY_BOOTSTRAPPER_LICENSES.txt"
        if licenses.is_file():
            archive.write(licenses, licenses.name)
    package.with_suffix(".zip.sha256").write_text(f"{sha256_of(package)}  {package.name}\n", encoding="ascii")
    return package


def main() -> None:
    import tomllib  # The release build runs on Python 3.12; runtime supports 3.10+.
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--output", type=Path, default=ROOT / "dist")
    ap.add_argument("--lock-file", type=Path, help="Reuse this release's previously resolved Windows 3.12 lock")
    ap.add_argument("--lock-only", action="store_true", help="Resolve and save dependencies; do not package yet")
    ap.add_argument("--skip-exe", action="store_true", help="Build payload only; frontend checks and build still run")
    args = ap.parse_args()
    version = normalize_version(tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"])
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    lock = args.lock_file.resolve() if args.lock_file else ROOT / "requirements/windows-py312.lock"
    if args.lock_only:
        resolve_lock(lock)
        return
    if not lock.is_file():
        raise RuntimeError("Windows Python lock missing; generate it with --lock-only and review it")
    # Both full and payload-only releases must rebuild. Do not offer a stale-dist
    # shortcut: sourceCommit describes the checkout that produced this frontend.
    build_frontend(ROOT)
    archive = output / f"Easel-{version}-windows.zip"
    build_archive(ROOT, archive, version, lock)
    release = output / "release.json"
    release.write_text(json.dumps({"version": version, "archive": archive.name,
        "url": f"https://github.com/{RELEASE_REPOSITORY}/releases/download/v{version}/{archive.name}",
        "sha256": sha256_of(archive)}, indent=2), encoding="utf-8")
    if not args.skip_exe:
        build_exe(output, release, archive, version)
        build_user_bundle(output, version)
    print(f"Release artifacts ready for review: {output}")


if __name__ == "__main__":
    main()
