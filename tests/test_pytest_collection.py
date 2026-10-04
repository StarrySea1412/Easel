"""The documented full-suite command must keep collecting cleanly.

Runtime copies of skills under data/openclaw/workspace once aborted
collection with duplicate conftest registrations; the guard runs a fresh
collector so a regression fails here instead of at delivery.
"""
import subprocess
import sys
from pathlib import Path


def test_full_suite_collection_succeeds():
    root = Path(__file__).resolve().parents[1]
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", str(root)],
        cwd=root, capture_output=True, text=True, timeout=300,
    )
    assert proc.returncode == 0, (proc.stdout + proc.stderr)[-2000:]
