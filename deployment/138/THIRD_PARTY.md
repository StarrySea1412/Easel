# Linux runtime attribution

Easel retains its upstream license in `/app/LICENSE` and the original licenses in
`skills/`, including the vendored video pipeline and design skills. Frontend SVG
attribution remains in `web/frontend/src/assets/platforms/`.

OpenClaw 2026.9.6 and all its installed npm dependencies retain their package
license files under `/opt/openclaw/node_modules/`. The complete dependency tree
and registry integrity values are in `runtime-package-lock.json`.
The MCP SDK is explicitly pinned to 1.32.1 to fix GHSA-6qxp-vccf-f47h while
retaining the OpenClaw protocol version selected for this deployment.

Python dependencies and download SHA-256 values are recorded in
`requirements/linux-py312.lock`; installed distributions retain `.dist-info`
license metadata. No CUDA runtime or model weights are included. FFmpeg,
Chromium, fonts and Debian system packages retain their packaged licenses in
`/usr/share/doc`. The release receipt identifies the exact app image and source
commit. This inventory does not replace the applicable third-party licenses.
