"""Keep Node argv on the OpenClaw package chosen by PATH, without invoking it."""
from pathlib import Path

import pytest

from easel import openclaw_cmd


@pytest.fixture(autouse=True)
def clear_command_cache(monkeypatch):
    monkeypatch.delenv('EASEL_NODE_EXECUTABLE', raising=False)
    monkeypatch.delenv('EASEL_OPENCLAW_ENTRY', raising=False)
    openclaw_cmd.openclaw_base_cmd.cache_clear()
    yield
    openclaw_cmd.openclaw_base_cmd.cache_clear()


@pytest.mark.parametrize('shim_name', ['openclaw.cmd', 'openclaw.ps1'])
def test_separate_npm_prefix_uses_selected_package_instead_of_user_global(tmp_path, monkeypatch, shim_name):
    node = tmp_path / 'node-runtime' / 'node.exe'
    node.parent.mkdir()
    node.write_text('never execute')
    prefix = tmp_path / 'project npm prefix'
    prefix.mkdir()
    shim = prefix / shim_name
    shim.write_text('never execute')
    entry = prefix / 'node_modules' / 'openclaw' / 'openclaw.mjs'
    entry.parent.mkdir(parents=True)
    entry.write_text('selected runtime, never execute')
    fake_home = tmp_path / 'home'
    global_entry = fake_home / 'AppData' / 'Roaming' / 'npm' / 'node_modules' / 'openclaw' / 'openclaw.mjs'
    global_entry.parent.mkdir(parents=True)
    global_entry.write_text('different version, never execute')
    monkeypatch.setattr(Path, 'home', lambda: fake_home)
    monkeypatch.setattr(openclaw_cmd.shutil, 'which',
                        lambda name: str(node if name == 'node' else shim) if name in {'node', 'openclaw'} else None)
    assert openclaw_cmd.openclaw_base_cmd() == [str(node), str(entry.resolve())]


def test_incomplete_selected_prefix_retains_known_global_layout_fallback(tmp_path, monkeypatch):
    node = tmp_path / 'node.exe'
    node.write_text('never execute')
    shim = tmp_path / 'empty-prefix' / 'openclaw.cmd'
    shim.parent.mkdir()
    shim.write_text('never execute')
    fake_home = tmp_path / 'home'
    entry = fake_home / 'AppData' / 'Roaming' / 'npm' / 'node_modules' / 'openclaw' / 'openclaw.mjs'
    entry.parent.mkdir(parents=True)
    entry.write_text('known npm layout, never execute')
    monkeypatch.setattr(Path, 'home', lambda: fake_home)
    monkeypatch.setattr(openclaw_cmd.shutil, 'which',
                        lambda name: str(node if name == 'node' else shim) if name in {'node', 'openclaw'} else None)
    assert openclaw_cmd.openclaw_base_cmd() == [str(node), str(entry)]
