> **Production updated · 2026-11-06:** 0.46.13 / 25560370fb28069f6eef301a1b223116ac298062, healthy services. Snapshot /home/ubuntu/easel-backups/20261106T090228Z.tar.gz; prior d42c471bedae retained. Post-upgrade model/browser acceptance delegated to user; isolation remains 0.46.11. [Receipt](../../docs/gpt-responses-xhs-0.46.13.md).

> **Current deployment · 2026-11-06:** Production/isolation run 0.46.11 / d42c471bedaeb90117e228a7073ad823918d465d, image sha256:ecde69ab2ee082febcd80dc2892f6a47beb1c1fdc9f8449ce65c314761696b01. Authenticated HTTPS, Gateway, 1767 runtime sources, 71 assets and original upstream-404 history enrichment passed. Production snapshot: /home/ubuntu/easel-backups/20261106T052621Z.tar.gz; previous b6db2ae596b4 retained. Existing root-owned backup directories required sudo backup; model-bootstrap.json ownership was repaired for uid1000, keeping mode600 and contents. Vendor model-group access remains unresolved; no model replay or installer. [Evidence and maintenance interruption](../../docs/release-138-0.46.11-2026-11-06.md).

> **0.46.5 source candidate:** Ship matching frontend/plugin/Python/bundled skills. Register existing rendered files before native image inspection, preserving session ownership and symlink checks; registration is not visual approval. Do not replay old generation or vision requests automatically. Keep prior image/task data and the previous release. [Evidence and rollout status](../../docs/image-inspection-order-0.46.5.md).

> **0.46.4 source candidate:** Ship matching Python/frontend/plugin and bundled XHS skills. Back up outputs, image queue, task budget and state before switching; retain the previous release. Three queued/done receipts do not establish three valid images or visual quality. Preserve uncertainty slots; never regenerate on rollback. AI Hub upstream 502 recovery and actual business acceptance remain separate. [Behavior, checks and rollout receipt](../../docs/xhs-three-cards-0.46.4.md).

> **Current deployment · 2026-11-05:** Production and isolation run 0.46.2 / 7b413f12bf8ac0c2b979d918a636d22b4c6c7f2f, image sha256:f3e598c1ef5856254e68839e00105b4182330c68c1fbdf31203f077940e3355e. Production activated at 05:24:52 UTC (13:24:52 Beijing). Source/asset hashes, trusted-CA HTTPS, login/Gateway and four-width browser draft loading/restore/return passed. Preserve distinct same-title drafts; legacy text-only reads do not rewrite originals or bypass media/analysis checks. Backup: /home/ubuntu/easel-backups/20261105T052257Z.tar.gz; Easel.previous retains 0.46.1. No model or publication was submitted. [Patch receipt and limits](../../docs/publish-draft-layout-0.46.2.md).

> **Previous deployment · 2026-11-05:** Production and isolation ran 0.46.1 / 3399cdfee1b566244637aae2f8137ca32d0989bf, image sha256:8f7dc34d11048fca0318ac1b019e73c9991ce9f847308d45583d04ac27cdfeb6. Production activated at 03:53:54 UTC; runtime sources, 70 frontend asset hashes, trusted-CA HTTPS, login, Gateway and app/browser health passed. Browser checks covered production notifications/settings and isolated synthetic image interactions, with internal alias TLS behavior documented separately. No original task replay or installer release. [Historical receipt and rollback boundary](../../docs/agent-wait-image-notices-0.46.1.md).

> **Waiting configuration:** Ship matching backend/frontend/plugin. EASEL_MODEL_STREAM_IDLE_TIMEOUT_MS defaults to 600000 without observable model events, accepts 0 to disable and integers up to 7200000; production was read back as 600000. Synthetic start does not renew it; SDK-hidden heartbeats are not observable. TIMEOUT_CHAT=7200 and upstream limits still apply. Preserve outputs/state and the previous release. The stop-write backup is /home/ubuntu/easel-backups/20261105T035148Z.tar.gz; Easel.previous retains 0.45.9. Code rollback retains current data/state; snapshot restoration is separate and was not exercised on production.

