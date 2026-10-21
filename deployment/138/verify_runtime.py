"""Verify installed source bytes against the commit manifest inside the image."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PREFIXES = ('easel/', 'web/', 'scripts/', 'skills/', 'profiles/_template/',
            'openclaw/workspace/', 'agents/workspace/', 'openclaw/easel-agent-safety/', 'deployment/138/')
FILES = {'pyproject.toml', 'LICENSE'}


def verify():
    manifest = json.loads((ROOT / 'release-manifest.json').read_text())
    count = 0
    for name, expected in manifest['files'].items():
        if name not in FILES and not name.startswith(PREFIXES):
            continue
        path = ROOT / name
        if path.is_symlink() or not path.resolve().is_relative_to(ROOT) or not path.is_file():
            raise RuntimeError('Runtime file missing/invalid: ' + name)
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected['sha256']:
            raise RuntimeError('Runtime source differs: ' + name)
        count += 1
    print(json.dumps({'commit': manifest['commit'], 'runtimeFilesVerified': count}))


if __name__ == '__main__':
    verify()
