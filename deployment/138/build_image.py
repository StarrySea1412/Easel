"""Build committed source, reusing a fixed runtime only when dependencies match."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import tempfile
import tomllib

from manage import RELEASE, verify

DEPENDENCIES = ('deployment/138/Dockerfile', 'deployment/138/runtime-package.json',
                'deployment/138/runtime-package-lock.json', 'requirements/linux-py312.lock', 'pyproject.toml')
RUNTIME_PREFIXES = ('easel/', 'web/', 'scripts/', 'skills/', 'profiles/_template/',
                    'openclaw/workspace/', 'agents/workspace/', 'openclaw/easel-agent-safety/', 'deployment/138/')


def compatible(candidate, baseline, candidate_project=None, baseline_project=None):
    for name in DEPENDENCIES:
        new, old = candidate['files'].get(name), baseline['files'].get(name)
        if not new or not old:
            return False
        if new == old:
            continue
        if name != 'pyproject.toml' or candidate_project is None or baseline_project is None:
            return False
        # A release number is package metadata, not a dependency change. Both
        # source texts must match their immutable manifests before comparison.
        projects = []
        for data, expected in ((candidate_project, new), (baseline_project, old)):
            if hashlib.sha256(data).hexdigest() != expected['sha256']:
                return False
            parsed = copy.deepcopy(tomllib.loads(data.decode('utf-8')))
            if not isinstance(parsed.get('project', {}).get('version'), str):
                return False
            parsed['project'].pop('version')
            projects.append(parsed)
        if projects[0] != projects[1]:
            return False
    return True


def reusable(base, candidate, root):
    current = base / 'Easel'
    receipt = current / 'deployment-receipt.json'
    if not receipt.is_file():
        return None
    recorded = json.loads(receipt.read_text())
    image = recorded['image']
    inspection = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image], text=True))[0]
    if inspection['Id'] != image:
        raise ValueError('Baseline image is not a fixed digest')
    baseline = json.loads(subprocess.check_output(
        ['docker', 'run', '--rm', '--entrypoint', 'cat', image, '/app/release-manifest.json'], text=True))
    if baseline['commit'] != recorded['commit']:
        raise ValueError('Baseline receipt and image source disagree')
    baseline_project = subprocess.check_output(
        ['docker', 'run', '--rm', '--entrypoint', 'cat', image, '/app/pyproject.toml'])
    return (image, baseline) if compatible(candidate, baseline,
        (root / 'pyproject.toml').read_bytes(), baseline_project) else None


def build(root, base, image):
    candidate = verify(root)
    reuse = reusable(base, candidate, root)
    revision = candidate['commit']
    if reuse is None:
        print('Dependency change or no recorded base: full locked build', flush=True)
        subprocess.run(['docker', 'build', '-f', str(root / 'deployment/138/Dockerfile'),
                        '--build-arg', 'EASEL_RELEASE_SHA=' + revision, '-t', image, str(root)], check=True)
        mode, baseline_image = 'full', None
    else:
        baseline_image, baseline = reuse
        print('Identical dependency inputs: fixed runtime reuse', baseline_image, flush=True)
        frontend = image + '-frontend'
        subprocess.run(['docker', 'build', '--target', 'frontend', '-f', str(root / 'deployment/138/Dockerfile'),
                        '-t', frontend, str(root)], check=True)
        frontend_id = subprocess.check_output(['docker', 'image', 'inspect', frontend, '--format', '{{.Id}}'], text=True).strip()
        deleted = [name for name in baseline['files'] if name.startswith(RUNTIME_PREFIXES)
                   and name not in candidate['files']]
        for name in deleted:
            if '..' in Path(name).parts or Path(name).is_absolute():
                raise ValueError('Invalid deleted source path')
        remove = 'import pathlib; names=' + repr(deleted) + '; [(pathlib.Path("/app")/n).unlink(missing_ok=True) for n in names]'
        dockerfile = f'''FROM {frontend_id} AS frontend
FROM {baseline_image}
USER root
WORKDIR /app
RUN python -c {shlex.quote(remove)}
COPY pyproject.toml ./
COPY easel/ ./easel/
COPY web/ ./web/
COPY scripts/ ./scripts/
COPY skills/ ./skills/
COPY profiles/_template/ ./profiles/_template/
COPY agents/workspace/ ./agents/workspace/
COPY openclaw/easel-agent-safety/ ./openclaw/easel-agent-safety/
COPY LICENSE ./
COPY release-manifest.json ./
COPY deployment/138/ ./deployment/138/
RUN rm -rf /app/web/frontend/dist
COPY --from=frontend /build/dist/ ./web/frontend/dist/
RUN pip install --no-deps . && rm -rf web/frontend/node_modules && chmod -R a+rX /app
LABEL org.opencontainers.image.revision={revision}
USER 1000:1000
'''
        with tempfile.TemporaryDirectory(prefix='easel-source-build-') as temporary:
            path = Path(temporary) / 'Dockerfile'
            path.write_text(dockerfile)
            subprocess.run(['docker', 'build', '-f', str(path), '-t', image, str(root)], check=True)
        mode = 'fixed-runtime-reuse'
    inspection = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image], text=True))[0]
    if inspection['Config']['Labels']['org.opencontainers.image.revision'] != revision:
        raise ValueError('Built image revision mismatch')
    receipt = {'commit': revision, 'image': inspection['Id'], 'mode': mode, 'baselineImage': baseline_image}
    (root / 'image-build-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, default=Path('/home/ubuntu'))
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    build(RELEASE, args.base, args.image)
