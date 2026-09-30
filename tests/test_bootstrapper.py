"""Offline HTTPS installer tests; setup is always mocked, data stays in tmp_path."""
from __future__ import annotations

import hashlib
import io
import json
import os
import ssl
import stat
import sys
import urllib.error
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
import bootstrapper as bt  # noqa: E402

URL = "https://github.com/ZJU-REAL/Easel/releases/download/v0.2.1/Easel-0.2.1-windows.zip"
VERSION, DIGEST = "0.2.1", "a" * 64


def _ps(value) -> str:
    """Mirror bootstrapper._ps_literal for launcher-content assertions."""
    return str(value).replace("'", "''")


def test_gui_install_output_redacts_env_bearer_and_url_credentials(tmp_path, monkeypatch):
    base = tmp_path / "data"
    base.mkdir()
    (base / ".env").write_text("OPENAI_API_KEY=fake_api_secret_123\n", encoding="utf-8")
    monkeypatch.setenv("EASEL_NOTIFY_SMTP_PASSWORD", "fake_smtp_secret_456")
    text = ("Bearer fake_api_secret_123; api_key=fake_api_secret_123 "
            "https://user:pass@example.test/v1 password=fake_smtp_secret_456")
    result = bt.redact_install_output(text, base)
    assert "fake_api_secret_123" not in result
    assert "fake_smtp_secret_456" not in result
    assert "user:pass@" not in result
    assert "Bearer [REDACTED]" in result


class Response(io.BytesIO):
    def __init__(self, content: bytes, url: str = URL):
        super().__init__(content)
        self.url = url

    def geturl(self):
        return self.url


@pytest.fixture(autouse=True)
def local_env(tmp_path, monkeypatch):
    monkeypatch.setattr(bt, "USER_DIR", tmp_path / "AppData")
    monkeypatch.setattr(bt.time, "sleep", lambda _delay: None)
    monkeypatch.setattr(bt.urllib.request, "urlopen", lambda *_a, **_k: pytest.fail("Unmocked network request"))


def serve(monkeypatch, content: bytes, url: str = URL):
    calls = []

    def fake(req, timeout=None):
        calls.append(req.full_url)
        return Response(content, url)

    monkeypatch.setattr(bt.urllib.request, "urlopen", fake)
    return calls


def archive(path: Path, top: str = "", version: str = VERSION, extra=None, omit=()):
    members = {
        "setup.ps1": "# mocked setup\n",
        "release-manifest.json": json.dumps({"schemaVersion": 1, "version": version}),
        "easel/install_runner.py": "# mocked runner\n",
        "web/frontend/dist/index.html": "<html></html>",
        "requirements-windows.lock": "# mock lock\n",
    }
    members.update(extra or {})
    with zipfile.ZipFile(path, "w") as z:
        for name, value in members.items():
            if name in omit:
                continue
            z.writestr((top + "/" if top else "") + name, value)
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.parametrize("version", ["0.2.1", "v0.2.1", "0.2.1-rc.1", "0.2.1-beta-2"])
def test_version_is_normalized(version):
    normalized = bt.normalize_version(version)
    assert not normalized.startswith("v")
    assert bt.install_root(version) == bt.USER_DIR / "versions" / normalized


@pytest.mark.parametrize("version", ["", "../0.2.1", "0.2", "v../x", "1.2.3/../x", "C:\\x", "0.2.1 ", "0.2.1+meta"])
def test_invalid_version_cannot_escape_install_root(version):
    with pytest.raises(RuntimeError, match="版本"):
        bt.install_root(version)


@pytest.mark.parametrize("url", ["file:///a.zip", "http://example.com/a.zip", "https://user:pass@example.com/a", "https://example.com/a?key=secret", "https://example.com/a#hash", "ftp://example.com/a", "https:///a"])
def test_download_requires_safe_https_url(tmp_path, url):
    with pytest.raises(RuntimeError, match="HTTPS"):
        bt.download_with_retry(url, tmp_path / "download.zip", DIGEST)


