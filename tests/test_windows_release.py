"""Release payload privacy, pinned dependencies and executable binding contracts."""
import json
from pathlib import Path
import subprocess
import sys
import zipfile

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_windows_release as release
import bootstrapper


@pytest.mark.parametrize("name", [
    ".env", ".env.local", "profiles/alice/profile.md", "outputs/report.html",
    "assets/private.png", "skills/one/cookies.json", "skills/one/.env",
    "skills/one/wechat-publisher.yaml", ".venv/Scripts/python.exe",
    "web/frontend/node_modules/secret.txt", "install-state.json",
    "assets/readme/videos/full/demo.mp4",
])
def test_local_data_excluded_even_if_accidentally_indexed(name):
    assert not release.allowed_source(name)


@pytest.mark.parametrize("name", [
    "LICENSE", ".env.example", "profiles/_template/profile.md", "outputs/.gitkeep",
    "assets/icon.png", "assets/readme/home.png", "skills/one/LICENSE",
    "setup.ps1", "easel/install_runner.py",
])
def test_shipped_source_templates_and_licenses_retained(name):
    assert release.allowed_source(name)


def test_report_becomes_exact_versions_without_download_urls():
    report = {"install": [{"metadata": {"name": name, "version": version},
                            "download_info": {"url": "https://user:secret@example.test/file.whl"}}
                           for name, version in [("easel", "0.2.1"), ("setuptools", "84.0.0"),
                                                 ("wheel", "0.48.0"), ("httpx", "0.28.1")]]}
    lock = release.lock_from_report(report)
    assert "httpx==0.28.1" in lock and "setuptools==84.0.0" in lock
    assert "secret" not in lock and "https:" not in lock and "easel==" not in lock
    with pytest.raises(RuntimeError, match="setuptools"):
        release.lock_from_report({"install": []})


def test_packaged_archive_excludes_secrets_includes_dist_and_roundtrips(tmp_path, monkeypatch):
    files = {"setup.ps1": "# powershell", "easel/install_runner.py": "# runner",
             "LICENSE": "Apache License", ".env": "SECRET=never ship", ".env.example": "KEY=",
             "profiles/alice/secret.txt": "credential", "profiles/_template/README.md": "template",
             "outputs/private.html": "private", "assets/private.png": "private"}
    for name, content in files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    front = tmp_path / "web/frontend/dist"
    front.mkdir(parents=True)
    (front / "index.html").write_text("<html>Easel</html>")
    license_path = tmp_path / "web/frontend/node_modules/react/LICENSE"
    license_path.parent.mkdir(parents=True)
    license_path.write_text("MIT License")
    lock = tmp_path / "lock.txt"
    lock.write_text("setuptools==84.0.0\nwheel==0.48.0\n")
    def git_output(command, **kwargs):
        if command[1] == "rev-parse":
            return b"1234567890123456789012345678901234567890\n"
        if command[1] == "diff":
            return b""
        return "\0".join(files).encode()
    monkeypatch.setattr(release.subprocess, "check_output", git_output)
    archive = tmp_path / "Easel-0.2.1-windows.zip"
    release.build_archive(tmp_path, archive, "0.2.1", lock)
    with zipfile.ZipFile(archive) as z:
        names = z.namelist()
        assert ".env" not in names and "outputs/private.html" not in names
        assert "profiles/alice/secret.txt" not in names
        assert "LICENSE" in names and "web/frontend/dist/index.html" in names
        assert "MIT License" in z.read("THIRD_PARTY_FRONTEND_LICENSES.txt").decode()
        assert json.loads(z.read("release-manifest.json"))["dependencies"]["openclaw"] == "2026.9.6"
        assert json.loads(z.read("release-manifest.json"))["sourceCommit"] == "1234567890123456789012345678901234567890"
        assert json.loads(z.read("release-manifest.json"))["sourceDirty"] is False
    digest = bootstrapper.sha256_of(archive)
    assert archive.with_suffix(".zip.sha256").read_text().startswith(digest)
    installed = bootstrapper.extract_to(archive, tmp_path / "installed", "0.2.1", digest)
    assert json.loads((installed / bootstrapper.MARKER).read_text())["sha256"] == digest


def test_checked_in_lock_has_exact_versions_and_build_requirements():
    lines = (ROOT / "requirements/windows-py312.lock").read_text().splitlines()
    requirements = [line for line in lines if line and not line.startswith("#")]
    assert len(requirements) > 50
    assert all("==" in line and "://" not in line and " @ " not in line for line in requirements)
    assert any(line.startswith("setuptools==") for line in requirements)
    assert any(line.startswith("wheel==") for line in requirements)


def test_user_zip_contains_only_gui_delivery_and_verified_checksum(tmp_path):
    exe = tmp_path / "Easel-Setup-0.2.3.exe"
    exe.write_bytes(b"test executable fixture")
    exe.with_suffix(".exe.sha256").write_text(f"{bootstrapper.sha256_of(exe)}  {exe.name}\n")
    (tmp_path / ".env").write_text("SECRET=must-not-ship")
    package = release.build_user_bundle(tmp_path, "0.2.3")
    with zipfile.ZipFile(package) as archive:
        assert set(archive.namelist()) == {exe.name, exe.name + ".sha256", "开始使用.txt"}
        assert archive.read(exe.name) == exe.read_bytes()
        assert "图形安装器" in archive.read("开始使用.txt").decode("utf-8-sig")
    exe.write_bytes(b"changed")
    with pytest.raises(RuntimeError, match="checksum"):
        release.build_user_bundle(tmp_path, "0.2.3")


