# Easel Creative Workspace

A local creative workspace combining conversations, assets, content projects, and a 3D office of animal Agents. See tasks, observed operations, and workspace outputs in one place.

[简体中文](README.md) · [Development branch](https://github.com/StarrySea1412/Easel/tree/codex/creator-workflow) · [Changelog](CHANGELOG.md) · [Implementation and verification](docs/professional-office-2026-10-01.md)

> This is a maintained customization of [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel). Development happens on `codex/creator-workflow`. Existing 0.2.6 EXE / ZIP packages were built from `38e728c` and do not include the later office and reliability changes. No new installer containing these features has been released.

## Current features

- A real Three.js / WebGL office with cats, rabbits, foxes and bears. Appearance cards customize clothing, fur, accents and accessories; live Agent bindings are explicit.
- Evidence-driven reading, writing, drawing and execution gestures. Desk screens show the task and reported tool; a readable screen panel and work history explain the selected Agent's activity.
- Exact-session, exact-turn visible reasoning and tool receipts. Completion, errors, stops and stale observations remain distinct. Unreported reasoning or output is never invented.
- Recent workspace output monitoring, media previews, downloads and content-library navigation. Files are not falsely attributed to an employee or conversation.
- Configured model selection for subsequent calls in a verified Agent session, plus distinct child-Agent and whole-session interruption. Controls remain unavailable without verified gateway capability, permissions and identity.
- Per-conversation drafts, careful upload ownership, local history backups, additive read-only imports, and protection against corrupt or conflicting local records.
- The upstream discovery, planning, image creation, account, profile, content-library and publishing workflows remain available and are being iterated on.

Appearance does not change prompts or execution permissions. Demo tasks and artwork are labeled synthetic. Live screens summarize observed task records; they do not stream a remote desktop. Model assignment does not rerun completed work. Stopping a child can stop its descendants, but not its parent or siblings. See the [verification record](docs/professional-office-2026-10-01.md) for limitations.

## Run the current source

```bash
git clone --branch codex/creator-workflow https://github.com/StarrySea1412/Easel.git
cd Easel
```

Windows 10/11, in PowerShell:

```powershell
.\setup.ps1 -NonInteractive
.\.venv\Scripts\easel.exe web --port 7860
```

The installer checks prerequisites and prepares an isolated environment. System-tool installation through winget requires the explicit `-AllowWinget` option. `-NonInteractive` defers model configuration to Web settings. First installation needs network access. Read the [Windows installer guide](docs/windows-installer.md).

macOS / Linux retain the upstream entry point:

```bash
bash setup.sh
source .venv/bin/activate
easel web --port 7860
```

Open the local URL printed by the server and configure your own model channels in Settings. Animal appearance cards are also in Settings. Keep API keys, platform sessions and personal outputs outside Git.

## Development

React / TypeScript / Vite / Three.js frontend: `web/frontend`. Python backend: `web/app.py`. CLI: `easel/`. Use the project's supported Node.js versions: 24.16+ on 24.x, or 26.1+.

```bash
cd web/frontend
npm ci
npm test
npm run lint
npm run build
```

From the repository root with test dependencies installed:

```bash
python -m pytest -q
```

CI runs for `main` and `codex/**` branches. Windows installer builds are manual and do not publish releases automatically. New installer discovery and release metadata use this repository and do not fall back to an upstream package when a release is missing.

[Progress](docs/secondary-development-progress.md), [roadmap](docs/secondary-development-plan.md), and [verification evidence](docs/professional-office-2026-10-01.md) separate source changes, browser checks, isolated HTTP fixtures, gateway mocks, and installer validation. Real model calls, full multi-Agent runs, all publishing platforms and a new installer upgrade have not been verified in this iteration.

## Attribution and license

Based on [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel), with thanks to its authors and contributors. This repository maintains its own workspace experience, office interactions and reliability changes; it is not an official upstream release.

[Apache License 2.0](LICENSE). OpenClaw, frontend libraries and third-party skill components retain their respective licenses and required notices.