def test_download_verifies_digest_and_atomically_publishes(tmp_path, monkeypatch):
    data = b"verified bytes"
    calls = serve(monkeypatch, data)
    target = tmp_path / "download.zip"
    assert bt.download_with_retry(URL, target, hashlib.sha256(data).hexdigest().upper()) == target
    assert target.read_bytes() == data and calls == [URL]
    assert not target.with_name("download.zip.part").exists()


def test_bad_digest_keeps_previous_download_and_removes_partial(tmp_path, monkeypatch):
    target = tmp_path / "download.zip"
    target.write_bytes(b"known good")
    calls = serve(monkeypatch, b"bad bytes")
    with pytest.raises(RuntimeError, match="校验失败"):
        bt.download_with_retry(URL, target, DIGEST)
    assert target.read_bytes() == b"known good" and calls == [URL]
    assert not target.with_name("download.zip.part").exists()


def test_sidecar_is_validated_before_archive_download(tmp_path, monkeypatch):
    data, calls = b"archive", []
    digest = hashlib.sha256(data).hexdigest()

    def fake(req, timeout=None):
        calls.append(req.full_url)
        return Response((digest + "  Easel.zip\n").encode() if req.full_url.endswith(".sha256") else data)

    monkeypatch.setattr(bt.urllib.request, "urlopen", fake)
    assert bt.download_with_retry(URL, tmp_path / "download.zip").read_bytes() == data
    assert calls == [URL + ".sha256", URL]


@pytest.mark.parametrize("sidecar", [b"", b"bad-digest", b"0" * 63])
def test_invalid_sidecar_refuses_archive(tmp_path, monkeypatch, sidecar):
    calls = serve(monkeypatch, sidecar)
    with pytest.raises(RuntimeError, match="SHA-256"):
        bt.download_with_retry(URL, tmp_path / "download.zip")
    assert calls == [URL + ".sha256"]


@pytest.mark.parametrize("code", [400, 401, 403, 404])
def test_permanent_http_errors_do_not_retry(tmp_path, monkeypatch, code):
    calls = []

    def fail(req, timeout=None):
        calls.append(req.full_url)
        raise urllib.error.HTTPError(req.full_url, code, "failure", {}, None)

    monkeypatch.setattr(bt.urllib.request, "urlopen", fail)
    with pytest.raises(RuntimeError, match=f"HTTP {code}.*1 次"):
        bt.download_with_retry(URL, tmp_path / "download.zip", DIGEST)
    assert len(calls) == 1


@pytest.mark.parametrize("failure", [TimeoutError(), urllib.error.URLError(ConnectionResetError()), urllib.error.HTTPError(URL, 503, "temporary", {}, None)])
def test_transient_errors_retry_with_backoff_then_succeed(tmp_path, monkeypatch, failure):
    calls, delays, content = [], [], b"recovered"

    def flaky(req, timeout=None):
        calls.append(req.full_url)
        if len(calls) < 3:
            raise failure
        return Response(content)

    monkeypatch.setattr(bt.urllib.request, "urlopen", flaky)
    monkeypatch.setattr(bt.time, "sleep", delays.append)
    bt.download_with_retry(URL, tmp_path / "download.zip", hashlib.sha256(content).hexdigest())
    assert len(calls) == 3 and delays == [5, 15]


def test_transient_retry_budget_is_bounded(tmp_path, monkeypatch):
    calls, delays = [], []

    def fail(req, timeout=None):
        calls.append(req.full_url)
        raise TimeoutError()

    monkeypatch.setattr(bt.urllib.request, "urlopen", fail)
    monkeypatch.setattr(bt.time, "sleep", delays.append)
    with pytest.raises(RuntimeError, match="3 次"):
        bt.download_with_retry(URL, tmp_path / "download.zip", DIGEST)
    assert len(calls) == 3 and delays == [5, 15]


def test_local_write_permission_error_does_not_retry(tmp_path, monkeypatch):
    calls, original = serve(monkeypatch, b"data"), Path.open

    def guarded(path, *args, **kwargs):
        if path.name == "download.zip.part":
            raise PermissionError("write denied")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", guarded)
    with pytest.raises(RuntimeError, match="PermissionError.*1 次"):
        bt.download_with_retry(URL, tmp_path / "download.zip", DIGEST)
    assert len(calls) == 1


