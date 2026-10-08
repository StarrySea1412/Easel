# Easel Creative Workspace

A local creative workspace combining conversations, assets, content projects, and a 3D office of animal Agents. See tasks, observed operations, and workspace outputs in one place.

[简体中文](README.md) · [Current source](https://github.com/StarrySea1412/Easel/tree/codex/creator-workflow) · [Report an issue](https://github.com/StarrySea1412/Easel/issues) · [Changelog](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/CHANGELOG.md)

> Maintained in [StarrySea1412/Easel](https://github.com/StarrySea1412/Easel), based on [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel). Updated **2026-10-08**. This page describes the current source on `codex/creator-workflow`; the `main` homepage carries the same project overview while feature code remains on the development branch. Existing 0.2.6 EXE / ZIP packages were built from `38e728c` and do not include the later workspace and office changes. No new installer containing these features has been released.
>
> A Windows x64 portable preview is being assembled locally. Its final ZIP has not been accepted or publicly released. See the [portable preview guide](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/windows-portable.md) for usage, fixed components and build instructions.

## Current features

- A Three.js / WebGL office with continuous character surfaces for cats, rabbits, foxes and bears. Preview, save or cancel appearance edits in the office; live Agent bindings are explicit.
- Search the full member list and locate employees across zones of up to eight visible workstations. Six role layouts have different equipment, seated poses and gestures.
- A task summary before the scene shows the selected member, recorded task, reported step and latest receipt, with direct process and output-location actions. Reading, writing, drawing and keyboard gestures follow observed states. The labeled demo supports seeking, pausing and replay.
- Exact-session, exact-turn visible reasoning and tool receipts. Completion, errors, stops and stale observations remain distinct. Unreported reasoning or output is never invented.
- Recent workspace output monitoring, media previews, downloads and content-library navigation. Files are not falsely attributed to an employee or conversation.
- Start a new office task, continue the current main conversation, inspect results or interrupt the current turn. Each submission can specify a channel and model, subject to strict capability checks; failures never silently select a default or fallback model. Separate controls configure subsequent calls for a verified Agent session or stop a verified child Agent.
- A Codex-inspired layout separates the tool rail from the conversation list. The toolbar independently switches between icons and labeled items, while the conversation list has its own persistent expand/collapse state. The default is a narrow tool rail and an open conversation list; secondary pages remain accessible through More. Per-conversation drafts, upload ownership, local history backups and protected imports remain available.
- The dashboard quick-creation box and chat reuse the same skill picker, persistent selected chips and detail components. Hover or keyboard focus shows the installed guide; clicking edits, saves or clears additional instructions. The dashboard's instructions for this creation travel with an accepted submission into a new conversation; chat instructions persist per conversation. Catalog failures and rejected sends retain choices and drafts, without modifying global skill files.
- Hover, focus or click the account icon to inspect local login snapshots for seven platforms using their original brand icons. Unknown, logged-out and saved-but-unverified states are distinct, with a direct account-center entry.
- The image studio displays the current model and saves a custom model ID for the connected image service; each job records the model selected for that run. Clipboard images, video files and local media have previews. Videos are decoded in the browser to a reference still; the source video is not uploaded. Actual generation still requires a working provider configuration.
- Paint a modification region directly on a reference image, with an eraser, brush sizes, clear, cancel and apply controls. Applying uploads a PNG mask at the original image dimensions; canceling preserves the existing draft. Generation remains a separate explicit action and requires a service that supports masked editing.
- Video creation inside the image studio with one-click image/video switching: text-to-video and image-to-video, ratio and duration choices, and references reused from uploads or the image gallery. Jobs run through the local script, at most two concurrently; only outputs passing MP4 structure and first-frame decoding checks are published. A configured video channel is required, generation is billed by the provider, and the retired official OpenAI Videos endpoint is explicitly rejected.
- An office workflow panel with four state lanes, explicit parent links and a scripted demo handoff timeline. An attention summary distinguishes reported problems, stopped agents and unknown states, with links to each member's process. Waiting remains separate and is not inferred to mean approval; live, demo and stale snapshots are labeled distinctly.
- Observed model identity on member details and the roster: the brand, model id, channel and time seen in call records. Configuration never rewrites an observed identity; unverifiable aliases fall back to the neutral wildcard figure, and demo employees are explicitly labeled as not calling a real model.
- A provider character registry covering 14 brands plus the wildcard role, with three first-batch rotatable 3D review studies (Doubao, DeepSeek, wildcard) that export white-background reference images. The studies have not replaced office characters, and the rest remain design directions.
- Content analysis separates fictional examples from the user's work. Seven platforms have explicit editorial priorities and material requirements, also passed into single-work AI interpretation. Cross-work analysis stays within one platform and account, using up to 12 works and 32 program-generated fact cards, with at most six suggestions. Each suggestion must reference valid fact cards covering at least two works. Results can be saved, exported and used to prefill validation experiments. Real model and platform workflows remain unverified.
- Page dropdowns use the shared custom Select component; the image/video switch and mask drawing tools reuse RadioGroup. Both sidebar columns, popovers and the main workspace share global surface, border, selected-state and focus colors. The iteration record lists the verification scope.
- Settings sections and model-channel choices wrap automatically. Dashboard, creator, analysis and office layouts adapt to their available container width after either sidebar column expands. Long forms and process panels retain scrollable content; wide data tables scroll within their own region. Device sizes and entry points are verified individually.
- A shared Show demo data switch on Settings → General controls content-analysis samples and the Agent office demo. Turning it off shows saved works, live observations or empty states, persists across reloads and synchronizes tabs on the same origin. Existing records and employee appearances remain intact.
- A My Trends picker with platform icons for nine sources. Add or remove sources, then explicitly save the list in the current browser; empty lists, restoring defaults and reload recovery are supported. Storage failures do not claim a successful save. Per-source errors, fetch times and retry controls remain distinct, alongside conversation, search and status filters in activity records.
- Planning, account, profile, content-library and publishing workflows remain available and are being iterated on.

Appearance does not change prompts or execution permissions. Demo tasks and artwork are labeled synthetic. Live screens summarize observed task records; they do not stream a remote desktop. Saving an Agent's subsequent-call model does not rerun completed work. Stopping a child can stop its descendants, but not its parent or siblings, and requires verified session, turn and run identities. See the [earlier office verification record](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/professional-office-2026-10-01.md) for those control boundaries.

New and continued office tasks share chat's execution path. Stopping waits for backend confirmation while retaining received results. Without an explicit model, the existing conversation configuration applies. An explicitly chosen channel/model is enabled only for the audited strict-override contract in **OpenClaw 2026.9.2**, with checks of the running gateway version, permissions and requested selection; newer or unknown versions are not presumed compatible. Failed checks reject the task instead of silently falling back. The interface preserves the requested model; actual model identity remains evidence from execution records. Registered configuration, API connectivity and real inference are separate checks. Real model and multi-Agent execution remain unverified in the current environment; see the [responsive layouts, skills and office-task record](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/responsive-office-skills-2026-10-08.md).

Platform analysis now asks different editorial questions: usefulness and saving on Xiaohongshu, long-video promises and follow-up questions on Bilibili, opening progression on Douyin, experience boundaries on Kuaishou, questions and arguments on Zhihu, long-form delivery on WeChat Official Accounts, and sharing context on WeChat Channels. These are editorial perspectives, not claims about platform algorithms. Missing visuals or retention data are not invented. Single-work AI validates verbatim source quotations. Cross-work AI instead validates each suggestion's fact IDs and their coverage of at least two works; it does not validate source quotes. Cross-work numbers remain in program-generated fact cards, and interpretation still requires human judgment. Relevant material changes invalidate saved cross-work results; changes during a request prevent stale results from being saved. See the [2026-10-08 implementation and verification record](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/analysis-platform-orca-2026-10-08.md).

The office attention summary draws on [stablyai/orca](https://github.com/stablyai/orca), while question-driven account analysis draws on the separate LinkedIn Orca project. Neither is added as a runtime dependency. Persistent task orchestration, structured human-input workflows, exact artifact ownership and delivery receipts remain future work. See the [Orca source review and license boundaries](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/orca-research-2026-10-08.md).

The office also draws on Tencent's [public Marvis documentation](https://marvis.qq.com/docs/agent-system) to put tasks, responsible members, reported steps, receipts and output locations first. Missing records remain unavailable; completion percentages are not guessed, and workspace files are not automatically attributed to the selected member. This research did not install or sign in to the Marvis client and does not establish equivalent overall experience. See the [Marvis research and implementation boundaries](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/marvis-office-2026-10-08.md).

A review of [AI Image Studio](https://gitee.com/starry-sea-1412/ai-image-studio) informed the priority for drawing masks directly on reference images. This iteration implements that interaction independently on Easel's existing upload and generation paths. Style templates, a persistent image queue and comparisons across channels remain future work; no external service or runtime dependency was imported. See the [studio comparison and MIT license boundaries](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/image-studio-comparison-2026-10-08.md).

Natural prop handling, complete motion and handoffs remain in progress. Role/capability configuration, real output attribution, full motion collision checks and performance are not fully verified. The October 1 HTTP sample returned content from seven trend sources while Zhihu and Toutiao were rate-limited. An October 8 sample of the primary Zhihu source returned 30 trending questions; neither sample establishes long-term availability. See the [historical workspace verification](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/workspace-experience-validation-2026-10-01.md).

The optional Zhihu fallback is disabled by default. Set `EASEL_ZHIHU_DAILYHOT_URL` in the backend launch environment to an authorized or self-hosted DailyHotApi-Go-compatible question-ranking endpoint, then restart the backend. It is tried only when the primary source fails or is cooling down. The public demo was checked but was not installed as a default dependency. This is not a search-keyword API, and response-generation times are not treated as ranking-update times. See the [Zhihu source investigation and configuration](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/zhihu-trends-2026-10-08.md).

Office characters are generated locally with Three.js surfaces and skinning; no Meshy account or generation credits are required. Species-specific bodies, faces, ear shells and a continuous fox tail have been refined. Thumb orientation, pen/paper contacts and workstation-facing poses are corrected; eyes, brows and mouth now reflect reported states while appearance editing remains available. See [local character modeling and verification](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/local-character-modeling-2026-10-02.md).

The office character redesign around model providers is underway: the design list and identity plan for 14 brands plus the wildcard role are finalized (see the [design review and model identity plan](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/model-provider-characters-2026-10-02.md)); office members already display the model identity observed in call records; the first three 3D review studies (Doubao, DeepSeek, wildcard) can be rotated in the office and exported as reference images. Final 3D assets are still under review and have not replaced the current characters.

Video creation interfaces, protocol decisions and verification boundaries (six adapters, safe reference uploads, MP4 checks, job recovery and cancellation) are documented in the [video generation notes](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/video-generation-2026-10-01.md). Adapter code does not imply a configured provider or verified real generation; no paid generation was run in this iteration.

See the [2026-10-05 stage record](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/chat-studio-analysis-2026-10-05.md) for chat, studio model and clipboard changes, and the [2026-10-08 record](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/analysis-platform-orca-2026-10-08.md) for the current two-column sidebar, skill persistence and mask editor. Clipboard video availability depends on the browser and copy source; a copied video URL is not treated as a video file, and file selection remains available. Live content overviews and persistent archiving have different evidence requirements: the six platforms other than Xiaohongshu currently lack verified stable account IDs for archiving and require structured imports.

## Windows portable preview in preparation

R24 is preparing a Windows x64 ZIP containing the application, built frontend, CPython 3.12.10, Node 24.19.0, OpenClaw 2026.9.2, FFmpeg 9.0.1 and matching Chromium 153.0.8010.12 / r1243. The intended workflow is to extract the complete ZIP into a short, writable path and double-click `Easel.exe`. Runtime programs and the `data` directory remain relative to that folder. Closing the graphical control window stops this copy's services; separate `.cmd` files provide start, status and stop fallbacks.

Users supply their own model API keys. Optional Whisper and rembg model weights are not bundled. This local candidate is unsigned, final ZIP and clean Windows VM acceptance remain pending, and no public Release has been created. **The existing 0.2.6 online installer packages remain unchanged.** Current preparation status and eventual checksum evidence are recorded in the [Windows portable preview guide](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/windows-portable.md).

## Run the current source

```bash
git clone --branch codex/creator-workflow https://github.com/StarrySea1412/Easel.git
cd Easel
```

Windows 10/11, in PowerShell. Install Git before cloning, plus Python 3.10+ (3.12 recommended), Node.js 24.16+ on 24.x or 26.1+, and FFmpeg, and make them available in the terminal. The installer reports missing tools.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -NonInteractive -DeferBrowser -DataDir .\data
.\.venv\Scripts\python.exe .\scripts\start_workspace.py --data-dir .\data --port 7860
```

This quick-start path explicitly defers the dedicated browser used by platform login/publishing, so you can open the core workbench first. Installation records say that the browser was deferred, never that it was installed. Browser-dependent platform actions require completing this step later, while retaining completed stages:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -NonInteractive -DataDir .\data
```

For a full first installation, use the command without `-DeferBrowser` from the start. The official browser download requires access to its CDN; slow connections have a 120-second default wait. If that still fails, use the explicit quick-start path above.

Run the first command for initial installation or dependency updates; use the second command for later starts from the Easel directory. Installation and launch must use the same data directory. This launcher restores the saved gateway settings and local tool paths; a bare `easel web` command does not replace it. `ExecutionPolicy Bypass` applies only to this installation process and does not change the system policy.

The installer checks prerequisites and prepares an isolated environment. System-tool installation through winget requires the explicit `-AllowWinget` option. `-NonInteractive` defers model configuration to Web settings. First installation needs network access to download dependencies. Wait for successful completion before launching; if a step fails, address its error and rerun the same command to resume completed stages. Keep the installation window open. This is not an offline portable package. Read the [Windows installer guide](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/windows-installer.md).

macOS / Linux retain the upstream entry point:

```bash
bash setup.sh
source .venv/bin/activate
easel web --port 7860
```

The Windows launcher opens the browser; you can also use its printed local URL (normally `http://127.0.0.1:7860/`, or another free port if occupied). After success, the service runs in the background and you may close the launch terminal; rerunning the same command reuses the workbench. On the welcome screen, choose general mode (先用通用模式), then open Settings → Model configuration (模型配置) → Add provider (添加供应商). Enter your own service URL, model and API key, set the primary channel, save, then use the channel self-test (自测本通道). Model services may charge for usage. Without model configuration, you can browse the workbench, select skills and manage local ideas/calendar entries; this does not establish working AI generation.

The core start path was checked using an independent source copy, empty data, a new Python environment and freshly installed frontend dependencies. Installation and launch from a fresh terminal succeeded; the actual browser reached the dashboard, welcome flow and model configuration form. The host already had the system tools listed above. The official Chromium download still timed out, so the complete platform-browser installation did not pass. Pinning biliup to the release lock's 1.2.9 wheel removed an unexpected source-build requirement; the model-key template now stays empty instead of falsely appearing configured. See the [first-run verification](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/responsive-office-skills-2026-10-08.md#新用户首次运行).

In the dashboard quick-creation box, select skills, inspect their guides and save additional instructions for this creation. An accepted submission carries the text, skills and instructions into a new conversation; rejected sends or failed local saves retain the draft. Acceptance does not mean the model task has completed successfully. The Agent office can start or continue a main-conversation task, and selected employees still support in-place appearance editing. Keep API keys, platform sessions and personal outputs outside Git.

To hide built-in examples, open Settings → General (通用设置) and turn off Show demo data (显示演示数据). Successful changes apply immediately and are saved in the current browser; no server restart is needed. A storage failure keeps the previous setting and reports the problem. Re-enable the switch to restore demo entries without deleting imported works, conversations or employee appearances.

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

The October 8 responsive-layout, dashboard-skill and office-task changes passed **639/639 frontend tests**, **1449 Python tests with 6 skipped**, lint, TypeScript and production builds. Navigation and layout checks cover 16 main pages at 390/768/1280px; final session-list and calendar-title fixes were rechecked in the browser. Subsequent first-install fixes and independent-environment results are listed separately in the [latest verification record](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/responsive-office-skills-2026-10-08.md). An existing development environment does not prove a fresh install, and unchecked external platforms or real inference are not marked as passing.

Earlier R15 demo-setting stage: **572/572 frontend tests**, with lint, TypeScript and production builds passing. The preceding same-day Python baseline was **1417 passed / 6 skipped**; R15 changed only the frontend and did not rerun backend tests. These historical results do not replace verification of the latest changes, and test counts do not represent equivalent coverage of real external services.

Earlier browser checks covered the sidebar, conversation skill instructions, trend-source saving and mask controls on desktop and at **390×844**. Office issue navigation used demo data, and a **640×480** binary PNG mask was uploaded to the actual local backend. The skill guide's keyboard entry was verified; independent mouse-hover behavior has simulated DOM coverage only. See that [stage's verification record](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/analysis-platform-orca-2026-10-08.md) for individual results.

The demo switch was also checked in the actual browser using mouse and Space/Enter input, reload persistence, settings navigation and the 390×844 layout. Turning it off in another tab removed an open simulated process, team, timeline and output preview; imported analysis records remained. No real model was called for these checks.

CI runs for `main` and `codex/**` branches. Windows installer builds are manual and do not publish releases automatically. New installer discovery and release metadata use this repository and do not fall back to an upstream package when a release is missing.

[Progress](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/secondary-development-progress.md), the [user requirements checklist](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/user-requirements-2026-10-08.md), [workspace action plan](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/workspace-experience-action-plan-2026-10-01.md), [roadmap](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/secondary-development-plan.md), and [verification evidence](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/workspace-experience-validation-2026-10-01.md) separate source changes, browser checks, isolated HTTP fixtures, gateway mocks, and installer validation. Every new user interruption or added request is recorded with its intent, acceptance conditions, remaining work and revised priority before editing resumes; parallel assignments are updated without dropping earlier tasks. Real model calls, full multi-Agent runs, all publishing platforms and a new installer upgrade have not been verified in this iteration. The current local workspace has no administrator login system.

## Attribution and license

Based on [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel), with thanks to its authors and contributors. This repository maintains its own workspace experience, office interactions and reliability changes; it is not an official upstream release.

[Apache License 2.0](LICENSE), with the [original acknowledgments](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/ACKNOWLEDGMENTS.md) retained. OpenClaw, frontend libraries and third-party skill components retain their respective licenses and required notices.