> **0.39.0 source candidate, not deployed:** Semantic merge/conflict proposals require matching frontend/backend builds and explicit user confirmation. Back up the entire data directory and a consistent SQLite snapshot; additive consolidation links and source dependencies must survive body deletion. An older backend cannot enforce these new dependencies: roll back code together with the pre-upgrade data backup, never open upgraded memory data with an old binary. Shut down the idle execution service before upgrading. [Behavior, validation and rollback limits](../../docs/experience-consolidation-0.39.0.md).

> **0.27.0 source candidate, not deployed:** Back up the full data directory and a consistent SQLite snapshot before upgrading matching frontend/backend builds. The additive extraction-receipt table and original profile binding require lifecycle checks; native recovery, semantic merging and real business evaluation remain incomplete. [Verification and rollback limits](../../docs/experience-extraction-0.27.0.md).

> **0.26.0 source candidate, not deployed:** Shared local context budgeting requires matching frontend/backend builds and a consistent data backup. Native hidden history/image accounting remains unknown; no installer or host switch is included. [Configuration, verification and rollback limits](../../docs/context-budget-0.26.0.md).

> **Historical deployment, 2026-10-20:** Production and isolated instances ran 0.7.2 / `e63a08eac773`, fixed image `sha256:fd631a6ab44a62837e781b3e50d87ce81783a4483bfc05ed08ef24aa5d80e25c`. Production had HappyCoding configured with five models, keeping its existing default. HTTP/source hashes passed; final browser and business acceptance was delegated to the user. [Historical receipt, capacity limits and rollback](../../docs/archive/2026/release-138-0.7.2-2026-10-20.md).

# Easel 138 Linux deployment

Historical 0.2.8 release: `12f144c8`, image `82cd8cbddf1a`. The Windows quick entry completed isolated/live activation, source/authentication/gateway/official-update checks and real Agent tool acceptance. Frontend interaction acceptance was left to the user. [Historical receipt](../../docs/archive/2026/quick-deploy-138-acceptance-2026-10-14.md).

This deployment serves trusted operators sharing one workspace. It is not a
multi-tenant data-isolation system. Entry: `https://192.168.0.138:8444/`.
Codex is disabled until independently verified. Windows packaging remains paused.

## October 14 candidate runtime repair

The active 0.2.8 image includes the latest saved local UI, actual/current npm
OpenClaw versions and an Agent action that evaluates official release notes.
It keeps OpenClaw pinned to 2026.9.6. Production activation and final receipts
are recorded separately in `docs/runtime-repair-2026-10-14.md`. The active image
is `sha256:14393be39cc117bed4e6296e022905f0d560109fcc592bbbc7c6b48a2b470000`.

From a Windows checkout, `Quick-Deploy-138.cmd` (implemented by
`scripts/deploy_138.ps1`) chains the committed-source export, SSH/SCP transfer,
remote manifest verification and Docker build. It stages a candidate by default;
only `-Activate` runs the remote stop-write backup and symlink switch. Use
`-IsolatedTest -Activate` for the separate test stack first. The full command
reference and prerequisites are in `docs/deploy-138-quick-start.md`.

138 cannot reach DuckDuckGo. The Easel `free-search` plugin uses the reachable
public Bing RSS endpoint with OpenClaw's public search SDK, bounded responses,
source URLs and untrusted-content wrappers. Back up the independent config,
then call `configure_free_search(..., allow_plugin=True)` for an explicitly
authorized existing installation. Keep unrelated providers, model credentials
and identity intact; remove temporary staged copies of the same plugin.
The final read-only plugin path is `/app/deployment/138/free-search`.

