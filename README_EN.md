# Easel Creative Workspace

A local creative workspace combining conversations, assets, content projects, and a 3D office of animal Agents. See tasks, observed operations, and workspace outputs in one place.

[简体中文](README.md) · [Current source](https://github.com/StarrySea1412/Easel/tree/codex/creator-workflow) · [Report an issue](https://github.com/StarrySea1412/Easel/issues) · [Changelog](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/CHANGELOG.md)

> Maintained in [StarrySea1412/Easel](https://github.com/StarrySea1412/Easel), based on [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel). Updated **2026-10-08**. This page describes the current source on `codex/creator-workflow`; the `main` homepage carries the same project overview while feature code remains on the development branch. Existing 0.2.6 EXE / ZIP packages were built from `38e728c` and do not include the later workspace and office changes. No new installer containing these features has been released.

## Current features

- A Three.js / WebGL office with continuous character surfaces for cats, rabbits, foxes and bears. Preview, save or cancel appearance edits in the office; live Agent bindings are explicit.
- Search the full member list and locate employees across zones of up to eight visible workstations. Six role layouts have different equipment, seated poses and gestures.
- Reading, writing, drawing and keyboard gestures, pen pickup/return and pose transitions. Desk screens show observed tasks and tools; a readable screen panel and work history explain activity. The labeled demo supports seeking, pausing and replay.
- Exact-session, exact-turn visible reasoning and tool receipts. Completion, errors, stops and stale observations remain distinct. Unreported reasoning or output is never invented.
- Recent workspace output monitoring, media previews, downloads and content-library navigation. Files are not falsely attributed to an employee or conversation.
- Configured model selection for subsequent calls in a verified Agent session, plus distinct child-Agent and whole-session interruption. Controls remain unavailable without verified gateway capability, permissions and identity.
- A Codex-inspired layout separates the tool rail from the conversation list. The toolbar independently switches between icons and labeled items, while the conversation list has its own persistent expand/collapse state. The default is a narrow tool rail and an open conversation list; secondary pages remain accessible through More. Per-conversation drafts, upload ownership, local history backups and protected imports remain available.
- Selected skills and their count stay visible in the composer. Hover or keyboard focus shows the installed skill guide; clicking opens editable instructions for that skill in the current conversation, with save and clear actions. Choices and instructions persist per conversation. Each send takes its own snapshot without changing global skill files or earlier messages. Catalog failures do not erase choices, and failed saves retain the draft with an explanation.
- Hover, focus or click the account icon to inspect local login snapshots for seven platforms using their original brand icons. Unknown, logged-out and saved-but-unverified states are distinct, with a direct account-center entry.
- The image studio displays the current model and saves a custom model ID for the connected image service; each job records the model selected for that run. Clipboard images, video files and local media have previews. Videos are decoded in the browser to a reference still; the source video is not uploaded. Actual generation still requires a working provider configuration.
- Paint a modification region directly on a reference image, with an eraser, brush sizes, clear, cancel and apply controls. Applying uploads a PNG mask at the original image dimensions; canceling preserves the existing draft. Generation remains a separate explicit action and requires a service that supports masked editing.
- Video creation inside the image studio with one-click image/video switching: text-to-video and image-to-video, ratio and duration choices, and references reused from uploads or the image gallery. Jobs run through the local script, at most two concurrently; only outputs passing MP4 structure and first-frame decoding checks are published. A configured video channel is required, generation is billed by the provider, and the retired official OpenAI Videos endpoint is explicitly rejected.
- An office workflow panel with four state lanes, explicit parent links and a scripted demo handoff timeline. An attention summary distinguishes reported problems, stopped agents and unknown states, with links to each member's process. Waiting remains separate and is not inferred to mean approval; live, demo and stale snapshots are labeled distinctly.
- Observed model identity on member details and the roster: the brand, model id, channel and time seen in call records. Configuration never rewrites an observed identity; unverifiable aliases fall back to the neutral wildcard figure, and demo employees are explicitly labeled as not calling a real model.
- A provider character registry covering 14 brands plus the wildcard role, with three first-batch rotatable 3D review studies (Doubao, DeepSeek, wildcard) that export white-background reference images. The studies have not replaced office characters, and the rest remain design directions.
- Content analysis separates fictional examples from the user's work. Seven platforms have explicit editorial priorities and material requirements, also passed into single-work AI interpretation. Cross-work analysis stays within one platform and account, using up to 12 works and 32 program-generated fact cards, with at most six suggestions. Each suggestion must reference valid fact cards covering at least two works. Results can be saved, exported and used to prefill validation experiments. Real model and platform workflows remain unverified.
- Page dropdowns use the shared custom Select component; the image/video switch and mask drawing tools reuse RadioGroup. Both sidebar columns, popovers and the main workspace share global surface, border, selected-state and focus colors. The iteration record lists the verification scope.
- A My Trends picker with platform icons for nine sources. Add or remove sources, then explicitly save the list in the current browser; empty lists, restoring defaults and reload recovery are supported. Storage failures do not claim a successful save. Per-source errors, fetch times and retry controls remain distinct, alongside conversation, search and status filters in activity records.
- Planning, account, profile, content-library and publishing workflows remain available and are being iterated on.

Appearance does not change prompts or execution permissions. Demo tasks and artwork are labeled synthetic. Live screens summarize observed task records; they do not stream a remote desktop. Model assignment does not rerun completed work. Stopping a child can stop its descendants, but not its parent or siblings. See the [office verification record](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/professional-office-2026-10-01.md) for limitations.

Platform analysis now asks different editorial questions: usefulness and saving on Xiaohongshu, long-video promises and follow-up questions on Bilibili, opening progression on Douyin, experience boundaries on Kuaishou, questions and arguments on Zhihu, long-form delivery on WeChat Official Accounts, and sharing context on WeChat Channels. These are editorial perspectives, not claims about platform algorithms. Missing visuals or retention data are not invented. Single-work AI validates verbatim source quotations. Cross-work AI instead validates each suggestion's fact IDs and their coverage of at least two works; it does not validate source quotes. Cross-work numbers remain in program-generated fact cards, and interpretation still requires human judgment. Relevant material changes invalidate saved cross-work results; changes during a request prevent stale results from being saved. See the [2026-10-08 implementation and verification record](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/analysis-platform-orca-2026-10-08.md).

The office attention summary draws on [stablyai/orca](https://github.com/stablyai/orca), while question-driven account analysis draws on the separate LinkedIn Orca project. Neither is added as a runtime dependency. Persistent task orchestration, structured human-input workflows, exact artifact ownership and delivery receipts remain future work. See the [Orca source review and license boundaries](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/orca-research-2026-10-08.md).

A review of [AI Image Studio](https://gitee.com/starry-sea-1412/ai-image-studio) informed the priority for drawing masks directly on reference images. This iteration implements that interaction independently on Easel's existing upload and generation paths. Style templates, a persistent image queue and comparisons across channels remain future work; no external service or runtime dependency was imported. See the [studio comparison and MIT license boundaries](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/image-studio-comparison-2026-10-08.md).

Natural prop handling, complete motion and handoffs remain in progress. Role/capability configuration, real output attribution, full motion collision checks and performance are not fully verified. The October 1 HTTP sample returned content from seven trend sources while Zhihu and Toutiao were rate-limited. An October 8 sample of the primary Zhihu source returned 30 trending questions; neither sample establishes long-term availability. See the [historical workspace verification](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/workspace-experience-validation-2026-10-01.md).

The optional Zhihu fallback is disabled by default. Set `EASEL_ZHIHU_DAILYHOT_URL` in the backend launch environment to an authorized or self-hosted DailyHotApi-Go-compatible question-ranking endpoint, then restart the backend. It is tried only when the primary source fails or is cooling down. The public demo was checked but was not installed as a default dependency. This is not a search-keyword API, and response-generation times are not treated as ranking-update times. See the [Zhihu source investigation and configuration](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/zhihu-trends-2026-10-08.md).

Office characters are generated locally with Three.js surfaces and skinning; no Meshy account or generation credits are required. Species-specific bodies, faces, ear shells and a continuous fox tail have been refined. Thumb orientation, pen/paper contacts and workstation-facing poses are corrected; eyes, brows and mouth now reflect reported states while appearance editing remains available. See [local character modeling and verification](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/local-character-modeling-2026-10-02.md).

The office character redesign around model providers is underway: the design list and identity plan for 14 brands plus the wildcard role are finalized (see the [design review and model identity plan](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/model-provider-characters-2026-10-02.md)); office members already display the model identity observed in call records; the first three 3D review studies (Doubao, DeepSeek, wildcard) can be rotated in the office and exported as reference images. Final 3D assets are still under review and have not replaced the current characters.

Video creation interfaces, protocol decisions and verification boundaries (six adapters, safe reference uploads, MP4 checks, job recovery and cancellation) are documented in the [video generation notes](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/video-generation-2026-10-01.md). Adapter code does not imply a configured provider or verified real generation; no paid generation was run in this iteration.

See the [2026-10-05 stage record](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/chat-studio-analysis-2026-10-05.md) for chat, studio model and clipboard changes, and the [2026-10-08 record](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/analysis-platform-orca-2026-10-08.md) for the current two-column sidebar, skill persistence and mask editor. Clipboard video availability depends on the browser and copy source; a copied video URL is not treated as a video file, and file selection remains available. Live content overviews and persistent archiving have different evidence requirements: the six platforms other than Xiaohongshu currently lack verified stable account IDs for archiving and require structured imports.

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

The installer checks prerequisites and prepares an isolated environment. System-tool installation through winget requires the explicit `-AllowWinget` option. `-NonInteractive` defers model configuration to Web settings. First installation needs network access. Read the [Windows installer guide](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/windows-installer.md).

macOS / Linux retain the upstream entry point:

```bash
bash setup.sh
source .venv/bin/activate
easel web --port 7860
```

Open the local URL printed by the server and configure your own model channels in Settings. Select an employee in the Agent office to edit their appearance in place. Keep API keys, platform sessions and personal outputs outside Git.

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

Automated checks for this October 8 iteration: **555/555 frontend tests**, **1417 Python tests passed / 6 skipped**, plus passing lint, TypeScript and production builds. Test counts do not represent equivalent coverage of real external services.

Actual browser checks covered the sidebar, conversation skill instructions, trend-source saving and mask controls on desktop and at **390×844**. Office issue navigation used demo data, and a **640×480** binary PNG mask was uploaded to the actual local backend. The skill guide's keyboard entry was verified; independent mouse-hover behavior has simulated DOM coverage only. See the [iteration verification record](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/analysis-platform-orca-2026-10-08.md) for individual results.

CI runs for `main` and `codex/**` branches. Windows installer builds are manual and do not publish releases automatically. New installer discovery and release metadata use this repository and do not fall back to an upstream package when a release is missing.

[Progress](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/secondary-development-progress.md), the [user requirements checklist](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/user-requirements-2026-10-08.md), [workspace action plan](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/workspace-experience-action-plan-2026-10-01.md), [roadmap](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/secondary-development-plan.md), and [verification evidence](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/workspace-experience-validation-2026-10-01.md) separate source changes, browser checks, isolated HTTP fixtures, gateway mocks, and installer validation. Real model calls, full multi-Agent runs, all publishing platforms and a new installer upgrade have not been verified in this iteration. The current local workspace has no administrator login system.

## Attribution and license

Based on [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel), with thanks to its authors and contributors. This repository maintains its own workspace experience, office interactions and reliability changes; it is not an official upstream release.

[Apache License 2.0](LICENSE), with the [original acknowledgments](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/ACKNOWLEDGMENTS.md) retained. OpenClaw, frontend libraries and third-party skill components retain their respective licenses and required notices.
