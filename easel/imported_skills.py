"""Persistent ClawHub skill identities; never shadow bundled skills."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re


def local_name(owner: str, slug: str) -> str:
    digest = hashlib.sha256(f'{owner}/{slug}'.encode()).hexdigest()[:12]
    return f'clawhub-{slug[:64]}-{digest}'


def installed(data: Path) -> dict[str, dict]:
    root = data / 'clawhub-skills'
    if not root.is_dir() or root.is_symlink():
        return {}
    result = {}
    for folder in root.iterdir():
        if not folder.is_dir() or folder.is_symlink() or folder.name.startswith('.'):
            continue
        try:
            receipt = folder / '.clawhub-source.json'
            if receipt.is_symlink() or receipt.stat().st_size > 256_000:
                continue
            value = json.loads(receipt.read_text(encoding='utf-8'))
            owner, slug = value['owner'], value['slug']
            if (not isinstance(owner, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_.-]{0,99}', owner)
                    or not isinstance(slug, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,95}', slug)
                    or folder.name != local_name(owner, slug)):
                continue
            skill = folder / 'SKILL.md'
            if (skill.is_symlink() or not skill.is_file() or skill.stat().st_size > 1024 * 1024
                    or hashlib.sha256(skill.read_bytes()).hexdigest() != value['files']['SKILL.md']):
                continue
            result[folder.name] = value
        except (OSError, ValueError, TypeError, KeyError):
            continue
    return result


def skill_path(bundled: Path, data: Path, name: str) -> Path:
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', name) or name.startswith('.'):
        raise ValueError('Invalid skill name')
    builtin = bundled / name / 'SKILL.md'
    if builtin.is_file():
        return builtin
    if name in installed(data):
        return data / 'clawhub-skills' / name / 'SKILL.md'
    raise FileNotFoundError(name)
