"""Upstream sync protections exercised with the actual shell block in isolation."""
import os
import runpy
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_shell_helpers = runpy.run_path(str(ROOT / 'tests/test_setup_auth.py'))
_shell_env = _shell_helpers['_shell_env']
BASH = _shell_helpers['_bash_executable']()
pytestmark = pytest.mark.skipif(not BASH, reason="No usable native Bash")


def workspace_block():
    source = (ROOT / 'openclaw/sync.sh').read_text(encoding='utf-8')
    return source[source.index('for f in "$OPENCLAW_WORKSPACE_SRC"/*.md; do'):
                  source.index('# AGENTS.md is injected every turn')]


def run_block(src, dst):
    return subprocess.run([BASH, '-c', 'set -euo pipefail\n' + workspace_block()],
                          env=_shell_env(OPENCLAW_WORKSPACE_SRC=src.as_posix(),
                                         OPENCLAW_WORKSPACE_DST=dst.as_posix()),
                          capture_output=True, text=True, encoding='utf-8', timeout=20)


def test_workspace_replacement_breaks_hardlink_without_changing_other_link(tmp_path):
    src, dst = tmp_path / 'src', tmp_path / 'dst'
    src.mkdir(); dst.mkdir()
    for name in ('AGENTS.md', 'SOUL.md'):
        (src / name).write_text('new workspace', encoding='utf-8')
        (dst / name).write_text('original bootstrap', encoding='utf-8')
        os.link(dst / name, tmp_path / name)
    result = run_block(src, dst)
    assert result.returncode == 0, result.stderr
    for name in ('AGENTS.md', 'SOUL.md'):
        assert (dst / name).read_text() == 'new workspace'
        assert (dst / name).stat().st_nlink == 1
        assert (tmp_path / name).read_text() == 'original bootstrap'


def test_workspace_sync_fails_when_a_directory_blocks_replacement(tmp_path):
    src, dst = tmp_path / 'src', tmp_path / 'dst'
    src.mkdir(); dst.mkdir()
    (src / 'AGENTS.md').write_text('new workspace')
    (dst / 'AGENTS.md').mkdir()
    marker = dst / 'AGENTS.md/keep.txt'
    marker.write_text('keep')
    result = run_block(src, dst)
    assert result.returncode != 0
    assert marker.read_text() == 'keep'


def test_skill_cleanup_rejects_empty_destination_before_removal():
    source = (ROOT / 'openclaw/sync.sh').read_text(encoding='utf-8')
    guarded = next(line for line in source.splitlines() if '${OPENCLAW_SKILL_DST:?}' in line)
    result = subprocess.run([BASH, '-c', 'set -u\nOPENCLAW_SKILL_DST=""\nname=x\n' + guarded],
                            env=_shell_env(), capture_output=True, text=True,
                            encoding='utf-8', timeout=20)
    assert result.returncode != 0
    assert 'OPENCLAW_SKILL_DST' in result.stderr