def test_non_https_redirect_is_rejected(tmp_path, monkeypatch):
    calls = serve(monkeypatch, b"data", "http://example.com/download.zip")
    with pytest.raises(RuntimeError, match="重定向"):
        bt.download_with_retry(URL, tmp_path / "download.zip", DIGEST)
    assert len(calls) == 1


def test_download_size_limit_cleans_partial(tmp_path, monkeypatch):
    monkeypatch.setattr(bt, "MAX_ARCHIVE_BYTES", 2)
    calls = serve(monkeypatch, b"too large")
    with pytest.raises(RuntimeError, match="大小"):
        bt.download_with_retry(URL, tmp_path / "download.zip", DIGEST)
    assert not list(tmp_path.iterdir()) and len(calls) == 1


@pytest.mark.parametrize("top", ["", "Easel-source"])
def test_extract_flattens_archive_and_writes_marker(tmp_path, top):
    source, dest = tmp_path / "source.zip", tmp_path / "versions" / VERSION
    digest = archive(source, top)
    assert bt.extract_to(source, dest, VERSION, digest) == dest
    assert (dest / "setup.ps1").is_file()
    assert json.loads((dest / bt.MARKER).read_text()) == {"version": VERSION, "sha256": digest}
    assert not list(dest.parent.glob(".easel-extract-*"))


@pytest.mark.parametrize("name", ["../escape.txt", "/absolute.txt", "C:/escape.txt", "..\\escape.txt", "x/NUL.txt", "x/COM1", "x/LPT².txt", "x/name.", "x/name ", "x/a:b", "x/a?b", "x/a\x01b"])
def test_unsafe_archive_paths_are_rejected_and_cleaned(tmp_path, name):
    source, dest = tmp_path / "source.zip", tmp_path / "versions" / VERSION
    archive(source, extra={name: "malicious"})
    with pytest.raises(RuntimeError, match="不安全路径"):
        bt.extract_to(source, dest)
    assert not dest.exists() and not list(dest.parent.glob(".easel-extract-*"))
    assert not (tmp_path / "escape.txt").exists()


@pytest.mark.parametrize("names", [("A/a.txt", "a/b.txt"), ("same.txt", "SAME.txt")])
def test_windows_case_aliases_are_rejected(tmp_path, names):
    source, dest = tmp_path / "source.zip", tmp_path / "dest"
    archive(source, extra={name: "data" for name in names})
    with pytest.raises(RuntimeError, match="重复|大小写"):
        bt.extract_to(source, dest)
    assert not dest.exists()


def test_archive_symlink_is_rejected(tmp_path):
    source, dest = tmp_path / "source.zip", tmp_path / "dest"
    archive(source)
    with zipfile.ZipFile(source, "a") as z:
        member = zipfile.ZipInfo("link")
        member.create_system = 3
        member.external_attr = (stat.S_IFLNK | 0o777) << 16
        z.writestr(member, "../../outside")
    with pytest.raises(RuntimeError, match="符号链接"):
        bt.extract_to(source, dest)
    assert not dest.exists()


def test_extract_failure_never_publishes_partial_tree(tmp_path, monkeypatch):
    source, dest = tmp_path / "source.zip", tmp_path / "dest"
    archive(source)

    def partial(_zip, path):
        (Path(path) / "partial.txt").write_text("partial")
        raise OSError("disk failed")

    monkeypatch.setattr(zipfile.ZipFile, "extractall", partial)
    with pytest.raises(OSError, match="disk failed"):
        bt.extract_to(source, dest)
    assert not dest.exists() and not list(tmp_path.glob(".easel-extract-*"))


def test_extract_preserves_nonempty_destination(tmp_path):
    source, dest = tmp_path / "source.zip", tmp_path / "dest"
    archive(source)
    dest.mkdir()
    (dest / "old.txt").write_text("keep")
    with pytest.raises(RuntimeError, match="已非空"):
        bt.extract_to(source, dest)
    assert (dest / "old.txt").read_text() == "keep"