@pytest.fixture
def release_checkout(tmp_path, monkeypatch):
    """Synthetic checkout; no npm, freezer, installer or network is executed."""
    (tmp_path / "pyproject.toml").write_text('[project]\nversion = "0.2.7"\n', encoding="utf-8")
    lock = tmp_path / "requirements/windows-py312.lock"
    lock.parent.mkdir()
    lock.write_text("setuptools==84.0.0\nwheel==0.48.0\n", encoding="utf-8")
    frontend = tmp_path / "web/frontend"
    (frontend / "dist").mkdir(parents=True)
    (frontend / "dist/index.html").write_text("stale frontend", encoding="utf-8")
    monkeypatch.setattr(release, "ROOT", tmp_path)
    monkeypatch.setattr(release.shutil, "which", lambda _name: "fixture-npm")
    return tmp_path, frontend


@pytest.mark.parametrize("payload_only", [False, True])
def test_release_entrypoint_rebuilds_before_any_packaging(release_checkout, monkeypatch, payload_only):
    root, frontend = release_checkout
    calls = []

    def run(command, *, cwd, check):
        assert cwd == frontend and check is True
        calls.append(tuple(command[1:]))
        if command[1:] == ["run", "build"]:
            (frontend / "dist/index.html").write_text("fresh frontend", encoding="utf-8")

    def archive(source, dest, version, lock):
        assert source == root and version == "0.2.7" and lock.is_file()
        assert (frontend / "dist/index.html").read_text(encoding="utf-8") == "fresh frontend"
        calls.append("archive")
        dest.write_bytes(b"synthetic payload fixture")

    monkeypatch.setattr(release.subprocess, "run", run)
    monkeypatch.setattr(release, "build_archive", archive)
    monkeypatch.setattr(release, "build_exe", lambda *_args: calls.append("exe"))
    monkeypatch.setattr(release, "build_user_bundle", lambda *_args: calls.append("user-bundle"))
    output = root / "candidate"
    monkeypatch.setattr(sys, "argv", ["build_windows_release.py", "--output", str(output)]
                        + (["--skip-exe"] if payload_only else []))
    release.main()
    assert calls == [("ci",), ("test",), ("run", "lint"), ("run", "build"), "archive"] + (
        [] if payload_only else ["exe", "user-bundle"])
    manifest = json.loads((output / "release.json").read_text(encoding="utf-8"))
    assert manifest["version"] == "0.2.7"
    assert manifest["url"] == f"https://github.com/StarrySea1412/Easel/releases/download/v0.2.7/{manifest['archive']}"
    assert manifest["sha256"] == bootstrapper.sha256_of(output / manifest["archive"])


@pytest.mark.parametrize("failure", [("ci",), ("test",), ("run", "lint"), ("run", "build")])
def test_frontend_failure_never_packages_a_previous_dist(release_checkout, monkeypatch, failure):
    root, frontend = release_checkout
    calls = []

    def run(command, **_kwargs):
        step = tuple(command[1:])
        calls.append(step)
        if step == failure:
            raise subprocess.CalledProcessError(1, command)

    monkeypatch.setattr(release.subprocess, "run", run)
    monkeypatch.setattr(release, "build_archive", lambda *_args: pytest.fail("failed frontend must not be packaged"))
    monkeypatch.setattr(release, "build_exe", lambda *_args: pytest.fail("failed frontend must not be frozen"))
    output = root / "candidate"
    monkeypatch.setattr(sys, "argv", ["build_windows_release.py", "--output", str(output)])
    with pytest.raises(subprocess.CalledProcessError):
        release.main()
    assert calls[-1] == failure
    assert (frontend / "dist/index.html").read_text(encoding="utf-8") == "stale frontend"
    assert list(output.iterdir()) == []


def test_missing_npm_stops_before_using_existing_frontend(release_checkout, monkeypatch):
    root, _frontend = release_checkout
    monkeypatch.setattr(release.shutil, "which", lambda _name: None)
    monkeypatch.setattr(release.subprocess, "run", lambda *_args, **_kwargs: pytest.fail("npm unavailable"))
    with pytest.raises(RuntimeError, match="npm is required"):
        release.build_frontend(root)


def test_lock_only_resolves_without_building_frontend(release_checkout, monkeypatch):
    root, _frontend = release_checkout
    resolved = []
    monkeypatch.setattr(release, "resolve_lock", resolved.append)
    monkeypatch.setattr(release, "build_frontend", lambda *_args: pytest.fail("lock-only must not build"))
    monkeypatch.setattr(sys, "argv", ["build_windows_release.py", "--lock-only"])
    release.main()
    assert resolved == [root / "requirements/windows-py312.lock"]
