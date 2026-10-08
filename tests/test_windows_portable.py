"""Portable previews must be relocatable, private-data-free and build-bound."""
import json
import io
import os
from pathlib import Path
import subprocess
import sys
import zipfile

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_windows_portable as portable


def put(root: Path, name: str, contents: str = "public fixture") -> Path:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")
    return path


@pytest.mark.parametrize("name", [
    "../outside", "/absolute", "C:/private.txt", "C:\\private.txt", "a/../b", "a//b",
    "CON.txt", "a/nul", "a/space ", "a/trailing.", "a:stream", "a\nfile",
    ".env", "skills/one/.env.local", "skills/one/cookies.json", "data/profile.md",
    ".venv/Scripts/python.exe", "profiles/person/profile.md", "assets/private.png",
    "skills/one/auth-profiles.json", "skills/one/credentials.json", "skills/one/.npmrc",
    "web/frontend/dist/old.js",
])
def test_source_allowlist_rejects_private_data_and_extraction_tricks(name):
    assert not portable.allowed_source(name)


@pytest.mark.parametrize("name", ["LICENSE", ".env.example", "profiles/_template/README.md",
    "scripts/portable_launcher.py", "web/app.py", "skills/openclaw/one/SKILL.md"])
def test_public_application_source_and_templates_are_allowed(name):
    assert portable.allowed_source(name)


@pytest.mark.parametrize("name", ["pyvenv.cfg", "__editable__.easel-0.2.6.pth", ".env",
    "nested/cookies.json", "nested/.npmrc", "nested/auth-profiles.json"])
def test_runtime_rejects_machine_paths_or_credentials_without_reading_them(tmp_path, name):
    put(tmp_path, name)
    with pytest.raises(ValueError, match="Private or machine-specific"):
        portable.public_files(tmp_path)


def test_runtime_rejects_symlinked_directory(tmp_path):
    source = tmp_path / "prepared"
    outside = tmp_path / "outside"
    source.mkdir()
    outside.mkdir()
    put(outside, "private.txt")
    try:
        (source / "linked").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("Host does not permit creating symlinks")
    with pytest.raises(ValueError, match="Linked runtime"):
        portable.public_files(source)


@pytest.fixture
def prepared(tmp_path):
    roots = {name: tmp_path / "public" / name for name in portable.COMPONENTS}
    for root in roots.values():
        put(root, "LICENSE.txt", "Public component fixture license")
    for name in ("python.exe", "pythonw.exe", "python312.dll", "python312.zip"):
        put(roots["python"], name)
    put(roots["python"], "python312._pth", "python312.zip\n.\nsite-packages\n../../app\nimport site\n")
    put(roots["python"], "site-packages/00-easel-portable-runtime.pth", "import sys; sys.dont_write_bytecode = True\n")
    browsers = [{"name": name, "revision": revision} for name, revision in (
        ("chromium", "1234"), ("chromium-headless-shell", "1234"), ("ffmpeg", "1011"), ("winldd", "1007"))]
    put(roots["python"], "site-packages/playwright/driver/package/browsers.json", json.dumps({"browsers": browsers}))
    put(roots["node"], "node.exe")
    put(roots["openclaw"], "node_modules/openclaw/openclaw.mjs")
    put(roots["openclaw"], "node_modules/openclaw/package.json", '{"version":"2026.9.2"}')
    put(roots["ffmpeg"], "bin/ffmpeg.exe")
    put(roots["ffmpeg"], "bin/ffprobe.exe")
    for name in ("chromium-1234/chrome-win64/chrome.exe",
                 "chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe",
                 "ffmpeg-1011/ffmpeg-win64.exe", "winldd-1007/PrintDeps.exe"):
        put(roots["browsers"], name)
    # .links points back to the build machine and must not be copied.
    put(roots["browsers"], ".links/build-machine", "C:/private/environment")
    put(roots["browsers"], "chromium-9999/old.exe", "Unused revision")
    versions = {"python": "3.12.10", "node": "24.19.0", "openclaw": "2026.9.2",
                "ffmpeg": "9.0.1", "browsers": "playwright-1.62.0"}
    contents = {"schemaVersion": 1, "components": {name: {
        "path": str(path), "version": versions[name], "source": "https://example.test/public/" + name,
        "licenses": ["LICENSE.txt"]} for name, path in roots.items()}}
    manifest = put(tmp_path, "components.json", json.dumps(contents))
    return roots, manifest, contents