def test_extract_rejects_wrong_manifest_version(tmp_path):
    source, dest = tmp_path / "source.zip", tmp_path / "dest"
    archive(source, version="0.2.0")
    with pytest.raises(RuntimeError, match="版本不匹配"):
        bt.extract_to(source, dest, VERSION, DIGEST)
    assert not dest.exists()


def test_data_migration_recurses_without_overwrite(tmp_path):
    source = tmp_path / "repo"
    (source / "profiles" / "deep").mkdir(parents=True)
    for name in ("keep.md", "new.md"):
        (source / "profiles" / "deep" / name).write_text("source")
    (source / "assets").mkdir()
    (source / "assets" / "image.png").write_bytes(b"image")
    (source / ".env").write_text("KEY=source\n")
    dd = bt.data_root()
    (dd / "profiles" / "deep").mkdir(parents=True)
    (dd / "profiles" / "deep" / "keep.md").write_text("existing")
    (dd / ".env").write_text("KEY=existing\n")
    assert bt.init_data_dir(source) == dd
    assert (dd / "profiles" / "deep" / "keep.md").read_text() == "existing"
    assert (dd / "profiles" / "deep" / "new.md").read_text() == "source"
    assert (dd / "assets" / "image.png").read_bytes() == b"image"
    assert (dd / ".env").read_text() == "KEY=existing\n"
    assert bt.init_data_dir(dd) == dd


@pytest.mark.parametrize("allowed", [True, False])
def test_setup_noninteractive_and_winget_explicit(tmp_path, monkeypatch, allowed):
    monkeypatch.setenv("EASEL_INSTALL_ALLOW_WINGET", "1")
    captured = {}

    def fake(cmd, cwd=None, env=None):
        captured.update(cmd=cmd, cwd=cwd, env=env)
        return SimpleNamespace(returncode=7)

    monkeypatch.setattr(bt.subprocess, "run", fake)
    assert bt.run_setup(tmp_path, tmp_path / "data", allowed) == 7
    assert captured["env"]["EASEL_DATA_DIR"] == str(tmp_path / "data")
    assert captured["env"]["EASEL_INSTALL_ALLOW_WINGET"] == ("1" if allowed else "0")
    assert "-NonInteractive" in captured["cmd"] and "-DataDir" in captured["cmd"]
    assert ("-AllowWinget" in captured["cmd"]) is allowed


def verified_root():
    root = bt.install_root(VERSION)
    root.mkdir(parents=True)
    (root / "setup.ps1").write_text("# never executed")
    (root / bt.MARKER).write_text(json.dumps({"version": VERSION, "sha256": DIGEST}))
    return root


@pytest.mark.skipif(os.name != "nt", reason="Windows installer entry")
@pytest.mark.parametrize("returncode", [0, 9])
def test_verified_resume_only_activates_after_success(tmp_path, monkeypatch, returncode):
    root = verified_root()
    launcher = bt.USER_DIR / "Easel.ps1"
    launcher.write_bytes(b"old launcher")
    phases = []
    monkeypatch.setattr(bt, "link_data_dirs", lambda r, d: phases.append((r, d)))
    monkeypatch.setattr(bt, "run_setup", lambda *_a: returncode)
    assert bt.install(VERSION, False, sha256=DIGEST) == returncode
    assert phases == [(root, bt.data_root())]
    if returncode:
        assert launcher.read_bytes() == b"old launcher"
        assert not (bt.USER_DIR / "Easel.previous.ps1").exists()
    else:
        assert (bt.USER_DIR / "Easel.previous.ps1").read_bytes() == b"old launcher"
        text = launcher.read_text(encoding="utf-8-sig")
        assert str(root) in text
        assert "EASEL_DATA_DIR" in text
        assert "$env:EASEL_HOST = '127.0.0.1'" in text
        # npm prefix and pinned Node dir are prepended only when they exist.
        assert str(root / ".tools" / "npm") not in text
        node_marker = root / ".tools" / "node-dir.txt"
        node_marker.parent.mkdir(parents=True, exist_ok=True)
        node_dir = tmp_path / "compat node"
        node_dir.mkdir()
        node_marker.write_text(str(node_dir), encoding="utf-8")
        bt.activate(root, bt.data_root())
        text = launcher.read_text(encoding="utf-8-sig")
        assert f"$env:Path = '{_ps(node_dir)}' + ';' + $env:Path" in text
        (root / ".tools" / "npm").mkdir(parents=True)
        bt.activate(root, bt.data_root())
        text = launcher.read_text(encoding="utf-8-sig")
        assert (f"$env:Path = '{_ps(root / '.tools' / 'npm')}' + ';' + "
                f"'{_ps(node_dir)}' + ';' + $env:Path") in text


