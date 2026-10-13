# Easel 138 Linux deployment

This deployment serves trusted operators sharing one workspace. It is not a
multi-tenant data-isolation system. Entry: `https://192.168.0.138:8444/`.
Codex is disabled until independently verified. Windows packaging remains paused.

## Build and verify

Export only a selected commit using `build_release.py --commit <SHA> --output
<ZIP>`. Transfer the ZIP and receipt using SSH/SCP; verify its SHA-256 before
extracting into `/home/ubuntu/Easel.new.<SHA-prefix>`. Reject ZIP paths containing
`..`, absolute paths, duplicate names or special files. In the expanded directory:

```sh
python3 deployment/138/manage.py verify
python3 deployment/138/manage.py preflight
docker build -f deployment/138/Dockerfile -t easel:<SHA-prefix> .
```

The image installs pinned Python/npm downloads and builds the frontend from that
same source. The manifest is copied to `/app/release-manifest.json`. Check the
actual image ID and copied source hashes; a ZIP hash alone does not verify a
running container. Debian apt packages are versioned by their repositories, not
fully snapshot-pinned; preserve the built image ID for exact rollback.

## Data, credentials and IP certificate

```sh
python3 deployment/138/manage.py prepare
```

Mutable data, profiles and outputs: `/home/ubuntu/easel-data`. OpenClaw identity,
sessions, browser profiles and caches: `/home/ubuntu/easel-state`. Access hashes,
TLS keys, CA and deployment environment: `/home/ubuntu/easel-secrets`. Backups:
`/home/ubuntu/easel-backups`. All are separate from the release directory.

The production username and random password are initially in the owner-readable
`easel-secrets/onboarding.txt`. Do not publish that file or place it in Git.
Only the HTTPS proxy exposes a port; Web and Gateway have no published ports.
The CA private key is never mounted into nginx. Install the public
`easel-root-ca.crt` on clients only after checking its fingerprint; this tool
does not install client trust or bypass browser certificate warnings.

Configure model channels through authenticated Settings, or transfer only the
authorized provider entry. Never copy a desktop OpenClaw/Codex state directory,
browser profiles or platform cookies. The server creates its own Gateway token
and CLI identity; loopback Gateway pairing must actually succeed before Web
starts. Skill directories and server path guidance are managed by this release.

## Activate and rollback

```sh
python3 deployment/138/manage.py activate --image easel:<SHA-prefix> --nginx <fixed-nginx-image>
docker compose -p easel --env-file /home/ubuntu/easel-secrets/deployment.env -f /home/ubuntu/Easel/deployment/138/compose.yaml ps
curl --cacert /home/ubuntu/easel-secrets/easel-root-ca.crt https://192.168.0.138:8444/login
```

Activation stops the old app before snapshotting data/state/secrets and switches
the `Easel` symlink. Inspect candidate health and actual task receipts before
declaring success. On failure, use the manager in the previous verified release:

```sh
python3 /home/ubuntu/Easel.previous/deployment/138/manage.py rollback
```

Rollback restores previous code and fixed image reference, retaining current
data/state. Data snapshot restore is a separate operation: stop writes, preserve
new artifacts, inspect compatibility and restore only with explicit intent.
First installation has no previous version; do not report rollback proven until
an isolated two-version failure drill has passed. Do not prune other projects'
images, touch AI-skills compose files or reuse ports 80/443.

## Isolated administrator test

`prepare --isolated-test` and `activate --isolated-test --image <image>` use a
separate Compose project `easel-test`, loopback HTTPS port8445 and directories
ending `-test`. The isolated administrator is `gaojitest` / `gaoji`, stored with
the same salted scrypt hash. These credentials cannot load production mode.
Use an SSH tunnel for browser testing and the test CA for explicit-CA HTTP
checks. Stop/remove the test containers after testing; retain reports as needed.

## Acceptance gates

Record separately: source/unit tests, HTTP with explicit CA, real browser with
installed trust, actual model/tool/file behavior, resource observation and
AI-skills regression. Test authentication across API, media, uploads, downloads
and SSE; exact Origin rejection; persistent file hashes and device identity after
recreation; interrupted tasks not replayed; stop/reconnect; desktop/390px menus.
Platform login/publishing and paid image/video generation need their own
authorization and results. Never describe untested integrations as passed.