def test_components_require_explicit_public_roots_licenses_and_versions(prepared):
    roots, manifest, _ = prepared
    components = portable.load_components(manifest)
    files = portable.component_files(components)
    assert components["python"].path == roots["python"]
    assert "chromium-1234/chrome-win64/chrome.exe" in files["browsers"]
    assert not any(".links" in name or "9999" in name for name in files["browsers"])


def test_playwright_manifest_is_read_from_the_only_enabled_python_site_directory(prepared):
    roots, manifest, _ = prepared
    python = roots["python"]
    old_manifest = python / "site-packages/playwright/driver/package/browsers.json"
    put(python, "Lib/site-packages/playwright/driver/package/browsers.json", old_manifest.read_text(encoding="utf-8"))
    put(python, "Lib/site-packages/00-easel-portable-runtime.pth", "import sys; sys.dont_write_bytecode = True\n")
    old_manifest.write_text('{"browsers":[]}', encoding="utf-8")
    pth = python / "python312._pth"
    pth.write_text(pth.read_text(encoding="utf-8").replace("site-packages", "Lib/site-packages"), encoding="utf-8")
    components = portable.load_components(manifest)
    assert portable.component_files(components)["browsers"]
    pth.write_text(pth.read_text(encoding="utf-8") + "site-packages\n", encoding="utf-8")
    with pytest.raises(ValueError, match="exactly one"):
        portable.component_files(components)


def test_embedded_child_interpreters_must_inherit_the_no_bytecode_write_policy(prepared):
    roots, manifest, _ = prepared
    hook = roots["python"] / "site-packages/00-easel-portable-runtime.pth"
    hook.write_text("import sys; sys.dont_write_bytecode = False\n", encoding="utf-8")
    with pytest.raises(ValueError, match="disable bytecode writes"):
        portable.component_files(portable.load_components(manifest))
    hook.unlink()
    with pytest.raises(ValueError, match="bytecode policy"):
        portable.component_files(portable.load_components(manifest))


@pytest.mark.parametrize("change,error", [
    (lambda data: data["components"].pop("python"), "requires exactly"),
    (lambda data: data["components"]["python"].update(path=".venv"), "virtual environment"),
    (lambda data: data["components"]["node"].update(licenses=[]), "license files"),
    (lambda data: data["components"]["node"].update(licenses=["../LICENSE"]), "relative path"),
    (lambda data: data["components"]["node"].update(source="https://user:secret@example.test/runtime"), "public HTTPS"),
    (lambda data: data["components"]["node"].update(source="https://example.test/runtime?token=secret"), "public HTTPS"),
    (lambda data: data["components"]["node"].update(treeSha256="wrong"), "checksum"),
])
def test_bad_component_manifest_is_rejected(prepared, change, error):
    _, manifest, contents = prepared
    change(contents)
    manifest.write_text(json.dumps(contents), encoding="utf-8")
    with pytest.raises(ValueError, match=error):
        portable.load_components(manifest)


@pytest.mark.parametrize("extra,error", [
    ("C:/old/build/site-packages", "bundle-relative"),
    ("../../../outside", "escapes"),
    ("import evil", "bundle-relative"),
])
def test_embedded_python_never_retains_machine_or_escaping_search_paths(prepared, extra, error):
    roots, manifest, _ = prepared
    path = roots["python"] / "python312._pth"
    path.write_text(path.read_text(encoding="utf-8") + extra + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match=error):
        portable.component_files(portable.load_components(manifest))


def test_venv_console_launchers_are_not_mislabelled_as_portable(prepared):
    roots, manifest, _ = prepared
    put(roots["python"], "Scripts/biliup.exe", "points back to old interpreter")
    with pytest.raises(ValueError, match="console launchers"):
        portable.component_files(portable.load_components(manifest))