@pytest.mark.skipif(os.name != "nt", reason="Windows installer entry")
def test_unverified_existing_tree_is_not_executed(monkeypatch):
    root = bt.install_root(VERSION)
    root.mkdir(parents=True)
    (root / "setup.ps1").write_text("# unverified")
    monkeypatch.setattr(bt, "run_setup", lambda *_a: pytest.fail("unverified execution"))
    with pytest.raises(RuntimeError, match="校验记录"):
        bt.install(VERSION, False, sha256=DIGEST)


@pytest.mark.skipif(os.name != "nt", reason="Windows installer entry")
def test_resume_rejects_mismatched_pinned_digest(monkeypatch):
    verified_root()
    monkeypatch.setattr(bt, "run_setup", lambda *_a: pytest.fail("mismatched execution"))
    with pytest.raises(RuntimeError, match="不一致"):
        bt.install(VERSION, False, sha256="b" * 64)


@pytest.mark.skipif(os.name != "nt", reason="Windows installer entry")
def test_fresh_install_verifies_and_preserves_previous_version(tmp_path, monkeypatch):
    source = tmp_path / "source.zip"
    digest = archive(source, "Easel-source")
    calls = serve(monkeypatch, source.read_bytes())
    old = bt.install_root("0.2.0")
    old.mkdir(parents=True)
    (old / "old.txt").write_text("keep")
    monkeypatch.setattr(bt, "link_data_dirs", lambda *_a: None)
    monkeypatch.setattr(bt, "run_setup", lambda *_a: 0)
    assert bt.install(VERSION, False, URL, digest) == 0
    assert calls == [URL] and (old / "old.txt").read_text() == "keep"
    assert (bt.install_root(VERSION) / "setup.ps1").is_file()
    assert (bt.USER_DIR / "Easel.ps1").is_file()


@pytest.mark.skipif(os.name != "nt", reason="Windows installer entry")
def test_custom_url_requires_explicit_digest():
    with pytest.raises(RuntimeError, match="显式提供"):
        bt.install(VERSION, False, URL)


def test_release_requires_matching_tag_and_unique_named_asset(monkeypatch):
    asset = {"name": "Easel-0.2.1-windows.zip", "browser_download_url": URL, "size": 100}
    serve(monkeypatch, json.dumps({"tag_name": "v0.2.1", "assets": [asset]}).encode())
    result = bt.fetch_release(VERSION)
    assert bt.pick_archive(result["assets"], VERSION)["url"] == URL
    with pytest.raises(RuntimeError, match="唯一"):
        bt.pick_archive(result["assets"] * 2, VERSION)
    with pytest.raises(RuntimeError, match="唯一"):
        bt.pick_archive([{"name": "random.zip"}], VERSION)


@pytest.mark.parametrize("metadata", [{"tag_name": "v0.2.0"}, {"tag_name": "v0.2.1", "draft": True}, {"tag_name": "v0.2.1", "assets": []}])
def test_invalid_release_metadata_is_rejected(monkeypatch, metadata):
    serve(monkeypatch, json.dumps(metadata).encode())
    with pytest.raises(RuntimeError):
        bt.fetch_release(VERSION)


def test_embedded_release_cannot_be_overridden(monkeypatch):
    monkeypatch.setattr(bt, "embedded_release", lambda: {"version": VERSION, "url": URL, "sha256": DIGEST})
    monkeypatch.setattr(bt, "install", lambda *_a: pytest.fail("overridden embedded release"))
    assert bt.main(["--version", "0.3.0", "--yes"]) == 1


