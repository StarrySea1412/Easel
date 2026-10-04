# Changelog

Changes maintained by [StarrySea1412/Easel](https://github.com/StarrySea1412/Easel) are documented here, with earlier upstream history retained. Current feature development is on `codex/creator-workflow`.

## [Unreleased]

- Extend the linear icon set with 14 new stroke icons (user/user-plus/info/spark/key/eye/eye-off/pin/clock/coins/settings/download/warn/play) and allow `style`/`aria-hidden` on all icon components. Replace remaining emoji glyphs across the UI: page-title icons on Skills, Activity, Content Analysis, Accounts and Profile; persona dimension cards switch from emoji to labeled badges; chat hero suggestion cards, account identity/refresh buttons, profile edit/delete/new buttons, dashboard analysis-note placeholders and dashboard empty-state actions now use the shared icon language instead of emoji.

- Add phase-2 protected-data recovery in conversation backup: a review panel lists the guarded session/publish keys with size and content samples, and a confirmed replacement writes only the selected key — protection is lifted only after the write succeeds, failures stay retryable, and out-of-allowlist or oversize payloads are rejected. See [storage recovery acceptance](docs/interactive-acceptance-2026-10-04.md).

- Absorb the upstream `ai_video.py` UTF-8 stdout fix (Chinese check hints crashed with UnicodeEncodeError on Windows ANSI code pages) together with the `--env-file` override and its regression tests, taken from upstream ZJU-REAL/Easel commits dfd0fd1/d80b26c.

- Fix full-suite pytest collection: the installed OpenClaw workspace under `data/` contains skill copies whose conftest modules collide with the repo tree and aborted `python -m pytest -q`. `data/` is now excluded via `norecursedirs`, so the bare documented command runs (1281 passed, 6 skipped).
- State in model settings that the channel self-test only verifies model API connectivity (GET /models with timing); chat execution additionally requires the local OpenClaw gateway to be online.
- Persist the office demo team size across page remounts like the studio drafts; invalid stored values fall back to 6.

- Add video creation to the image studio: an image/video medium switch preserving separate drafts and jobs, text-to-video and image-to-video with ratio and duration options, references reused from uploads or the gallery, job polling, cancellation and restart recovery. The backend runs at most two local jobs, validates MP4 box structure and first-frame decoding before publishing, redacts credentials from errors, and rejects the retired official OpenAI Videos endpoint while keeping the historical protocol for compatible gateways (pixel sizes, string durations, `input_reference`, credentialed content download with cross-origin credential stripping). See [video generation notes](docs/video-generation-2026-10-01.md). All six video providers were unconfigured on this machine, so no real generation was run.
- Derive each Agent's observed model identity from assistant call records (brand families, relay namespaces, turn/run bounds and child receipts), and display it on member details and the roster; configured models never rewrite an observed identity and unverifiable aliases stay unknown.
- Add an office workflow panel with state lanes, parent-identity collaboration links and a scripted demo handoff timeline; only records reported for the current mode are shown.
- Add the provider character review entry: a 14-brand plus wildcard design registry and three rotatable procedural 3D studies (Doubao, DeepSeek, wildcard) with standing/seated poses, fixed viewpoints and white-background reference export. The studies do not replace office characters.
- Document the proposed 14-brand office character redesign and unknown-provider fallback, official visual references, modeling lessons and actual-run identity requirements. Concepts require review; runtime characters are unchanged by this documentation. See [design review](docs/model-provider-characters-2026-10-02.md).

- Refine locally generated office bodies with species-specific shoulder/chest/waist profiles, sculpted ear shells and a continuous fox tail. Correct thumb orientation, pen/paper contact and workstation-facing poses; add state-driven eyes, brows and mouth expressions. Preserve the seated rig and editable colors; no Meshy account, cloud generation or new model download is required. See [local modeling verification](docs/local-character-modeling-2026-10-02.md).

- Add in-place office appearance editing, searchable team zones, six role-specific workstations, continuous animal body surfaces, staged pen/paper handling and a seekable demo timeline. Fix stale completed/child activity and distinguish observed work from demo state. Full natural motion, handoffs and real task attribution remain in progress.
- Simplify image editing around the canvas and preserved drafts; add a clearly fictional content-analysis example with filtering and evidence; expose per-source trend failures and retry controls; move activity navigation into the page header.
- Update both repository homepages and development documentation for this fork, link the current development source explicitly, and direct issue reports to this repository. Retain upstream attribution and license information. See [workspace verification](docs/workspace-experience-validation-2026-10-01.md) and [the action plan](docs/workspace-experience-action-plan-2026-10-01.md).

- Refine animal shoulder/elbow/wrist articulation, tool contact, staged work gestures and restrained secondary motion, while keeping actions tied to observed evidence and terminal poses static. All 270 frontend tests, lint, build and HTTP resource checks pass; real WebGL checks cover sampled demo poses, controls and narrow layouts. See [animal motion iteration](docs/office-animal-motion-2026-10-01.md).

- Search filenames and paths within the current bounded output snapshot, combine type filters, and sort by modification time, name, or size without clearing unread indicators outside the visible list.
- Add explicit image and media loading, failure and retry states; isolate old resource events, release closed previews, and preserve playback while sorting. Real browser checks cover image recovery, video/audio playback and narrow layouts. See [media and search verification](docs/office-media-search-2026-10-01.md).

- Highlight newly observed and updated workspace outputs since the first successful snapshot; acknowledge individual files or only the current filtered list, with observation scope and reset behavior made explicit.
- Export the currently filtered employee call/receipt records as JSON with exact identity, source, pairing and snapshot limits; exclude hidden payloads and handle download failures without discarding records.
- Use the supported Three.js shadow-map mode. See [observation and export verification](docs/office-observation-export-2026-10-01.md).

- Read UTF-8 text outputs directly in the office with bounded streaming, timeout/retry feedback, and cancellation on file or mode changes; keep markup inert and reject unsupported content.
- Search visible employee tool/receipt summaries and filter failures, returns, or unmatched calls while preserving exact pairs, identity boundaries, and keyboard focus. See [text and record verification](docs/office-records-2026-10-01.md).

- Redraw office employees as 3D cats, rabbits, foxes and bears with editable appearance cards, evidence-driven work gestures, focused camera views, and labels that avoid employees and monitors.
- Show task and tool records on desk screens and a readable selected-workstation panel; synchronize close-up selection and restore it after WebGL retry.
- Open exact-turn thinking and work details from employee status, and monitor real workspace outputs with safe previews and explicit attribution limits.
- Add session-level configured model selection and exact-run Agent interruption with confirmed receipts, limited existing permissions, and distinct child/whole-session scopes.
- Preserve per-session composer drafts and accepted-send semantics; retain pending streams until stop confirmation.
- Protect idea/calendar records against corrupt reads and concurrent writes; validate frontend builds before Windows packaging and in CI.
- Replace the inherited repository homepages with current fork documentation, target installer discovery and release metadata at StarrySea1412/Easel, and run CI on the maintained development branches.

- Add a real Three.js Agent office with animated characters, selectable desks, camera controls, a clearly labeled six-agent demonstration, and session-scoped observation of existing backend evidence.
- Show recent tool calls and returns with Agent filtering and links to conversations and activity. Keep unknown and stopped states distinct, discard observations that cross execution turns, and freeze stale snapshots on refresh failures.
- Release 3D resources when Agent identities change or the page closes; respect visibility and reduced motion, pause hidden demo time, and offer an honest WebGL failure/retry view.
- Add local conversation backups with validation previews and additive read-only imports. Preserve unsaved and in-progress text, keep corrupt storage untouched, and export raw recovery evidence separately.
- Keep imported transcripts detached from backend jobs and usage evidence, disable automatic media loading, and preserve literal attachment markers on reload. Repeated backup navigation and save retries retain the correct state.
- Load secondary workbench pages on demand and retry failed pages locally without remounting background chat or image controllers, reducing the initial resources loaded by the workbench.
- Preserve existing conversations during migration and browser storage failures. Show unsaved changes, retry pending writes, protect unreadable history, and keep real history beyond 100 sessions.
- Keep activity details consistent with search and status filters, including empty results and unavailable deep-link targets.

Latest implementation and exact validation scope: [workspace experience iteration](docs/workspace-experience-validation-2026-10-01.md), with earlier features in [animal motion](docs/office-animal-motion-2026-10-01.md) and [professional office](docs/professional-office-2026-10-01.md) records. Browser checks use an isolated local workspace and simulated employee demonstrations; sampled poses do not establish collision-free motion at every instant or measured frame rates. Model and gateway protocol tests do not substitute for a real multi-agent run. These source changes are not included in the existing 0.2.6 installers.

## [0.2.6] - 2026-09-30

### Improved

- Added per-turn conversation navigation with previous/next controls, keyboard navigation, a compact selector on narrow screens, and explicit return-to-latest behavior. Reading earlier turns pauses automatic scrolling.
- Replaced image history and channel settings actions with labeled icon buttons; content analysis and activity now use distinct icons.
- Message copy actions report clipboard failures and remain accessible with a keyboard or touch screen.

### Fixed

- Pass configured gateway credentials consistently to HTTP and CLI chat transports. Recheck credentials after queued requests and invalidate endpoint probes when the gateway address or credentials change.
- Preserve structured authentication, timeout, connection, and execution failures through streaming and recovery instead of guessing that every failed process timed out. Incomplete HTTP streams retain partial output and report interruption; length-limited responses remain marked as truncated.
- Release streaming readers after terminal events, and prevent programmatic turn navigation from accidentally resuming automatic scrolling.

Windows artifacts and the exact verification scope are tracked in [the delivery checklist](docs/secondary-development-progress.md).

## [0.2.1] - 2026-09-24

### Added

- Added a unified **Settings panel** in the workbench (模型配置 · 环境安装 · 更多设置). Model configuration is now editable in the browser across all six channels (chat / transcribe / image / video / music / speech): edit provider, model, Base URL and API key, add custom providers, switch primary/backup, and run a real self-test that reports actual handshake latency. Saving writes to `.env`; keys are returned masked and an empty key field means "leave unchanged".
- Added a runtime **environment installer** (`install_tool.py`) plus an in-panel 环境安装 page: local engines are health-checked for real, installed in the background, and their status is written back as the job progresses.
- Added read-back reconciliation to Bilibili upload: after posting, the member submission API is queried directly and the run only counts as successful if the read-back matches.
- Added `vendor/VENDOR.md` recording the provenance of the bundled `video-pipeline-sdk` (upstream, version, local modifications, how to resync).

### Improved

- Improved conversation latency: the Web chat now talks to the resident gateway over its OpenAI-compatible HTTP endpoint instead of spawning a thin `openclaw agent` client every turn, saving roughly 3s per turn (measured on Linux: 7.6s → 4.5s end-to-end). Transport is pinned per session and never switches mid-conversation, so history is never silently dropped. Set `EASEL_CHAT_TRANSPORT=cli` to return to the old path.
- Improved responsiveness of the outputs library: `/api/outputs` moved to a thread pool so a full product-tree scan no longer blocks the event loop.
- Improved CI coverage: the suite now runs `pytest` instead of `pytest tests/`, so the 38 skill-bundled tests under `skills/**/tests/` actually run in CI.

### Fixed

- Fixed Windows installation on PowerShell 5.1, where `setup.ps1` failed outright during the configuration-writing stage (issue #41).
- Fixed workspace resolution: `sync.sh`, `setup.ps1`, `doctor` and the video pipeline each hard-coded a different workspace path, so on the other OpenClaw layout they wrote to a directory the agent never reads — while still reporting success. All four now ask OpenClaw itself for its runtime `workspaceDir` (issue #19).
- Fixed a placeholder API key in `.env.example` silently disabling the whole OpenAI-compatible branch of `setup.sh`, which produced a config with no provider while `doctor` still reported all green. `doctor` now verifies that the primary model's provider actually has credentials.
- Fixed the HTML preview in the content library: the built-in「复制到公众号」button now works inside the preview drawer, and the preview always renders the latest version instead of a heuristically cached one.
- Fixed images breaking after pasting into WeChat: local images referenced by a preview are inlined as base64 data-URIs, so the bytes travel with the clipboard instead of requiring WeChat to fetch a local Easel URL.
- Fixed `install_tool.py` crashing under non-UTF-8 locales on Windows, which left the install endpoint with an empty id allowlist and made the 环境安装 page reject every tool.
- Fixed domestic-platform publishing to fall back to a direct connection (Chromium-level `--no-proxy-server`), so it works with a VPN enabled.
- Fixed `scripts/gateway.ps1` missing its UTF-8 BOM — the only Chinese-containing `.ps1` without one, which PowerShell 5.1 decoded using the system ANSI code page.

### Security

- Hardened the settings and install endpoints: the install id allowlist is derived from the engine's own recipe table, and settings writes are validated server-side.
- Closed a command-injection hole in `.env` writes. The previous guard only rejected newlines, but `setup.sh` sources `.env`, so a non-newline value such as `KEY=$(id)` still reached bash's command substitution. Values are now restricted to the character set these fields actually need.
- Added a Content-Security-Policy to the 公众号 preview page. The preview iframe needs `allow-scripts` for its copy button, and an opaque origin is not enough protection because the Web API is CORS-open and unauthenticated — reproduced in a real browser, a script embedded in generated content could call a local endpoint and read the response. `connect-src 'none'` now blocks that exfiltration path while leaving the copy button and image rendering intact.

[0.2.1]: https://github.com/ZJU-REAL/Easel/releases/tag/v0.2.1

## [0.2.0] - 2026-09-18

### Added

- Added the `video-production` Skill: an end-to-end video pipeline (probe → transcribe → scenes → design table → scaffold → verify → preview → render → deliver) with two human confirmation gates and quality gates (five-piece manifest, loudness, transitions). The upstream `video-pipeline-sdk` (MIT) is now vendored into the repo so the pipeline is self-contained, reproducible, and editable. Skill count is now 114.
- Added three-tier transcription with automatic fallback: SRT/VTT subtitles first, then SiliconFlow ASR API, then local whisper as a last resort — so a run no longer requires downloading the 3GB model when a transcript or API key is available.
- Added a **「笔」capability menu** to the workbench input area: click to browse everything Easel can do ("能做的都在这"); selecting an item prefills the prompt.
- Added a ffmpeg-based slideshow renderer for image-storyboard voiceover dramas (Ken Burns, differentiated transitions, libass dynamic captions, light whoosh SFX, loudnorm).

### Improved

- Improved the Skill library display: Chinese display names shown large with the original name beneath, kept in sync across search and the drawer.
- Improved in-conversation cards to support multi-select (`ask_user` multiSelect rendering and multi-value submission).
- Improved file uploads: files exceeding the upload limit are automatically converted to local materials via a copy channel (without changing the 50MB config).
- Improved reasoning visibility: `--thinking` now defaults to medium so chain-of-thought shows when the gateway supports it.

### Fixed

- Fixed chain-of-thought (CoT) display in the Web conversation: token/thinking now streams token-by-token, and the anti-stall heartbeat no longer overrides real status.
- Fixed the Gemini adapter to support `streamGenerateContent` streaming.
- Fixed UTF-8 persistence on Windows (state read/write) and migrated the shutdown hook to a lifespan handler.

[0.2.0]: https://github.com/ZJU-REAL/Easel/releases/tag/v0.2.0

## [0.1.1] - 2026-09-15

### Added

- Added WeChat Official Account (公众号) support: article publishing, Data Center metrics, and account management via a background QR-scan session.
- Added an optional vendored typesetting Skill (`gzh-design`, AGPL-3.0), bringing the Skill count to 113.

### Improved

- Improved the workbench **创作数据** panel: Bilibili and Douyin now populate "近 7 日 · 环比" (7-day metrics with week-over-week change) and "最近作品" (recent works).
  - Bilibili reads the creator overview API for play/like/comment/favorite/share/follower deltas, and lists recent uploads (title/link/cover/stats).
  - Douyin parses the real "近 7 日" labels with a section anchor to avoid mis-reading the "最新作品" card, handles the "较前7日±X" delta format, hardens polling stability, and scrapes recent works from the content-manage page.

### Fixed

- Fixed OpenClaw version detection in `easel doctor` on Windows (the `.cmd` shim cannot be invoked bare).
- Fixed cross-platform gateway/launcher robustness and Xiaohongshu login navigation races.

[0.1.1]: https://github.com/ZJU-REAL/Easel/releases/tag/v0.1.1

## [0.1.0] - 2026-08-31

Easel's first public release, jointly developed by REAL Lab and OpenDCAI Lab.

### Highlights

- Added an end-to-end social media operations workflow covering discovery, planning, creation, publishing, and attribution.
- Added profile-driven account context and persistent operating memory across sessions and platforms.
- Added 112 executable Skills for research, writing, visual production, audio, video, publishing, and analytics.
- Added the Web workspace and CLI for running workflows, inspecting outputs, and managing projects locally.
- Added multimodal production workflows for knowledge cards, stories, lifestyle content, audio, and video.
- Added publishing workflows for Xiaohongshu, Douyin, Kuaishou, Zhihu, Bilibili, and WeChat Channels.
- Added output manifests, publishing checks, content calendars, and performance attribution workflows.
- Added Chinese and English documentation, examples, product showcases, and institutional branding.

[0.1.0]: https://github.com/ZJU-REAL/Easel/releases/tag/v0.1.0
