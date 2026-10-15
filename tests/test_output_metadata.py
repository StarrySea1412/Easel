"""Real creation timestamps and bounded text covers; no generated media or user files."""
import ctypes
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
import output_metadata as metadata


def test_text_cover_is_bounded_plain_text_and_handles_binary_and_missing(tmp_path):
    source = tmp_path / 'script.py'
    source.write_text('\ufeff\nprint("hello")\n' + 'x' * 10000, encoding='utf-8')
    preview = metadata.text_cover(source)
    assert preview.startswith('print("hello")\n') and len(preview) == 600
    source.write_bytes(b'\x00binary')
    assert metadata.text_cover(source) == ''
    assert metadata.text_cover(tmp_path / 'missing.md') == ''


def test_birthtime_is_not_substituted_with_linux_change_time(monkeypatch):
    monkeypatch.setattr(metadata.sys, 'platform', 'linux')
    monkeypatch.setattr(metadata, '_linux_birthtime', lambda _: None)
    stat = SimpleNamespace(st_ctime=1792000000, st_mtime=1791000000)
    assert metadata.creation_time(Path('missing'), stat) is None
    monkeypatch.setattr(metadata, '_linux_birthtime', lambda _: 1790000000.5)
    assert metadata.creation_time(Path('missing'), stat) == 1790000000.5
    assert ctypes.sizeof(metadata._Statx) == 256 and metadata._Statx.born.offset == 80


@pytest.mark.parametrize('value', [float('nan'), float('inf'), -1, 0, 'yesterday'])
def test_invalid_creation_times_stay_unknown(value):
    assert metadata.creation_time(Path('file'), SimpleNamespace(st_birthtime=value)) is None


def test_directory_and_files_have_real_creation_time_and_preview(tmp_path, monkeypatch):
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path)
    folder = tmp_path / '报告'
    folder.mkdir()
    (folder / 'notes.md').write_text('# 这是正文', encoding='utf-8')
    (folder / 'tool.py').write_text('print("test")', encoding='utf-8')
    (folder / '.hidden.md').write_text('hidden', encoding='utf-8')
    (tmp_path / 'empty').mkdir()
    nodes = web.get_output_tree()
    node = next(node for node in nodes if node['name'] == '报告')
    assert node['fileCount'] == 2
    assert node['createdAt'] == metadata.creation_time(folder, folder.stat())
    for child in node['children']:
        path = folder / child['name']
        assert child['kind'] == 'text'
        assert child['preview'] == path.read_text(encoding='utf-8')
        assert child['createdAt'] == metadata.creation_time(path, path.stat())
    assert next(node for node in nodes if node['name'] == 'empty')['fileCount'] == 0


def test_output_previews_do_not_follow_links_outside_library(tmp_path, monkeypatch):
    root = tmp_path / 'outputs'
    root.mkdir()
    monkeypatch.setattr(web, 'OUTPUTS_DIR', root)
    secret = tmp_path / 'private.txt'
    secret.write_text('must-not-be-exposed', encoding='utf-8')
    try:
        (root / 'outside.txt').symlink_to(secret)
        (root / 'loop').symlink_to(root, target_is_directory=True)
    except OSError:
        pytest.skip('Creating symlinks is unavailable for this Windows user')
    assert web.get_output_tree() == []
    assert 'must-not-be-exposed' not in json.dumps(web.get_output_tree())
