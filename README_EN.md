# Easel Creative Workspace

A local workspace for ideas, images, content, and AI assistants.

This repository is an independently maintained fork of **[ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel)**. It builds on the original creation workflows and skills, with a focus on everyday usability, Windows support, image creation, content review, and a visual Agent studio. This is not an official release of the upstream project.

[简体中文](README.md) · [Development branch](https://github.com/StarrySea1412/Easel/tree/codex/creator-workflow) · [Issues](https://github.com/StarrySea1412/Easel/issues) · [Releases](https://github.com/StarrySea1412/Easel/releases)

> Custom features are developed on `codex/creator-workflow`. The `main` README introduces this fork; use the development branch to try the customized workspace. Source changes are not necessarily included in older installers. Check the release notes for the version you install.

## What the workspace offers

| Area | Purpose |
| --- | --- |
| Chat and creation | Discuss ideas, attach materials, revise content, and keep conversations and drafts |
| Image studio | Generate images from descriptions, edit uploaded images, extract image descriptions, and reuse previous work |
| Trends and ideas | Browse available trend sources, collect ideas, and plan a content calendar |
| Content library | Organize project outputs, preview media and text, and download files |
| Content analysis | Review collected or imported performance data and identify possible next steps |
| Agent studio | Observe tasks, member states, and tool records; explore character and role-specific workstation designs |
| Accounts and profiles | Manage platform connections, audience, positioning, and writing preferences |

AI features require your own configured model service. Platform collection and publishing depend on authentication, available interfaces, and permissions. Demonstrations are labeled separately from observed backend activity.

## Current development focus

- Simpler everyday workflows with advanced settings available when needed.
- Image-centered creation and continued editing of results.
- Plain-language analysis, useful content tables, and inspectable evidence.
- Better character models, work animations, distinct workstations, and character editing. Visual prototypes and real execution are validated separately.
- Reliable drafts, backups, error states, loading, and Windows installation.

See the [development record](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/secondary-development-progress.md) for completed scope. A demonstration is not evidence of real model execution or a complete production workflow.

## Run from source

```bash
git clone --branch codex/creator-workflow https://github.com/StarrySea1412/Easel.git
cd Easel
```

Windows 10/11: install Git, Python 3.10+, Node.js 24.16+ (24.x), and FFmpeg, make them available on PATH, then run in PowerShell:

```powershell
.\setup.ps1 -NonInteractive
.\.venv\Scripts\easel.exe web --port 7860
```

macOS / Linux:

```bash
bash setup.sh
source .venv/bin/activate
easel web --port 7860
```

Open the local address printed in the terminal and configure the services you need in Settings. Initial setup requires network access. See the [Windows installation guide](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/windows-installer.md) for dependencies and recovery.

## Development

The frontend uses React, TypeScript, Vite, and Three.js in `web/frontend/`. The Python / FastAPI backend starts in `web/app.py`; the CLI lives in `easel/`.

- [Development branch README](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/README.md)
- [Development plan](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/secondary-development-plan.md)
- [Skills and capabilities](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/skill-function-mapping.md)
- [Upstream project](https://github.com/ZJU-REAL/Easel)

## Attribution and license

This project is derived from [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel). We thank its original authors and contributors, and the maintainers of OpenClaw and other dependencies. Upstream history and attribution are preserved; see the original [acknowledgments](docs/ACKNOWLEDGMENTS.md). Changes in this fork are maintained here and do not represent an official product or commitment from the upstream authors or institutions.

Licensed under [Apache License 2.0](LICENSE). Third-party components, assets, and skills retain their own licenses and attribution requirements.