def test_fresh_relative_console_launcher_can_move_with_its_bundled_python(prepared):
    roots, manifest, _ = prepared
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr("__main__.py", "from public_module import main\nmain()\n")
    executable = roots["python"] / "Scripts/biliup.exe"
    executable.parent.mkdir()
    executable.write_bytes(b'MZ public distlib stub\n#!"<launcher_dir>\\..\\python.exe" -I -B\r\n' + payload.getvalue())
    put(roots["python"], "Scripts/biliup.cmd", '@echo off\n"%~dp0..\\python.exe" -I -B -m public_module %*\n')
    files = portable.component_files(portable.load_components(manifest))
    assert "Scripts/biliup.exe" in files["python"]


def test_missing_exact_playwright_revision_cannot_be_replaced_with_an_old_browser(prepared):
    roots, manifest, _ = prepared
    (roots["browsers"] / "chromium-1234/chrome-win64/chrome.exe").unlink()
    with pytest.raises(ValueError, match="Incomplete pinned browser"):
        portable.component_files(portable.load_components(manifest))


@pytest.fixture
def checkout(tmp_path, monkeypatch):
    root = tmp_path / "checkout"
    names = {
        "pyproject.toml": '[project]\nversion="0.2.6"\n',
        "scripts/portable_launcher.py": "# launcher", "scripts/portable_entry.cs": "// fixture",
        "web/app.py": "# app", "LICENSE": "Apache License", ".env.example": "MODEL_KEY=\n",
        ".env": "LOCAL_SECRET=must not ship", "data/cookies.json": "personal login",
        "profiles/person/private.md": "private", "web/frontend/package-lock.json": "{}",
        "web/frontend/package.json": "{}", "web/frontend/src/App.tsx": "export default {}",
        "web/frontend/tests/app.test.mjs": "// frontend test",
    }
    for name, content in names.items():
        put(root, name, content)
    put(root, "web/frontend/dist/index.html", "<html>fresh acceptance output</html>")
    put(root, "web/frontend/node_modules/react/LICENSE", "MIT frontend fixture")

    def git_output(command, **_kwargs):
        if command[1] == "rev-parse":
            return b"a" * 40
        if command[1] == "diff":
            return b""
        selected = [name for name in names if "--" not in command or name.startswith("web/frontend/")]
        return ("\0".join(selected) + "\0").encode("utf-8")

    monkeypatch.setattr(portable.subprocess, "check_output", git_output)
    monkeypatch.setattr(portable, "compile_launcher", lambda _root, dest: dest.write_bytes(b"MZ GUI fixture"))
    receipt = {"schemaVersion": 1, "kind": "easel-frontend-build-receipt",
        "sourceSha256": portable.frontend_source_hash(root), "files": portable.frontend_output(root),
        "checks": ["npm ci", "node --test --test-concurrency=2", "npm run lint", "npm run build"]}
    return root, receipt


def test_archive_has_relative_layout_runtime_provenance_licenses_and_no_developer_state(tmp_path, prepared, checkout):
    _, component_manifest, _ = prepared
    root, frontend = checkout
    components = portable.load_components(component_manifest)
    inputs = portable.component_files(components)
    bundle = tmp_path / "bundle"
    manifest = portable.assemble(root, bundle, components, inputs, frontend)
    assert portable.verify_bundle(bundle) == manifest
    assert manifest["runtime"] == portable.RUNTIME
    assert manifest["sourceCommit"] == "a" * 40
    assert manifest["sourceDirty"] is False
    assert str(tmp_path) not in json.dumps(manifest)
    assert manifest["components"]["python"]["treeSha256"]
    assert "Public component fixture license" in (bundle / "THIRD_PARTY_LICENSES.txt").read_text(encoding="utf-8")
    archive = portable.write_archive(bundle, tmp_path, manifest)
    assert archive.name.startswith("Easel-preview-aaaaaaa-")
    assert len(archive.stem) <= 26  # Explorer's default extraction folder.
    assert archive.with_suffix(".zip.sha256").read_text().startswith(portable.sha256_of(archive))
    with zipfile.ZipFile(archive) as zipped:
        names = set(zipped.namelist())
        assert {"Easel.exe", "portable-manifest.json", "开始使用.txt", "启动 Easel.cmd", "停止 Easel.cmd", "data/"} <= names
        assert "app/.env.example" in names
        assert not any(name.endswith("cookies.json") or name.endswith(".env") or "/.links/" in name for name in names)
        assert "app/profiles/person/private.md" not in names
        assert "MIT frontend fixture" in zipped.read("app/THIRD_PARTY_FRONTEND_LICENSES.txt").decode()
    with pytest.raises(FileExistsError, match="already exists"):
        portable.write_archive(bundle, tmp_path, manifest)


