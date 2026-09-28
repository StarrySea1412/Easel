"""Release payload privacy, pinned dependencies and executable binding contracts."""
import json
from pathlib import Path
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
    monkeypatch.setattr(release.subprocess, "check_output", lambda *a, **k: "\0".join(files).encode())
    archive = tmp_path / "Easel-0.2.1-windows.zip"
    release.build_archive(tmp_path, archive, "0.2.1", lock)
    with zipfile.ZipFile(archive) as z:
        names = z.namelist()
        assert ".env" not in names and "outputs/private.html" not in names
        assert "profiles/alice/secret.txt" not in names
        assert "LICENSE" in names and "web/frontend/dist/index.html" in names
        assert "MIT License" in z.read("THIRD_PARTY_FRONTEND_LICENSES.txt").decode()
        assert json.loads(z.read("release-manifest.json"))["dependencies"]["openclaw"] == "2026.9.6"
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
