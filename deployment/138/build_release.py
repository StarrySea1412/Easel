"""Export a selected Git commit, never the live/dirty checkout, to a Linux ZIP."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import zipfile

PREFIXES = ('easel/', 'web/', 'scripts/', 'skills/', 'profiles/_template/',
            'openclaw/workspace/', 'deployment/138/', 'requirements/', 'docs/', 'tests/')
FILES = {'pyproject.toml', '.dockerignore', 'LICENSE', 'AGENTS.md', 'README.md', 'README_EN.md', 'CHANGELOG.md'}
PRIVATE_PARTS = {'.git', '.venv', 'node_modules', '__pycache__', 'outputs', 'logs', '.codex', '.openclaw'}
PRIVATE_NAMES = {'cookies.json', 'auth.json', 'device-auth.json', 'install-state.json', 'wechat-publisher.yaml'}


def permitted(name: str) -> bool:
    path = PurePosixPath(name)
    return (not path.is_absolute() and '..' not in path.parts
            and (name in FILES or name.startswith(PREFIXES))
            and not any(part in PRIVATE_PARTS or part.startswith('.env') for part in path.parts)
            and path.name not in PRIVATE_NAMES and path.suffix not in {'.log', '.jsonl', '.pyc'}
            and not name.startswith('web/frontend/dist/'))


def digest(data: bytes):
    return {'bytes': len(data), 'md5': hashlib.md5(data, usedforsecurity=False).hexdigest(),
            'sha256': hashlib.sha256(data).hexdigest()}


def export(repo: Path, commit: str, output: Path) -> dict:
    revision = subprocess.check_output(['git', 'rev-parse', '--verify', commit + '^{commit}'], cwd=repo, text=True).strip()
    raw = subprocess.check_output(['git', 'archive', '--format=tar', revision], cwd=repo)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for member in archive:
            if member.isdir() or not permitted(member.name):
                continue
            if not member.isfile():
                raise ValueError('Release refuses special entries: ' + member.name)
            files[member.name] = archive.extractfile(member).read()
    required = {'deployment/138/Dockerfile', 'deployment/138/compose.yaml', 'requirements/linux-py312.lock',
                'deployment/138/runtime-package-lock.json', 'web/frontend/package-lock.json'}
    missing = required - files.keys()
    if missing:
        raise ValueError('Missing committed release dependencies: ' + ', '.join(sorted(missing)))
    manifest = {'schema': 1, 'commit': revision, 'source': 'git-archive',
                'files': {name: digest(data) for name, data in sorted(files.items())}}
    files['release-manifest.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    pending = output.with_name(output.name + '.partial')
    with zipfile.ZipFile(pending, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    pending.replace(output)
    receipt = {'commit': revision, 'zip': output.name, 'zipSha256': hashlib.sha256(output.read_bytes()).hexdigest(),
               'sourceFiles': len(manifest['files'])}
    receipt_path = output.with_suffix('.receipt.json')
    pending_receipt = receipt_path.with_name(receipt_path.name + '.partial')
    pending_receipt.write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    pending_receipt.replace(receipt_path)
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    print(json.dumps(export(args.repo, args.commit, args.output), indent=2))
