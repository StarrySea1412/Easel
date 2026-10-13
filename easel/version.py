"""Identify the running application without trusting environment or Git HEAD."""
from __future__ import annotations

from importlib import metadata
import json
from pathlib import Path
import re

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 remains supported without another dependency.
    tomllib = None

ROOT = Path(__file__).resolve().parents[1]
_VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?')
_REVISION = re.compile(r'(?:[0-9a-f]{40}|[0-9a-f]{64})')


def _valid_version(value) -> str | None:
    return value if isinstance(value, str) and _VERSION.fullmatch(value) else None


def application_version(root: Path | None = None) -> str:
    """Use the running source's pyproject, or installed package metadata."""
    root = Path(root) if root is not None else ROOT
    try:
        source = (root / 'pyproject.toml').read_text(encoding='utf-8')
        if tomllib is not None:
            version = _valid_version(tomllib.loads(source).get('project', {}).get('version'))
        else:
            # Only read the project section, never an unrelated dependency's version.
            project = re.search(r'^\[project\]\s*$([\s\S]*?)(?=^\[|\Z)', source, re.MULTILINE)
            match = re.search(r'^version\s*=\s*([\"\'])([^\"\'\r\n]+)\1\s*(?:#.*)?$',
                              project.group(1), re.MULTILINE) if project else None
            version = _valid_version(match.group(2)) if match else None
        if version:
            return version
    except (OSError, ValueError, AttributeError):
        pass
    try:
        return _valid_version(metadata.version('easel')) or 'unknown'
    except metadata.PackageNotFoundError:
        return 'unknown'


def runtime_version(root: Path | None = None) -> dict:
    """Only a valid exported release manifest identifies a deployed revision."""
    root = Path(root) if root is not None else ROOT
    revision = None
    try:
        manifest = json.loads((root / 'release-manifest.json').read_text(encoding='utf-8'))
        if (isinstance(manifest, dict) and type(manifest.get('schema')) is int
                and manifest['schema'] == 1 and manifest.get('source') == 'git-archive'
                and isinstance(manifest.get('commit'), str)
                and _REVISION.fullmatch(manifest['commit'])):
            revision = manifest['commit']
    except (OSError, ValueError):
        pass
    return {'version': application_version(root), 'revision': revision,
            'build': revision[:12] if revision else 'development', 'development': revision is None}