def test_embedded_release_uses_pinned_values(monkeypatch):
    monkeypatch.setattr(bt, "embedded_release", lambda: {"version": VERSION, "url": URL, "sha256": DIGEST})
    captured = []
    monkeypatch.setattr(bt, "install", lambda *a: captured.append(a) or 0)
    assert bt.main(["--yes"]) == 0
    assert captured == [(VERSION, False, URL, DIGEST, None)]


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions")
def test_real_junctions_link_data_and_reentry_is_idempotent(tmp_path):
    root, dd = tmp_path / "version with quote's", tmp_path / "persistent data"
    root.mkdir()
    for name in ("profiles", "outputs", "assets"):
        (dd / name).mkdir(parents=True)
        (root / name).mkdir()
        (root / name / "seed.txt").write_text(name)
    bt.link_data_dirs(root, dd)
    bt.link_data_dirs(root, dd)
    for name in ("profiles", "outputs", "assets"):
        assert (root / name).resolve() == (dd / name).resolve()
        assert (root / ".bundled-data-seed" / name / "seed.txt").read_text() == name
    (root / "outputs" / "result.txt").write_text("shared")
    assert (dd / "outputs" / "result.txt").read_text() == "shared"


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions")
def test_migration_skips_source_junction(tmp_path):
    root, outside = tmp_path / "root", tmp_path / "outside"
    root.mkdir()
    for name in ("profiles", "outputs", "assets"):
        (outside / name).mkdir(parents=True)
    (outside / "outputs" / "secret.txt").write_text("do not copy")
    bt.link_data_dirs(root, outside)
    migrated = bt.init_data_dir(root)
    assert not (migrated / "outputs" / "secret.txt").exists()


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions")
def test_migration_rejects_destination_junction(tmp_path):
    source, dd, outside = tmp_path / "source", bt.data_root(), tmp_path / "outside"
    (source / "outputs").mkdir(parents=True)
    (source / "outputs" / "new.txt").write_text("do not write outside data")
    dd.mkdir(parents=True)
    for name in ("profiles", "outputs", "assets"):
        (outside / name).mkdir(parents=True)
    bt.link_data_dirs(dd, outside)
    with pytest.raises(RuntimeError, match="链接|link|junction"):
        bt.init_data_dir(source)
    assert not (outside / "outputs" / "new.txt").exists()


def test_interrupted_copy_never_leaves_a_file_that_resume_would_skip(tmp_path, monkeypatch):
    source, target = tmp_path / "source.txt", tmp_path / "target.txt"
    source.write_bytes(b"complete source")
    real_copy = bt.shutil.copyfileobj

    def interrupted(_source, destination):
        destination.write(b"partial")
        raise OSError("interrupted disk write")

    monkeypatch.setattr(bt.shutil, "copyfileobj", interrupted)
    with pytest.raises(OSError, match="interrupted"):
        bt.copy_missing(source, target)
    assert not target.exists()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["source.txt"]
    monkeypatch.setattr(bt.shutil, "copyfileobj", real_copy)
    bt.copy_missing(source, target)
    assert target.read_bytes() == b"complete source"


def test_copy_never_overwrites_concurrently_created_destination(tmp_path, monkeypatch):
    source, target = tmp_path / "source.txt", tmp_path / "target.txt"
    source.write_bytes(b"source")
    real_copy = bt.shutil.copyfileobj

    def racing(reader, writer):
        real_copy(reader, writer)
        target.write_bytes(b"newly created user data")

    monkeypatch.setattr(bt.shutil, "copyfileobj", racing)
    bt.copy_missing(source, target)
    assert target.read_bytes() == b"newly created user data"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["source.txt", "target.txt"]