Chromium previously exhausted its 128 thread/PID allowance. The dedicated
browser now allows 256 and limits Mesa worker threads to two. Authenticated
health checks create a disposable blank page and evaluate JavaScript, in
addition to checking CDP connectivity. Namespace and seccomp sandboxing remain
enabled. One-off scripts and intermediate files belong under `/data/outputs`
or disposable `/tmp`, because `/app` is read-only.

## Current release and evidence (2026-10-13)

Read-only browser/HTTP comparison confirmed a synchronization gap: the fixed
v0.2.7/build 1a324540854c server release excludes uncommitted local UI. Local
Settings grouping, compact image/account-analysis layout, skill suggestions,
compact tool presentation and the user-provided OpenClaw SVG are not deployed
on 138 yet. A newer build timestamp does not mean newer UI content. Local source
is 0.2.7 but its running version API returns 404. This comparison changed or
restarted no service; prior core login/model/file evidence remains valid.

The running release is v0.2.7, source
`1a324540854c4fe082ee30ec0256942b8c6ef5da`;
its image ID is
`sha256:ac2b0d6e96ebd4250686380d82520d9498df3a20444154bb370b4dba3556bc8f`.
The release directory is `/home/ubuntu/Easel.new.1a324540854c` and its
activation snapshot is `/home/ubuntu/easel-backups/20261013T092340Z.tar.gz`.
The committed source ZIP contains 1,527 source files, SHA-256
`a897350bfef7273c716185bca26f0e47e9cae37622571dd50db068e6ef5f9ac9`.
Live checks confirmed both easel and easel-test use the image above, are Healthy
with zero restarts and pass all 1,355 runtime-source hashes. Actual login and
Gateway readiness passed in both environments. The independent OpenClaw config
retains `tools.toolSearch=false`, SHA-256
`10e9317f06a4c30a1b1f1934a3abe4268950b020a3cc539e20601077545a8f35`.
The runtime release is pushed and its remote SHA matches. Main README-only
synchronization and later documentation commits are recorded separately.
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

## Visible version (R123, deployed and accepted)

The v0.2.7 sidebar footer shows a short application version. Its light
details show the 12-character build SHA from the installed release manifest.
`GET /api/version` stays behind existing access authentication and returns
`Cache-Control: no-store`; source checkouts without a manifest are marked as
development environments. Returning focus to the window re-reads the server
version; refreshing is still required to load an updated interface. This
feature is deployed as build `1a324540854c`. The authenticated endpoint returned
0.2.7, that build SHA and development=false; unauthenticated401, authenticated200
and no-store checks passed. Real browser refresh, details click/Escape focus
restoration and 390px version-control bounds passed. Twenty-five focused backend
and 38 frontend checks, TypeScript and server production build passed (existing
chunk warning). This release preserves the original 159-byte artifact and
matching preview/attachment SHA-256. No model request was repeated for the
version update; actual model/tool evidence remains the earlier scoped checks.
R119/R122 core delivery and R123 version visibility are complete; deferred
full-checklist items remain unverified.

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

Before building, preflight checks the release/data filesystem, DockerRootDir
and /var/lib/containerd (when present), each with at least 5GiB free. Full builds
can need substantially more space; this floor is not a capacity guarantee.
An older stable product version is rejected before activation. Use the recorded
rollback operation for a deliberate rollback. Release-number-only changes still
reuse the verified runtime when all dependency inputs otherwise match.

For 0.46.0, use the branch based on the live 0.45.9 release. The abandoned 0.10.0
candidate is from an older branch and must not replace the deployed product.
See ../../docs/super-agent-0.46.0.md for the disk failure and repair boundaries.

Record separately: source/unit tests, HTTP with explicit CA, real browser with
installed trust, actual model/tool/file behavior, resource observation and
AI-skills regression. Test authentication across API, media, uploads, downloads
and SSE; exact Origin rejection; persistent file hashes and device identity after
recreation; interrupted tasks not replayed; stop/reconnect; desktop/390px menus.
Platform login/publishing and paid image/video generation need their own
authorization and results. Never describe untested integrations as passed.
