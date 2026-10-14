"""Linux host release verification, backup, activation and code rollback.

Run from an extracted, verified release. Secrets never appear in command output.
The manager operates only Easel paths and Compose services, never other projects.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tarfile
import time

RELEASE = Path(__file__).resolve().parents[2]


def run(command, **kwargs):
    return subprocess.run(command, check=True, text=True, **kwargs)


def verify(root: Path):
    manifest = json.loads((root / 'release-manifest.json').read_text())
    if manifest['schema'] != 1 or len(manifest['commit']) != 40:
        raise ValueError('Invalid release manifest.')
    for name, expected in manifest['files'].items():
        path = root / name
        if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()) or not path.is_file():
            raise ValueError('Invalid release file: ' + name)
        data = path.read_bytes()
        if (len(data) != expected['bytes'] or hashlib.sha256(data).hexdigest() != expected['sha256']
                or hashlib.md5(data, usedforsecurity=False).hexdigest() != expected['md5']):
            raise ValueError('Release checksum mismatch: ' + name)
    print('Verified source commit:', manifest['commit'], 'files:', len(manifest['files']))
    return manifest


def layout(base: Path, isolated=False):
    suffix = '-test' if isolated else ''
    return {name: base / ('easel-' + name + suffix) for name in ('data', 'state', 'secrets', 'backups')}


def initialize(base: Path, isolated: bool):
    os.umask(0o077)
    paths = layout(base, isolated)
    for path in paths.values():
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    model_file = paths['secrets'] / 'model-bootstrap.json'
    if not model_file.exists():
        model_file.write_text('{}\n')
    access = paths['secrets'] / 'access.json'
    if not access.exists():
        user = 'gaojitest' if isolated else 'easel-admin'
        password = 'gaoji' if isolated else secrets.token_urlsafe(30)
        salt = secrets.token_bytes(16)
        encoded = 'scrypt$16384$' + base64.b64encode(salt).decode() + '$' + base64.b64encode(
            hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1)).decode()
        access.write_text(json.dumps({'environment': 'isolated-test' if isolated else 'production',
            'sessionKey': secrets.token_hex(48), 'users': {user: encoded}}, indent=2))
        if not isolated:
            (paths['secrets'] / 'onboarding.txt').write_text('Account: ' + user + '\nPassword: ' + password + '\n')
    tls = paths['secrets'] / 'tls'
    tls.mkdir(exist_ok=True)
    ca_dir = paths['secrets'] / 'ca-private'
    ca_dir.mkdir(exist_ok=True)
    if not (tls / 'server.crt').exists():
        # Independent CA: no reuse of AI-skills keys and no automatic client trust installation.
        run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '3650',
             '-keyout', str(ca_dir / 'ca.key'), '-out', str(paths['secrets'] / 'easel-root-ca.crt'),
             '-subj', '/CN=Easel 138 Private Root CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
             '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        run(['openssl', 'req', '-new', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-keyout', str(tls / 'server.key'),
             '-out', str(tls / 'server.csr'), '-subj', '/CN=192.168.0.138'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        extension = ca_dir / 'server.ext'
        extension.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
            'extendedKeyUsage=serverAuth\nsubjectAltName=IP:192.168.0.138,IP:127.0.0.1\n')
        run(['openssl', 'x509', '-req', '-in', str(tls / 'server.csr'), '-CA', str(paths['secrets'] / 'easel-root-ca.crt'),
             '-CAkey', str(ca_dir / 'ca.key'), '-CAcreateserial', '-out', str(tls / 'server.crt'), '-days', '365',
             '-sha256', '-extfile', str(extension)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (tls / 'server.csr').unlink()
    print('Independent data/state/access/TLS prepared; private credentials remain in', paths['secrets'])


def env_file(base: Path, isolated: bool):
    return layout(base, isolated)['secrets'] / 'deployment.env'


def compose(base: Path, isolated: bool, source: Path, arguments):
    project = 'easel-test' if isolated else 'easel'
    environment = dict(os.environ)
    environment.setdefault('EASEL_BROWSER_SECCOMP_PATH', str(source / 'deployment/138/browser-seccomp.json'))
    return run(['docker', 'compose', '-p', project, '--env-file', str(env_file(base, isolated)),
                '-f', str(source / 'deployment/138/compose.yaml'), *arguments], env=environment)


def configure(base: Path, isolated: bool, image: str, nginx: str):
    # Docker image refs only; prevent environment-file line injection.
    import re
    if any(not re.fullmatch(r'[a-zA-Z0-9_./:@-]+', item) for item in (image, nginx)):
        raise ValueError('Invalid image reference.')
    paths = layout(base, isolated)
    browser_auth = paths['secrets'] / 'browser-auth.json'
    if not browser_auth.exists():
        descriptor = os.open(browser_auth, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            json.dump({'username': 'easel-browser', 'password': secrets.token_urlsafe(48)}, output)
    values = {'EASEL_IMAGE': image, 'EASEL_NGINX_IMAGE': nginx,
        'EASEL_BROWSER_SECCOMP_PATH': str(RELEASE / 'deployment/138/browser-seccomp.json'),
        'EASEL_HOSTNAME': '127.0.0.1' if isolated else '192.168.0.138',
        'EASEL_BIND_IP': '127.0.0.1' if isolated else '192.168.0.138', 'EASEL_HTTPS_PORT': '8445' if isolated else '8444',
        'EASEL_DEPLOYMENT_MODE': 'isolated-test' if isolated else 'production'}
    values.update({'EASEL_' + name.upper() + '_PATH': str(path) for name, path in paths.items() if name != 'backups'})
    if any('\n' in value or '\r' in value or ' ' in value for value in values.values()):
        raise ValueError('Deployment paths must not contain whitespace.')
    env_file(base, isolated).write_text(''.join(key + '=' + value + '\n' for key, value in values.items()))


def backup(base: Path, isolated: bool):
    paths = layout(base, isolated)
    current = base / ('Easel-test' if isolated else 'Easel')
    if current.exists():
        compose(base, isolated, current.resolve(), ['stop', 'app'])
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    output = paths['backups'] / (stamp + '.tar.gz')
    os.umask(0o077)
    with tarfile.open(output, 'w:gz') as archive:
        for name in ('data', 'state', 'secrets'):
            archive.add(paths[name], arcname=name, recursive=True)
    print('Stopped-write snapshot:', output)
    return output


def switch(base: Path, isolated: bool, source: Path):
    verify(source)
    current = base / ('Easel-test' if isolated else 'Easel')
    previous = current.with_name(current.name + '.previous')
    if current.exists() and not current.is_symlink():
        raise ValueError('Existing unmanaged Easel directory requires explicit migration.')
    if current.is_symlink():
        old = current.resolve()
        old_receipt = old / 'deployment-receipt.json'
        if old_receipt.exists():
            (layout(base, isolated)['backups'] / 'previous-deployment.json').write_bytes(old_receipt.read_bytes())
        if previous.is_symlink():
            previous.unlink()
        previous.symlink_to(old, target_is_directory=True)
    temporary = current.with_name(current.name + '.switch')
    compose(base, isolated, source, ['config', '--quiet'])
    if temporary.is_symlink():
        temporary.unlink()
    temporary.symlink_to(source.resolve(), target_is_directory=True)
    temporary.replace(current)
    compose(base, isolated, source, ['up', '-d', '--no-build'])
    print('Active release:', current, '->', source)


def rollback(base: Path, isolated: bool):
    current = base / ('Easel-test' if isolated else 'Easel')
    previous = current.with_name(current.name + '.previous')
    receipt_path = layout(base, isolated)['backups'] / 'previous-deployment.json'
    if not previous.is_symlink() or not receipt_path.is_file():
        raise ValueError('No recorded previous release/image; rollback refused.')
    receipt = json.loads(receipt_path.read_text())
    compose(base, isolated, current.resolve(), ['stop', 'app'])
    configure(base, isolated, receipt['image'], receipt['nginx'])
    switch(base, isolated, previous.resolve())
    print('Code and image restored; current data/state retained. Snapshot restore is separate.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['verify', 'prepare', 'preflight', 'backup', 'activate', 'rollback'])
    parser.add_argument('--base', type=Path, default=Path('/home/ubuntu'))
    parser.add_argument('--isolated-test', action='store_true')
    parser.add_argument('--image')
    parser.add_argument('--nginx', default='nginx:1.29.2-alpine@sha256:61e01287e546aac28a3f56839c136b31f590273f3b41187a36f46f6a03bbfe22')
    args = parser.parse_args()
    if args.operation == 'verify':
        verify(RELEASE)
    elif args.operation == 'preflight':
        verify(RELEASE)
        free = shutil.disk_usage(args.base).free
        if free < 5 * 1024 ** 3:
            raise RuntimeError('Less than 5GiB free; stop before deploying.')
        run(['docker', 'info', '--format', '{{.ServerVersion}}'])
        print('Free disk bytes:', free)
        if env_file(args.base, args.isolated_test).exists():
            compose(args.base, args.isolated_test, RELEASE, ['config', '--quiet'])
    elif args.operation == 'prepare':
        initialize(args.base, args.isolated_test)
    elif args.operation == 'backup':
        backup(args.base, args.isolated_test)
    elif args.operation == 'activate':
        if not args.image:
            parser.error('--image is required')
        verify(RELEASE)
        paths = layout(args.base, args.isolated_test)
        if env_file(args.base, args.isolated_test).exists():
            backup(args.base, args.isolated_test)
        configure(args.base, args.isolated_test, args.image, args.nginx)
        inspection = json.loads(subprocess.check_output(['docker', 'image', 'inspect', args.image], text=True))[0]
        receipt = {'commit': verify(RELEASE)['commit'], 'image': inspection['Id'], 'nginx': args.nginx,
                   'source': str(RELEASE), 'activatedAt': datetime.now(timezone.utc).isoformat()}
        (RELEASE / 'deployment-receipt.json').write_text(json.dumps(receipt, indent=2))
        switch(args.base, args.isolated_test, RELEASE)
    else:
        rollback(args.base, args.isolated_test)