@pytest.mark.parametrize("field,value", [("version", None), ("version", 123), ("sha256", None), ("sha256", []), ("url", 123), ("url", [])])
def test_malformed_embedded_fields_stop_with_readable_failure(tmp_path, monkeypatch, field, value):
    metadata = {"version": VERSION, "url": URL, "sha256": DIGEST}
    metadata[field] = value
    (tmp_path / "release.json").write_text(json.dumps(metadata))
    monkeypatch.setattr(bt.sys, "_MEIPASS", str(tmp_path), raising=False)
    monkeypatch.setattr(bt.sys, "frozen", True, raising=False)
    monkeypatch.setattr(bt, "install", lambda *_a: pytest.fail("malformed embedded data executed"))
    assert bt.main(["--yes"]) == 1


def test_frozen_binary_requires_embedded_manifest(tmp_path, monkeypatch):
    monkeypatch.setattr(bt.sys, "_MEIPASS", str(tmp_path), raising=False)
    monkeypatch.setattr(bt.sys, "frozen", True, raising=False)
    with pytest.raises(RuntimeError, match="内嵌"):
        bt.embedded_release()


@pytest.mark.skipif(os.name != "nt", reason="Windows installer entry")
@pytest.mark.parametrize("marker", [[], None, {"version": VERSION, "sha256": 123}, {"version": VERSION, "sha256": "bad"}])
def test_malformed_resume_marker_never_executes(monkeypatch, marker):
    root = verified_root()
    (root / bt.MARKER).write_text(json.dumps(marker))
    monkeypatch.setattr(bt, "embedded_release", lambda: {})
    monkeypatch.setattr(bt, "run_setup", lambda *_a: pytest.fail("malformed resume execution"))
    assert bt.main(["--version", VERSION, "--yes"]) == 1


@pytest.mark.parametrize("required", ["setup.ps1", "easel/install_runner.py", "web/frontend/dist/index.html", "requirements-windows.lock"])
def test_release_missing_required_component_never_publishes(tmp_path, required):
    source, dest = tmp_path / "source.zip", tmp_path / "dest"
    digest = archive(source, omit=(required,))
    with pytest.raises(RuntimeError, match="缺少"):
        bt.extract_to(source, dest, VERSION, digest)
    assert not dest.exists()


@pytest.mark.parametrize("manifest", [[], None, "bad"])
def test_non_object_archive_manifest_never_publishes(tmp_path, manifest):
    source, dest = tmp_path / "source.zip", tmp_path / "dest"
    digest = archive(source, extra={"release-manifest.json": json.dumps(manifest)})
    with pytest.raises(RuntimeError, match="清单"):
        bt.extract_to(source, dest, VERSION, digest)
    assert not dest.exists()


def test_tls_certificate_failure_is_permanent(tmp_path, monkeypatch):
    calls = []

    def fail(req, timeout=None):
        calls.append(req.full_url)
        raise urllib.error.URLError(ssl.SSLCertVerificationError("bad certificate"))

    monkeypatch.setattr(bt.urllib.request, "urlopen", fail)
    with pytest.raises(RuntimeError, match="1 次"):
        bt.download_with_retry(URL, tmp_path / "download.zip", DIGEST)
    assert len(calls) == 1


def test_copy_publish_failure_cleans_temp_and_preserves_source(tmp_path, monkeypatch):
    source, target = tmp_path / "source.txt", tmp_path / "target.txt"
    source.write_bytes(b"complete source")

    def unsupported(*_a, **_k):
        raise OSError("hardlinks unsupported")

    monkeypatch.setattr(bt.os, "link", unsupported)
    with pytest.raises(OSError, match="hardlinks unsupported"):
        bt.copy_missing(source, target)
    assert not target.exists()
    assert source.read_bytes() == b"complete source"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["source.txt"]


def test_bootstrap_lock_refuses_concurrent_install_and_releases_after_error():
    with bt.bootstrap_lock():
        with pytest.raises(RuntimeError, match="另一个"):
            with bt.bootstrap_lock():
                pytest.fail("Concurrent installer acquired the lock")
    with pytest.raises(ValueError, match="interrupted"):
        with bt.bootstrap_lock():
            raise ValueError("interrupted")
    with bt.bootstrap_lock():
        assert (bt.USER_DIR / "bootstrap.lock").is_file()