def test_component_tree_checksum_is_checked_before_a_candidate_is_published(tmp_path, prepared, checkout):
    _, component_manifest, contents = prepared
    contents["components"]["node"]["treeSha256"] = "0" * 64
    component_manifest.write_text(json.dumps(contents), encoding="utf-8")
    components = portable.load_components(component_manifest)
    root, frontend = checkout
    with pytest.raises(ValueError, match="component checksum mismatch"):
        portable.assemble(root, tmp_path / "bundle", components, portable.component_files(components), frontend)
    assert not list(tmp_path.glob("*.zip"))


def test_repackaging_a_used_copy_never_reads_or_archives_its_personal_data(tmp_path, prepared, checkout, monkeypatch):
    _, component_manifest, _ = prepared
    root, frontend = checkout
    components = portable.load_components(component_manifest)
    bundle = tmp_path / "bundle"
    manifest = portable.assemble(root, bundle, components, portable.component_files(components), frontend)
    for name in ("data/.env", "data/openclaw/auth-profiles.json", "data/private-photo.jpg", "data/cookies.json"):
        put(bundle, name, "PERSONAL_CONTENT_MUST_NOT_BE_READ_OR_SHIPPED")
    original_walk = portable.os.walk
    def guarded_walk(*args, **kwargs):
        for folder, directories, files in original_walk(*args, **kwargs):
            assert not Path(folder).is_relative_to(bundle / "data"), "personal data directory was traversed"
            yield folder, directories, files
    monkeypatch.setattr(portable.os, "walk", guarded_walk)
    archive = portable.write_archive(bundle, tmp_path, manifest)
    with zipfile.ZipFile(archive) as zipped:
        assert [name for name in zipped.namelist() if name.lower().startswith("data/")] == ["data/"]
        assert zipped.read("data/") == b""
        assert not any("PERSONAL_CONTENT".encode() in zipped.read(name) for name in zipped.namelist())


def test_checksum_inventory_cannot_request_hashing_personal_data(tmp_path, prepared, checkout):
    _, component_manifest, _ = prepared
    root, frontend = checkout
    components = portable.load_components(component_manifest)
    bundle = tmp_path / "bundle"
    portable.assemble(root, bundle, components, portable.component_files(components), frontend)
    (bundle / "checksums.sha256").write_text("0" * 64 + "  data/private.json\n", encoding="utf-8")
    with pytest.raises(ValueError, match="Personal data"):
        portable.verify_bundle(bundle)


@pytest.mark.parametrize("tamper", ["runtime", "extra", "traversal"])
def test_extracted_bundle_verification_detects_tampering(tmp_path, prepared, checkout, tamper):
    _, component_manifest, _ = prepared
    root, frontend = checkout
    components = portable.load_components(component_manifest)
    bundle = tmp_path / "bundle"
    portable.assemble(root, bundle, components, portable.component_files(components), frontend)
    if tamper == "runtime":
        (bundle / "runtime/node/node.exe").write_bytes(b"changed")
    elif tamper == "extra":
        put(bundle, "app/unlisted.py", "unexpected code")
    else:
        (bundle / "checksums.sha256").write_text("0" * 64 + "  ../outside\n", encoding="utf-8")
    with pytest.raises(ValueError):
        portable.verify_bundle(bundle)


@pytest.mark.parametrize("changed", ["source", "dist", "checks"])
def test_stale_frontend_receipt_is_never_a_skip_build_switch(tmp_path, checkout, changed):
    root, record = checkout
    receipt = put(tmp_path, "frontend-receipt.json", json.dumps(record))
    assert portable.verify_frontend_receipt(root, receipt) == record
    if changed == "source":
        put(root, "web/frontend/src/App.tsx", "new source")
    elif changed == "dist":
        put(root, "web/frontend/dist/index.html", "stale output")
    else:
        record["checks"] = []
        receipt.write_text(json.dumps(record), encoding="utf-8")
    with pytest.raises(ValueError, match="receipt"):
        portable.verify_frontend_receipt(root, receipt)


