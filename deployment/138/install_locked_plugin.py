"""Install the dependency-free official plugin from the verified release lock."""
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
from urllib.request import urlopen

root = Path(__file__).resolve().parent
lock = json.loads((root / 'runtime-package-lock.json').read_text())
package = lock['packages']['node_modules/@openclaw/duckduckgo-plugin']
url = package['resolved']
if url != 'https://registry.npmjs.org/@openclaw/duckduckgo-plugin/-/duckduckgo-plugin-' + package['version'] + '.tgz':
    raise ValueError('Unexpected plugin origin')
with urlopen(url, timeout=30) as response:
    data = response.read(1024 * 1024 + 1)
if len(data) > 1024 * 1024 or 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode() != package['integrity']:
    raise ValueError('Plugin integrity mismatch')
destination = Path('/opt/openclaw/node_modules/@openclaw/duckduckgo-plugin')
destination.mkdir(parents=True, exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
    for member in archive:
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or path.parts[0] != 'package' or not (member.isfile() or member.isdir()):
            raise ValueError('Unexpected plugin archive entry')
        target = destination.joinpath(*path.parts[1:])
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(member).read())
metadata = json.loads((destination / 'package.json').read_text())
if metadata['version'] != package['version'] or metadata.get('dependencies'):
    raise ValueError('Reuse requires the pinned dependency-free plugin')
print('Pinned official plugin integrity and metadata verified:', package['version'])
