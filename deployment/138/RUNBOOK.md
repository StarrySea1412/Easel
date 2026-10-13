# Easel 138 Linux deployment

This deployment serves trusted operators sharing one workspace. It is not a
multi-tenant data-isolation system. Entry: `https://192.168.0.138:8444/`.
Codex is disabled until independently verified. Windows packaging remains paused.

## Current release and evidence (2026-10-13)

The final release source is `8b6bcea7a09a13e2598e44874a3b5cdddcc42a51`;
its image ID is
`sha256:e35e5e74f9b20e5ba1b4b9587e68db4e22f0010da462ed56f6e4f96fe86cbc24`.
The release directory is `/home/ubuntu/Easel.new.8b6bcea7a09a` and its
activation snapshot is `/home/ubuntu/easel-backups/20261013T084803Z.tar.gz`.
Live checks confirmed both easel and easel-test use the image above, are Healthy
with zero restarts and pass all 1,351 runtime-source hashes. The independent
OpenClaw config retains `tools.toolSearch=false` with the same verified digest.
Later documentation-only commits do not change the running release identity.
The upgrade reuses the verified fixed previous image only after all dependency
inputs were confirmed identical, then layers the new source and newly built
frontend. The preceding c35e9851 upgrade passed all 1,351 runtime-source hashes,
isolated/production health, actual login, Gateway and authenticated HTTP file
hash checks. The final patch adds explicit attachment responses while retaining
inline previews. Browser library defaults to All, the actual HTML marker
displays in its iframe, and a real attachment download passed: 159 bytes,
SHA-256 `d5b98a0721b00dd9521566e174f0579d5c07f9cfa6d5498f6d1185a00cfe757e`,
matching host/container originals. Opening the original URL directly in a new
tab of the selected real browser also displayed the actual marker and Chinese
and space-path sample. Clicking the original-file link returned HTTP 200, but
the in-app browser did not expose that target-blank tab; that click-to-tab
observation remains unverified. Preview, direct browser open and attachment
download are recorded separately.

Existing evidence also covers trusted browser login/chat, actual
model/skill/terminal/file execution and a persistent file whose download
matched its SHA-256 after an app restart and version upgrade. Two actual
`web_fetch` receipts returned HTTP 200 after deferred-tool compatibility was
corrected. The empty content-library filter is normalized to `all`, with four
focused regressions passed.

R119 deferred complete rollback/recovery drills, representative 15-minute load,
all menus/390px, platform integrations and paid media. R122 continues version
activation and maintenance handoff without marking those checks passed. Keep
the original D01–D12 checklist and each evidence class separate.

## Visible version follow-up (R123, implementation in progress)

The planned v0.2.7 sidebar footer shows a short application version. Its light
details show the 12-character build SHA from the installed release manifest.
`GET /api/version` stays behind existing access authentication and returns
`Cache-Control: no-store`; source checkouts without a manifest are marked as
development environments. Returning focus to the window re-reads the server
version; refreshing is still required to load an updated interface. This
follow-up is being implemented and tested, and is not included in the running
8b6bcea7 release yet. Record its actual release/image only after activation.

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
R120 explicitly overrides the current internal-network deployment at
`https://192.168.0.138:8444/` to username `gaojitest`, password `gaoji`; actual
login passed after the override. This is a controlled runtime credential change
with normal salted scrypt, backed-up old authentication and invalidated old
sessions. It is not a default account in source, migrations or images. Use
independent compliant credentials for any public deployment.
Only the HTTPS proxy exposes a port; Web and Gateway have no published ports.
The CA private key is never mounted into nginx. Install the public
`easel-root-ca.crt` on clients only after checking its fingerprint; this tool
does not install client trust or bypass browser certificate warnings.

Configure model channels through authenticated Settings, or transfer only the
authorized provider entry. Never copy a desktop OpenClaw/Codex state directory,
browser profiles or platform cookies. The server creates its own Gateway token
and CLI identity; loopback Gateway pairing must actually succeed before Web
starts. Skill directories and server path guidance are managed by this release.

New server configurations use `tools.toolSearch: false` so custom
OpenAI-compatible models receive direct tool schemas. OpenClaw 2026.9.6 defaults
to deferred tool discovery; some models call `web_fetch` directly and receive
`Tool web_fetch not found` in that mode. This setting changes schema delivery,
not execution permissions. Existing explicit operator settings are preserved.
For an affected existing installation, back up its independent OpenClaw config,
set this field to false, validate the config and verify an actual tool receipt.

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
the same salted scrypt hash. The isolated authentication file is tied to test
mode and cannot be copied into production mode; R120 separately authorized
the current internal deployment to use the same credentials in its own runtime
authentication file.
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