def test_frontend_preparation_runs_required_checks_with_bounded_parallelism(tmp_path, checkout, monkeypatch):
    root, _ = checkout
    calls = []
    monkeypatch.setattr(portable.shutil, "which", lambda executable, **_kwargs: executable)
    def run(command, **kwargs):
        assert kwargs["check"] and kwargs["cwd"] == root / "web/frontend"
        calls.append(command)
    monkeypatch.setattr(portable.subprocess, "run", run)
    receipt = tmp_path / "frontend.json"
    portable.prepare_frontend(root, receipt)
    assert calls[0][1:] == ["ci"]
    assert calls[1][1:3] == ["--test", "--test-concurrency=2"]
    assert calls[2][1:] == ["run", "lint"]
    assert calls[3][1:] == ["run", "build"]
    portable.verify_frontend_receipt(root, receipt)


def test_failed_frontend_checks_do_not_create_acceptance_receipt(tmp_path, checkout, monkeypatch):
    root, _ = checkout
    monkeypatch.setattr(portable.shutil, "which", lambda executable, **_kwargs: executable)
    def run(command, **_kwargs):
        raise subprocess.CalledProcessError(1, command)
    monkeypatch.setattr(portable.subprocess, "run", run)
    receipt = tmp_path / "receipt.json"
    with pytest.raises(subprocess.CalledProcessError):
        portable.prepare_frontend(root, receipt)
    assert not receipt.exists()


def test_cmd_fallback_uses_its_own_directory_without_delayed_expansion_or_shell_interpolation():
    for action in ("start", "stop", "status"):
        command = portable.command_file(action)
        assert "DisableDelayedExpansion" in command
        assert '"%~dp0runtime\\python\\python.exe"' in command
        assert '--root "%~dp0."' in command
        assert "call " not in command.lower() and "powershell" not in command.lower()
    with pytest.raises(ValueError):
        portable.command_file("start & echo unsafe")


