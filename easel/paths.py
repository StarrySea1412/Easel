"""Runtime paths shared by source checkouts and installed releases.

Code stays in the version directory. Mutable data can live outside it so a
release upgrade does not replace profiles, outputs, or configuration.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def data_root(project_root: Path | None = None) -> Path:
    """Return the configured data directory, preserving source-run defaults."""
    configured = os.environ.get("EASEL_DATA_DIR", "").strip()
    return Path(configured).expanduser().resolve() if configured else (
        project_root if project_root is not None else Path(__file__).resolve().parents[1]
    )


def child_env(project_root: Path) -> dict[str, str]:
    """Pass code/data locations to CLI, gateway, and skill child processes."""
    env = os.environ.copy()
    env.setdefault("EASEL_ROOT", str(project_root))
    env["EASEL_DATA_DIR"] = str(data_root(project_root))
    configured_python = env.get("EASEL_PYTHON", "")
    if not configured_python or not Path(configured_python).is_file():
        env["EASEL_PYTHON"] = sys.executable
    state = env.get("EASEL_OPENCLAW_STATE_DIR")
    if state:
        env["OPENCLAW_STATE_DIR"] = str(Path(state).expanduser().resolve())
    return env
