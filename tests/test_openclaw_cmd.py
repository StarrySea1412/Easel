"""Keep portable CLI calls inside their explicitly selected runtime."""
import pytest

from easel import openclaw_cmd


@pytest.fixture(autouse=True)
def isolated_resolution(monkeypatch):
    monkeypatch.delenv("EASEL_NODE_EXECUTABLE", raising=False)
    monkeypatch.delenv("EASEL_OPENCLAW_ENTRY", raising=False)
    openclaw_cmd.openclaw_base_cmd.cache_clear()
    yield
    openclaw_cmd.openclaw_base_cmd.cache_clear()


def test_explicit_bundle_wins_without_inspecting_global_installation(tmp_path, monkeypatch):
    folder = tmp_path / "便携 目录 & 工作台"
    folder.mkdir()
    node, entry = folder / "node.exe", folder / "openclaw.mjs"
    node.touch()
    entry.touch()
    monkeypatch.setenv("EASEL_NODE_EXECUTABLE", str(node))
    monkeypatch.setenv("EASEL_OPENCLAW_ENTRY", str(entry))
    monkeypatch.setattr(openclaw_cmd.shutil, "which", lambda *_: pytest.fail("global discovery is not allowed"))
    assert openclaw_cmd.openclaw_base_cmd() == [str(node.resolve()), str(entry.resolve())]


@pytest.mark.parametrize("missing", ["node", "entry", "node-file", "entry-file"])
def test_incomplete_bundle_never_falls_back_to_a_global_cli(tmp_path, monkeypatch, missing):
    node, entry = tmp_path / "node.exe", tmp_path / "openclaw.mjs"
    node.touch()
    entry.touch()
    if missing != "node":
        monkeypatch.setenv("EASEL_NODE_EXECUTABLE", str(node))
    if missing != "entry":
        monkeypatch.setenv("EASEL_OPENCLAW_ENTRY", str(entry))
    if missing == "node-file":
        node.unlink()
    if missing == "entry-file":
        entry.unlink()
    monkeypatch.setattr(openclaw_cmd.shutil, "which", lambda *_: pytest.fail("must not substitute a global CLI"))
    with pytest.raises(FileNotFoundError, match="explicitly selected"):
        openclaw_cmd.openclaw_base_cmd()


def test_relative_explicit_paths_are_rejected_before_global_discovery(monkeypatch):
    monkeypatch.setenv("EASEL_NODE_EXECUTABLE", "node.exe")
    monkeypatch.setenv("EASEL_OPENCLAW_ENTRY", "openclaw.mjs")
    monkeypatch.setattr(openclaw_cmd.shutil, "which", lambda *_: pytest.fail("global discovery is not allowed"))
    with pytest.raises(FileNotFoundError, match="explicitly selected"):
        openclaw_cmd.openclaw_base_cmd()


def test_existing_source_installation_still_resolves_without_portable_overrides(tmp_path, monkeypatch):
    node = tmp_path / "node.exe"
    entry = tmp_path / "node_modules/openclaw/openclaw.mjs"
    node.touch()
    entry.parent.mkdir(parents=True)
    entry.touch()
    monkeypatch.setattr(openclaw_cmd.shutil, "which", lambda name: str(node) if name == "node" else None)
    assert openclaw_cmd.openclaw_base_cmd() == [str(node), str(entry)]