@pytest.mark.skipif(os.name != "nt", reason="The GUI compiles with Windows' built-in .NET Framework")
def test_native_gui_argument_quoting_roundtrips_unicode_spaces_quotes_and_trailing_slashes(tmp_path):
    """Compile a console probe, not the GUI; exercise the actual C# argument code."""
    probe = put(tmp_path, "probe.cs", r'''
using System;
using System.Text;
using System.Collections.Generic;
using System.Reflection;
using System.Web.Script.Serialization;
using System.Windows.Forms;
internal static class ArgumentProbe {
  public static void Main(string[] args) {
    if(args.Length > 0 && args[0] == "url") {
      Console.WriteLine(PortableArguments.WorkbenchUrl(args[1]) ? "yes" : "no"); return;
    }
    if(args.Length > 0 && args[0] == "can-close") {
      Console.WriteLine(PortableArguments.CanCloseWithoutRuntime(args[1], Boolean.Parse(args[2])) ? "yes" : "no"); return;
    }
    if(args.Length > 0 && args[0] == "close-missing") {
      using(PortableWindow window = new PortableWindow(args[1])) {
        FormClosingEventArgs closing = new FormClosingEventArgs(CloseReason.UserClosing, false);
        typeof(PortableWindow).GetMethod("Closing", BindingFlags.NonPublic | BindingFlags.Instance)
          .Invoke(window, new object[] { window, closing });
        Console.WriteLine(closing.Cancel ? "blocked" : "closed");
      }
      return;
    }
    if(args.Length > 0 && args[0] == "state") {
      Dictionary<string, object> data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(args[1]);
      PortableResult result = PortableResult.FromPayload(data, 0);
      using(PortableWindow window = new PortableWindow(args[2])) {
        typeof(PortableWindow).GetMethod("ApplyResult", BindingFlags.NonPublic | BindingFlags.Instance)
          .Invoke(window, new object[] { "status", result });
        foreach(string name in new string[] { "state", "explanation" }) {
          Label label = (Label)typeof(PortableWindow).GetField(name, BindingFlags.NonPublic | BindingFlags.Instance).GetValue(window);
          Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(label.Text)));
        }
      }
      return;
    }
    foreach(string value in args) Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(PortableArguments.Quote(value))));
  }
}''')
    executable = tmp_path / "probe.exe"
    subprocess.run([str(portable.compiler_path()), "/nologo", "/target:exe", "/main:ArgumentProbe",
        "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "/reference:System.Web.Extensions.dll",
        "/out:" + str(executable), str(ROOT / "scripts/portable_entry.cs"), str(probe)], check=True,
        capture_output=True, text=True)
    values = ["", "simple", "C:\\便携测试\\folder with spaces\\", 'C:\\quotes\\"x"\\', "a&b%PATH%!name!"]
    output = subprocess.check_output([str(executable), *values], text=True).splitlines()
    import base64
    quoted = [base64.b64decode(line).decode("utf-8") for line in output]
    # This roundtrip parses the C# command line with the real Windows argv rules.
    echo_probe = put(tmp_path, "echo.cs", r'''
using System; using System.Text;
class EchoProbe { static void Main(string[] args) {
  foreach(string value in args) Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(value)));
} }''')
    echo_executable = tmp_path / "echo.exe"
    subprocess.run([str(portable.compiler_path()), "/nologo", "/target:exe", "/out:" + str(echo_executable), str(echo_probe)],
        check=True, capture_output=True, text=True)
    raw_command = subprocess.list2cmdline([str(echo_executable)]) + " " + " ".join(quoted)
    echoed = subprocess.check_output(raw_command, text=True).splitlines()
    assert [base64.b64decode(line).decode("utf-8") for line in echoed] == values
    for url, expected in (("http://127.0.0.1:7860/", "yes"), ("https://evil.test/", "no"),
                          ("http://127.0.0.1@evil.test/", "no"), ("file:///C:/Windows/", "no")):
        assert subprocess.check_output([str(executable), "url", url], text=True).strip() == expected
    # Exercise the actual ApplyResult on unshown WinForms controls. No GUI,
    # browser or runtime service is started by this unit-level presentation test.
    for services in ({"gateway": True, "web": False}, {"gateway": False, "web": True}):
        payload = {"ok": True, "running": False, "services": services, "url": "http://127.0.0.1:7860/"}
        result = subprocess.check_output([str(executable), "state", json.dumps(payload), str(tmp_path)], text=True).splitlines()
        title, detail = [base64.b64decode(line).decode("utf-8") for line in result]
        assert title == "部分服务仍在运行"
        assert "先停止服务" in detail and "现在也可以移动" not in detail
    stopped = {"ok": True, "running": False, "services": {"gateway": False, "web": False}}
    result = subprocess.check_output([str(executable), "state", json.dumps(stopped), str(tmp_path)], text=True).splitlines()
    assert base64.b64decode(result[0]).decode("utf-8") == "服务已停止"
    notice = "原端口已被占用，工作台地址已更新；浏览器内保存的偏好可能需要重新设置。"
    ready = {"ok": True, "running": True, "url": "http://127.0.0.1:48100/", "message": notice,
             "portChanged": True, "previousUrl": "http://127.0.0.1:48000/"}
    result = subprocess.check_output([str(executable), "state", json.dumps(ready), str(tmp_path)], text=True).splitlines()
    assert base64.b64decode(result[0]).decode("utf-8") == "工作台已就绪"
    assert base64.b64decode(result[1]).decode("utf-8") == notice
    broken = tmp_path / "incomplete-extraction"
    assert subprocess.check_output([str(executable), "can-close", str(broken), "false"], text=True).strip() == "yes"
    assert subprocess.check_output([str(executable), "close-missing", str(broken)], text=True).strip() == "closed"
    assert subprocess.check_output([str(executable), "can-close", str(broken), "true"], text=True).strip() == "no"
    record = put(broken, "data/portable-processes.json", "invalid record must still protect existing services")
    assert subprocess.check_output([str(executable), "can-close", str(broken), "false"], text=True).strip() == "no"
    record.unlink()
    put(broken, "runtime/python/python.exe")
    put(broken, "app/scripts/portable_launcher.py")
    assert subprocess.check_output([str(executable), "can-close", str(broken), "false"], text=True).strip() == "no"
