## 2026-10-16 · Goals and schedules implementation / 目标与定时任务首版

- Add durable original-chat goals, evidence checks, human quality approval, model freezing and cumulative execution limits; retain unknown runs without automatic replay. / 增加停止屏障、人工接管、原生工具准入和生图预留，Token/金额暂不硬封顶。
- Add timezone-aware schedules, next-run previews, pause/edit controls, missed-run policies, idempotent manual runs and original-chat history links. / 单个服务进程首版串行自动执行；编辑保留触发历史。
- Validate backend95, frontend1048, final build/lint and isolated390px light/dark keyboard/chat paths; local7880 is ready. / 真实模型/账单、138、安装器及运营指标另验。[使用及验收](docs/schedules-goals-implementation-2026-10-16.md)。

## 2026-10-16 · Schedules and goals research / 定时任务与目标方案

- Review official ZCode goal/automation/off-peak docs and pinned source; verify local OpenClaw scheduling method availability without creating jobs. / 核对独立验收、停止/续跑、持久认领及验收故障默认通过的取舍。
- Propose evidence-based goals, original-chat delivery, explicit models/budgets, cancellation barriers and one scheduling authority. / 先执行底座、再定时管理、最后运营指标；[设计及验收门槛](docs/schedules-goals-research-2026-10-16.md)。Research only; no new runtime implementation, paid calls, host138 or package changes.

## 2026-10-16 · Refined notification inbox / 通知列表精修

- Replace repeated bordered cards with compact rows, quieter metadata, direct detail actions and distinct status glyphs; preserve read state, filters, confirmation and persistence. / 调整信息密度与视觉层级，保留全部通知功能。
- Review official Linear/GitHub/Radix references and verify local real data plus isolated 390px light/dark and keyboard flows. / [调研、验收与边界](docs/notification-polish-2026-10-16.md)，仅本机7880，138/安装包不变。

## 2026-10-16 · Durable chat artifacts and image jobs / 对话产物与可靠生图任务

- Add session/turn-bound file delivery, in-chat image/isolated HTML previews, downloads, byte hashes and local dependency refresh. / 新增真实文件校验、持久交付及原对话内预览，刷新不调用模型。
- Share the dedicated image channel between workbench and runtime tools, with SQLite jobs, request deduplication, channel queues and success-receipt recovery. xjbh≤1, mlgb7≤4; ambiguous outcomes reserve capacity until explicit reconciliation. / 不自动重发或切换昂贵模型。
- Recover explicit Gateway injections and verified local structured media payloads; retain original run outcomes. / 后台交付与原轮次终态分开，旧链接只迁移可核验归属的文件。
- Validate with real temporary files, fake providers and a real browser; live provider billing/quality, host138 and packages remain unverified/unchanged. / 详见[实现及验收记录](docs/chat-artifact-iteration-2026-10-16.md)。

## 2026-10-16 · Chat artifact research / 对话产物链路调研

- Trace generated files through Gateway/Codex adapters, chat history, previews and refresh; compare official Codex events with fixed DeepSeek Harness present/version/preview sources. / 定位文字交付、预览割裂与刷新缺口，核对138原会话106次实际工具调用。
- Propose durable artifact identity/events, in-chat image/HTML previews, version/dependency refresh and shared generation jobs. Research only; no runtime change, paid call or138 deployment. / 本轮为方案；既有后端5项、链接4项通过，不代表新功能验收。[详细记录](docs/chat-artifact-harness-research-2026-10-16.md)。

## 2026-10-16 · DeepSeek Harness 对照调研 / DeepSeek Harness comparison

- Compare the official DeepSeek Harness plugin/session/Agent/job/skill architecture with Easel's OpenClaw Gateway, Web supervisor, Agent Office and ClawHub boundaries. / 对照官方 DeepSeek Harness 的插件、会话、Agent、后台任务、技能和恢复语义，明确 Easel 当前 `chat_supervisor_lost` 的差异与优先借鉴项。
- Recommend a durable run ledger and event-based recovery before considering plugin-runtime migration; no DSH dependency, model call, external plugin install, 138 deployment or installer release was made. / 优先建议补充逻辑轮次/run账本和事件化恢复，不直接移植 Cordis；本轮未引入 DSH、未调用模型、未安装外部插件、未部署138或更新安装包。[调研记录](docs/deepseek-harness-comparison-2026-10-16.md)。

## 2026-10-16 · Context windows and chat reports / 上下文窗口与拆解对话

- Separate sourced windows, configured limits and old runtime budgets; add explicit empty-field filling without rewriting manual values. GLM-5.3 reference is 1M; relay entitlement remains unverified. / 纠正默认20万与模型窗口混淆，增加来源和设置入口。
- Start breakdowns in recent chats with the shared report reader, durable recovery, stop/retry/edit and ordinary follow-up. Adopt legacy jobs without another inference request; retain drafts/history, stopped flags and inert partial backup readers. / 拆解并入对话，报告排版、证据检查和操作保留。
- Backend46 checks and the frontend1,038-case regression (one test assertion corrected and rerun) plus70 final focused checks passed; lint/build and specified390px dark/keyboard entries verified. No paid inference, deployment or package release. / 见[源码对照与验收记录](docs/context-window-chat-breakdown-2026-10-16.md)。

## 2026-10-16 · Persistent notifications and Codex usage / 通知持久化与Codex用量

- Save up to 1,000 project-local notifications with read/clear synchronization and retry; record chat/publish outcomes without an open page. Other browser-observed events retain their existing scope. / 通知保存到本机数据库，支持重试与跨标签已读/清空；对话和发布终态后端记录，其它页面观察动态不扩大为全部离线采集。
- Import actual Codex usage notifications with saved thread baselines, replay deduplication and explicit historical lower bounds; expose last-request context without inventing category tokenization or invoices. / Codex用量接入项目账本，区分累计增量、最后请求下限与上下文快照；未知费用/分类不猜填。
- Add Office return-to-chat; preserve valid replay around corrupt lines and move calendar subprocess work off the event loop. RSS source adds canonical deduplication and dated freshness filters, without enabling or deploying it. / 办公室增加返回入口，移植两项0.2.9可靠性修复；新闻修改只验证源模块。
- Backend checks, all 1,036 frontend checks, lint/build and specified actual desktop/390px dark/keyboard entries passed. No new paid task,138 activation or installer release. / 详细边界见[本轮验收记录](docs/local-history-codex-usage-2026-10-16.md)。

## 2026-10-16 · Context accounting correction / 上下文统计来源纠正

- Read current SQLite session metadata in addition to legacy JSON, scoped to project web sessions. / 修复当前运行时快照漏读，只读会话元数据、不返回提示词或凭据。
- Preserve known categories independently, including skill-directory characters and installed/session/reported counts. Do not invent totals, percentages or loaded skill bodies. / 分别显示目录字符、技能数量与来源，部分报告不再导致整组未知。
- Keep model-switch snapshots separate and explain token estimates. / 模型切换保留独立标注的上次占用，分类Token估算不等同真实分词或账单。详见[本轮验证与边界](docs/context-accounting-fix-2026-10-16.md)。仅本机7880，138与安装包不变。

## 2026-10-16 · Workbench entries and usage refinement / 工作台入口与消耗明细精修

- Integrate the image studio launch into Recent outputs with a full-width action. / 生图入口整合到最近产物卡片，增加整行触达和键盘焦点。
- Add ClawHub search/details to the composer picker, with external identity separation, abort/retry handling and a narrow-screen list/detail flow. / 创作技能弹窗增加ClawHub公开检索、详情及窄屏阅读；不安装或选中外部技能。
- Give usage a dedicated empty state, reporting coverage and overview/request tabs; make shared styles independent of the Activity page and distinguish zero recorded fees from free usage. / 消耗明细重做空态、覆盖度和总览/请求层级，修复聊天入口缺样式，明确0费用记录的口径。
- 55 distinct focused checks and lint/build passed; local HTTP and specified real-browser entries verified. Fixed desktop/390px, dark mode and complete browser keyboard checks remain pending. No paid calls,138 deployment or installer release. / 详见[本轮记录 / evidence](docs/workbench-usage-entry-refinement-2026-10-16.md)。

## 2026-10-16 · Notification refinement and night mode / 通知精修与夜间模式

- Refine event hierarchy, date grouping, unread filters, accessible status actions, empty states and deliberate clear confirmation. / 改善通知层级、日期分组、未读筛选、可访问操作、空态及清空确认。
- Add Settings → Appearance with persistent Light / Dark / Follow system, pre-paint theme initialization and cross-tab synchronization. Update shared colors and legacy office surfaces without recoloring media. / 设置新增外观，支持主题记忆、系统跟随、首屏初始化与跨标签同步，适配公共组件和旧办公室UI。
- Frontend regression, build and focused desktop/390px browser checks; no paid inference,138 deployment or installer release. / 验证边界见[本轮记录](docs/appearance-notifications-2026-10-16.md)。

## 2026-10-16 · Edit sent messages / 历史消息重新编辑

- Add inline Edit, Cancel and Send to historical user messages; sending creates a fresh branch with preceding visible context and session-owned attachment copies while preserving the source conversation. / 原位编辑历史用户消息，发送后带入此前可见文字与附件建立编辑分支，原记录保留并可返回。
- Preserve per-message skill/model/thinking selections; guard active generation, queue, storage, duplicate and stale requests. Cancel remains usable during preparation. / 保留消息配置，处理生成/队列/存储/重复及过期请求，准备中仍可取消。
- Relevant regressions, lint/build and desktop/390px browser checks completed without paid inference; local7880 only. / 真实生成尚未测试，138和安装包未更新；[行为与验证 / evidence](docs/chat-editing-2026-10-16.md)。

## 2026-10-15 · Context details and usable stop recovery / 上下文细则与停止恢复

- Move notifications to the left toolbar beside Settings; add an anchored composer context ring, six explicitly estimated/unknown categories and a cumulative usage/cost entry. / 通知移到设置旁，输入框增加上下文圆环/分类/费用入口，实际快照与累计用量分别统计。
- End orphaned replay after Web restarts and reconcile exact runs on explicit stop; retain received text/thinking, handle queued cancellation and keep Stop visible beside queue-send. / 修复重启后旧任务无限恢复及无法停止，保存确切运行标识和已收到内容，支持排队取消、请求期限与保留记录新建，输入草稿不隐藏停止。
- Frontend 1,002 tests, relevant backend regressions, lint/build and focused desktop/390px browser checks passed. No new paid generation, 138 deployment or package release. / 验证范围和已解除的真实旧任务见[本轮记录 / evidence](docs/context-usage-notifications-2026-10-15.md)。

## 2026-10-15 · Local workbench and GLM video / 本机工作台与GLM视频

- Add anonymous official ClawHub skill search/details, separate from installed skills; bound requests, cache and rate limits, and display external author text safely. / 新增ClawHub公开检索/详情，区分已安装技能，限制请求/缓存并处理限流与过期请求，不安装或执行技能。
- Add global event history with accurate outcomes and destinations, plus current-session OpenClaw usage details; Codex usage remains explicitly unknown. / 新增全局事件通知及对应入口，准确区分停止/失败/发布状态；对话复用真实用量账本，缺字段与费用口径明确。
- Save per-model context budgets transactionally, and show file/folder covers, actual birth times and consistent category counts. / 上下文窗口支持校验、清除及事务同步；内容库增加类型封面、真实创建时间与分类数量。
- Adapt dedicated GLM video credentials to CogVideoX async submit/poll and bounded public-HTTPS downloads; validate text/image inputs and failures without paid calls. / 接入GLM文生/图生异步协议与受限下载，真实视频生成待用户填写凭据后测试。
- Fix the Windows first-writer record-lock initialization race found in regression. Backend, frontend, lint/build and actual local read-only checks are recorded separately from user page acceptance. No 138 deployment or package release. / 修复Windows首次并发记录锁竞态；回归/构建/本机只读检查与用户页面验收分开，138和安装包未更新。见[验证记录 / evidence](docs/local-workbench-features-2026-10-15.md)。

## 2026-10-14 · Quick deploy verified on 138 / 138快速发布实测完成

- Activate 0.2.8 / 12f144c8 through the Windows quick entry in isolation and live with the same fixed image; verify 1388 runtime source hashes, authentication/version/gateway, official updates and preserved files. / Windows快速入口完成隔离及正式发布，同一固定镜像，1388项运行源码与认证/版本/网关、官方记录、持久文件核对通过。
- Nine isolated and eleven live actual Agent tool returns passed with matching real report downloads. Timeout causes and home trend icons/density are deployed; the user performs frontend interaction acceptance. / 隔离9次、正式11次真实工具回执无错，报告下载一致；超时提示和热点密度/图标已部署，前端交互由用户验收。见[回执 / receipt](docs/quick-deploy-138-acceptance-2026-10-14.md)。

## 2026-10-14 · Home trend density and icons / 首页热点密度与图标

- Reuse Weibo/Douyin icons and render up to five ranked topics per source; adapt columns to card width and remove forced blank space. / 复用微博、抖音图标，每源最多5条带排名，按卡片宽度切换列数并移除强制留白。
- Preserve full topic actions, cache times and per-source errors, including when all sources fail. / 保留完整标题选题动作、缓存时间与各源错误，全来源失败也显示原因。
- Forty simulated regressions, targeted lint, production build and local 7880 resource/backend checks passed. User frontend acceptance remains separate; this task does not deploy to 138. / 40项模拟回归、定向lint、生产构建及本机资源/后端核对通过；前端由用户验收，本轮未部署138。见[记录 / record](docs/dashboard-trends-2026-10-14.md)。

## 2026-10-14 · Quick deploy activation follow-up / 快速发布激活补齐

- Verify and reuse an immutable stage for the same commit instead of deleting the isolated instance's active source. / 同一提交的候选目录校验后复用，不删除隔离实例正在使用的源码。
- Wait for Compose health before the HTTPS probe, and print the matching isolated or production rollback command. / 激活后等待容器健康再请求HTTPS，回滚命令对应正式或隔离环境。
- Resolve Git commit braces correctly in Windows PowerShell; upload an UTF-8/LF Bash runner and support the host's legacy Docker builder. Reuse a recorded fixed runtime only when every dependency input matches, while rebuilding application source and frontend. / 修正Windows提交解析、上传UTF-8/LF远端脚本、兼容旧Docker构建器；仅依赖全部一致时复用固定运行镜像，完整重建应用与前端。
- Keep user frontend acceptance separate from logic and deployment checks. Actual activation receipts follow the runbook. / 前端交互验收由用户完成，逻辑与发布回执按运行手册单独记录。

## 2026-10-14 · Google News timeout cause / Google News超时原因

- Confirm the screenshot failure with the original SQLite tool receipt and a bounded live-container network probe. / 从原始SQLite工具回执及容器网络探测确认Google News请求超时，无HTTP响应；未重新部署。
- Recognize the exact OpenClaw API timeout wrapper and show a short cause on folded failed fetch rows; retain external-body filtering. / 精确识别OpenClaw API超时包装，折叠失败行显示“网页请求超时”，保留外部正文过滤。
- 17 focused frontend checks and TypeScript passed. Document the limits of the repeated homepage search results and the lack of implemented freshness filters. This source fix is not deployed to 138. / 17项定向前端检查及TypeScript通过；记录重复主页结果和未实现时效筛选的边界，本提示修复尚未部署138。

## 2026-10-14 · Runtime repair and version assessment / 工具修复与版本评估

- Show the selected OpenClaw version and official latest release, with bounded official changelog evidence for Agent upgrade advice; keep existing chats and drafts. / 显示当前运行版与官方latest，Agent基于官方来源评估收益、风险与建议，不自动升级。
- Give accurate skill/reference paths and independent-command guidance; install curl/file and pinned official search support, and connect a dedicated authenticated sandboxed Chromium container. / 修复路径与命令规则，补工具/搜索与独立浏览器；真实隔离及正式验收待回执。

## 2026-10-14 · 138 quick deploy / 138 快速发布

- Add a Windows PowerShell/CMD entry that exports a selected committed SHA, verifies the release archive remotely, builds the fixed Docker image and leaves a candidate by default. / 增加 Windows PowerShell/CMD 快速入口，固定提交导出、远端校验并构建镜像，默认只留下候选，不切换正式服务。
- Require explicit `-Activate` for the remote stop-write backup and service switch; keep credentials, OpenClaw state, browser profiles, cookies and personal outputs outside the archive. / 正式停写备份和服务切换必须显式 `-Activate`；凭据、OpenClaw 状态、浏览器 profile、cookies 与个人产物不进入发布包。
- Document SSH/SCP prerequisites, isolated-test usage, HTTPS login probing and rollback boundaries in [the quick deploy guide](docs/deploy-138-quick-start.md). / 在[快速发布说明](docs/deploy-138-quick-start.md)记录 SSH/SCP 前置条件、隔离验收、HTTPS 探针和回滚边界。

## 2026-10-14 · Local quick start / 本机快速启动

- Add a double-click CMD/PowerShell entry for the installed local project, defaulting to port 7880 and existing data, with verified instance reuse, browser opening and visible failure/log guidance. A small script ZIP is separate from a portable application. / 新增可双击本机快速入口，复用现有服务并打开页面，支持单独解压后定位本机项目和自定义路径；小包仅含脚本与说明。
- Allow an explicit bounded gateway startup timeout; the quick entry waits up to 900 seconds to cover observed cold starts beyond the previous 300-second limit. / 增加有限的网关等待参数，快速入口等待15分钟，处理本机冷启动超过5分钟的实际情况。
- 115 focused startup/endpoint/path checks and PowerShell syntax passed. Actual CMD reuse from System32 and an extracted Unicode path, missing-project errors and ZIP CRC/bytes passed; HTTP and the existing real browser page confirmed gateway readiness. Cold restart was not performed. / 115项定向检查及实际入口/解压/错误提示/小包校验通过，HTTP和真实页面确认服务可用；未重启当前服务或调用模型。

## 2026-10-14 · Upstream comparison / 上游对比规划

- Compare upstream v0.3.0 / `bb3c8ff0` with saved candidate `cd866910`; document shared product direction, strengths, source evidence and phased acceptance. Prioritize the existing 0.2.8 release, then reliability fixes, shared paths, a real-file gallery and adapted runtimes. / 完成逐主题对比与分批验收计划，先收口候选部署再吸收可靠性修复；路径、画廊和引擎另批适配，保留创作者工作流与持久执行证据。
- Synchronize bilingual project/report links and progress; correct candidate-source status and retain the latest verified server identity as 0.2.7/build `1a324540854c`. Historical candidate checks: 131 focused backend and 962 frontend tests passed. Upstream Release assets: zero. This is a documentation delivery, with no new runtime implementation, server switch or package release. / 同步双语入口与进度，区分已推送候选、历史自动化证据及实际运行发行；本次未部署或发布安装包。

## 0.2.8 candidate · 2026-10-13

- Synchronize compact Settings, dashboard, image studio, skill recommendations, analysis/office and tool presentation with their backend modules.
- Display server mutation capabilities accurately; keep desktop installation/storage controls unavailable in read-only deployments.
- Distinguish collection environment failures from login failures, decode tool wrappers, isolate startup credentials and keep the web UI accessible when the auxiliary device check fails.
- Add curl and pinned official DuckDuckGo search support; candidate configuration preserves existing credentials and permission policy. Actual search/browser and production acceptance remain in progress.
- Version 0.2.8 is a candidate until isolated and production checks are recorded. Portable packaging stays paused.

# 2026-10-13

- Investigated 46 real web-research calls: 18 explicit failures, eight curl pipelines masking missing curl, and 20 nonempty HTTP200 fetches. Added concise failed-row reasons, source/limited-retry/command rules and curl to the Dockerfile; 15 DOM/3 message checks and TypeScript passed. No server change or new release; search provider and native browser remain to be verified. / 核实多次网页失败，补失败短原因、真实来源与失败换方法规则、镜像curl依赖；搜索未配置/404/安全拒绝/命令缺失分别留证，源码检查通过但未部署。
- Added a deployment summary covering the current release, missing local changes, platform boundaries, one-commit frontend/backend build, candidate checks, backup/activation and runtime feature reconciliation. This records the next release plan without claiming it has been deployed. / 新增部署总结：当前可用能力、遗漏改动、平台适用范围、统一提交构建、候选验收、备份切换与功能对账；仅形成补齐方案，未执行新发布。
- Correct deployment scope after read-only browser/HTTP comparison: server v0.2.7/build1a324540854c is a fixed release and excludes uncommitted local UI. Local Settings grouping, compact bottom image entry/account-analysis placement, skill recommendations, compact tool presentation and the user-provided OpenClaw SVG are not yet synchronized to138. This comparison deployed/restarted nothing; prior authenticated model/file delivery evidence remains valid. / 只读核对确认138固定发行未包含本地未提交UI，不能称全部最新功能已同步；原登录/模型/文件交付证据保留，本次未部署或重启。
- R123 version visibility shipped in v0.2.7/build `1a324540854c`: sidebar footer, release-manifest SHA details, authenticated/no-store `/api/version`, development fallback and focus refetch. Refresh still loads updated interface code. API 401/200/no-store/development=false, real browser refresh/details/Escape/390px, 25 backend/38 frontend focused tests, tsc and production build passed (existing chunk warning). Runtime image/source/ZIP identities are recorded in the deployment docs. / R123版本可见已随v0.2.7部署：侧栏版本、manifest构建SHA详情、认证且no-store版本接口、开发环境回退与focus重读；更新界面仍需刷新，接口/浏览器/390px/定向检查/tsc/生产构建通过。运行镜像、源码和ZIP身份见部署文档。
- Current deployment is `1a324540854c4fe082ee30ec0256942b8c6ef5da`, image `sha256:ac2b0d6e96ebd4250686380d82520d9498df3a20444154bb370b4dba3556bc8f`, source `/home/ubuntu/Easel.new.1a324540854c`; formal snapshot `/home/ubuntu/easel-backups/20261013T092340Z.tar.gz`. Committed ZIP: 1,527 source files, SHA-256 `a897350bfef7273c716185bca26f0e47e9cae37622571dd50db068e6ef5f9ac9`. Image/production/isolated 1,355 runtime-source hashes passed, both environments Healthy/zero restarts with actual login/Gateway. Original 159-byte artifact, preview/attachment/hash persist; this update did not repeat model calls. Runtime release pushed/remote SHA matched; later documentation commits and main README-only sync remain separate. / 当前v0.2.7运行发行/镜像/ZIP及1355摘要通过，两环境健康、认证/网关通过，原产物持续保留；本次未重复模型调用，运行SHA推送一致，后续文档/main首页同步独立记录。
- Deployment follow-through (R119–R122): the independent HTTPS entry, authenticated HTTP APIs, trusted browser login/chat and a real OpenClaw skill/terminal/file task passed. The saved file survived an app restart and authenticated download matched its SHA-256. Use the user-authorized internal runtime account override with normal salted scrypt; no default account is embedded in source or images. / 部署收口：独立HTTPS入口、认证HTTP接口、可信浏览器登录/对话及真实OpenClaw技能/终端/文件任务通过；产物在应用重启后保留，下载SHA-256一致。采用用户明确指定的内网运行时账号覆盖，保留正常随机盐scrypt，不在源码或镜像植入默认账号。
- Correct OpenClaw 2026.9.6 deferred-tool discovery for compatible custom models through `tools.toolSearch: false`, preserving existing explicit preferences. Two real `web_fetch` receipts returned HTTP 200 for JSON and HTML; configuration validation passed without warnings. / 修正OpenClaw延迟工具发现兼容：新配置提供直接工具schema，保留既有显式偏好；真实web_fetch读取JSON和HTML均HTTP200，配置验证无warning。
- Normalize empty/invalid content-library filters to `all`, retaining valid categories and legacy `imagegen → image`; four focused regressions passed. The preceding `c35e9851` upgrade reused the verified fixed base after confirming unchanged dependency inputs, then layered the new source and freshly built frontend. All 1,351 runtime-source hashes, production/isolated health, actual login, Gateway, persistent-file HTTP bytes and browser All/project/HTML-marker preview passed. / 内容库空值/无效筛选归一为全部，保留有效分类和旧生图映射，4项回归通过；先前c35e9851升级在依赖输入全一致核验后复用固定基础镜像，加入新源码和新版构建前端。1351个运行源码摘要、正式/隔离健康、登录/网关/持久文件HTTP字节及实际浏览器全部分类/项目/HTML预览通过。
- Add explicit attachment responses for downloads while retaining inline media previews. Earlier artifact release `8b6bcea7a09a13e2598e44874a3b5cdddcc42a51`, image `sha256:e35e5e74f9b20e5ba1b4b9587e68db4e22f0010da462ed56f6e4f96fe86cbc24`, activated from `/home/ubuntu/Easel.new.8b6bcea7a09a` with snapshot `/home/ubuntu/easel-backups/20261013T084803Z.tar.gz`; activation logged Healthy. Actual browser attachment download passed: 159 bytes with SHA-256 `d5b98a0721b00dd9521566e174f0579d5c07f9cfa6d5498f6d1185a00cfe757e`, matching host/container originals. Live checks confirmed the exact production/isolated image, Healthy/zero restarts and all 1,351 source hashes. Direct original-file URL opening in a real browser tab passed; the clicked target-blank tab was not exposed by IAB, so that observation remains unverified. Later documentation commits are distinct from the runtime release. / 下载提供显式附件响应并保留媒体内联预览；最终固定版本激活日志Healthy、真实浏览器159字节下载及SHA-256核对通过。实时版本与原文件URL直接浏览器打开通过；链接点击target-blank页未被IAB暴露，保留观察边界，后续文档提交不改变运行版本身份。
- Keep original D01–D12 gates and explicitly deferred recovery, rollback, full-menu/390px, resource and platform/media checks. Codex remains disabled; portable packaging remains paused. The entries below retain earlier implementation-stage evidence and do not describe current deployment status. / 保留原D01–D12及用户延后专项，Codex禁用、便携打包暂停；以下早期实施记录为历史证据，不代替当前部署状态。

- Let OpenClaw 2026.9.6 create its native SQLite identity and wait for the explicit startup-sidecars transient state. Temporary Linux Gateway/bridge startup and fixture persistence checks passed. Separate Python installation from browser downloads and select a measured faster Playwright mirror; actual deployment acceptance remains pending. / OpenClaw原生管理SQLite身份，监管程序等待明确的启动附属进程临时状态；临时Linux网关/桥接及数据保留检查通过。拆分Python安装与浏览器下载层，采用测速更快的Playwright镜像，正式部署验收待完成。

- Make Linux release ZIP/receipt writes atomic, include npm/npx in the image, use a faster integrity-checked npm mirror and add installed-source hash verification. The previous image build exited 137; no running Easel service is claimed. / Linux发行ZIP/回执改为原子写入，镜像补齐npm/npx，使用仍校验锁文件摘要的npm镜像并新增运行源码核验。前次镜像构建退出137，尚无已运行Easel服务。

- Pin the patched MCP SDK and refresh frontend dependency locks after verified npm audit findings; both lock trees now report zero known advisories. Correct TLS file mapping, persist the Linux HOME/browser directories and create an independent Ed25519 device identity without copying desktop state. Image/server compatibility remains under verification. / 根据实际npm审计锁定修复后的MCP SDK及前端依赖，两处依赖树当前均无已知公告；修正证书文件映射、Linux HOME/浏览器持久化与独立Ed25519身份生成，继续核验镜像及服务器兼容性。

- Begin authorized independent Linux deployment: full Python/OpenClaw locks, nonroot image, supervised Gateway/Web, persistent data/browser/identity paths, authenticated HTTPS access and backend-completion admission. Add commit-only source ZIP hashes, independent IP CA/certificate, snapshot and image rollback tools. Eleven local tests passed; actual image/server/model/browser acceptance remains pending. Codex is disabled and portable packaging stays paused. / 开始已授权的独立Linux部署，增加完整依赖锁、非root镜像、进程监管、数据/浏览器/身份持久化、HTTPS登录认证与随后台完成释放的限流；发布工具只导出指定commit并核验摘要，支持独立IP证书、快照和镜像回退。11项本地检查通过，镜像/服务器/真实调用/浏览器待验，Codex禁用，便携打包暂停。

- Show the actual thinking level in home/chat composer triggers, retain the original slider, keep one auto option and omit the duplicate model row. Portal positioning prevents sidebar overlap; remove persistent keyboard hints without changing key handling. / 首页和对话入口直接显示思考档位，保留原滑条，只留一个自动选项，移除重复模型行；独立浮层避免侧栏遮挡，删除快捷键常驻提示并保留按键行为。
- Verification: 62 related simulated checks passed; after updating an outdated accessible-value assertion, all 16 thinking-control checks passed. Production build and lint completed with warnings; real-browser checks covered home/chat, expanded-sidebar overlap, 390px bounds, trigger toggle and Escape. Other interface changes remain separate work; no model call or package. / 相关模拟检查62项通过，修正旧无障碍值断言后思考控件16项复跑通过；构建/lint完成并保留warning，真实浏览器已检查首页/对话、展开侧栏、390px边界、点击开关和Escape；其他整改继续，不调用模型、不打包。

- Define 12 deployment tasks with dependencies, release artifacts, authentication and persistence checks, OpenClaw acceptance, optional Codex, ZIP/image verification, rollback gates and separate production authorization. Implementation and deployment remain pending.

- Document the proposed independent Easel deployment on 192.168.0.138, based on the AI-skills runbooks, read-only host capacity/port/health checks and local Codex metadata. Cover Linux dependencies, authentication, persistent state, ZIP checksums, image rollback and acceptance gates. Codex is optional; no specific model blocks deployment. No production changes, package, model request or deployment acceptance was performed.

# 2026-10-12

- Compact the composer controls: icon-based OpenClaw/Codex selector, a stable “Thinking strength” trigger, model-adjacent status dot with accessible channel/inference details, and an explicitly marked OpenClaw sidebar gateway indicator with guarded backoff reconnect plus manual retry. Add icons to the content-library filters while keeping generated images under the shared Images category with their AI-generated tag. Production build passed; packaging remains paused and no live model request was made.

- Refine execution into compact icon/summary rows with expandable evidence, ordered progress and durable journal recovery. Remove duplicate progress and the Codex outer card; preserve failure states, approval/question controls, copies, paging and artifact verification. Explicitly separate legacy operations without shared order.
- Disable skill completion with no selected skills; preview is distinct from selection. Merge generated and ordinary images into one Images filter with an AI-generated tag and compatible studio/legacy entries.
- R86–R88 verification: 42 frontend and 62 backend focused checks passed; build/lint completed with existing warnings. Real isolated Chromium verified desktop/390px, keyboard/copy/live updates/paging, actual file navigation, image preview/download, studio history and Codex approval controls. Actual journal HTTP restore passed; engine/turn/gallery metadata were simulated, with no model, paid service or submitted approval. Source 7880 restarted successfully; packaging remains on hold.

- Implement shared OpenClaw/Codex execution cards: readable command summaries with full command/cwd/exit/output details, background-process receipts, coexisting file diff/output, separate copy controls, filters and operation pagination. Verify artifacts before linking to the library and include public root-level output files.
- Normalize and persist tool evidence, stream scoped execution events with snapshot fallback, keep terminal receipts over late running updates, separate commentary/plans/reasoning/final text, and mark unfinished evidence unconfirmed after interruption without replaying model requests. Preserve and integrate existing Codex runtime, timing and highest-supported effort work.
- Execution verification: 112 focused backend and 102 frontend tests passed; production build/lint completed with existing warnings. Real isolated Chromium verified keyboard/copy, filters/paging, live-state preservation, actual local artifact navigation and 390px with no page errors or write requests. Engine events were simulated; no live model or paid service was invoked. Packaging remains on hold. See `docs/execution-experience-implementation-2026-10-12.md` for remaining recovery/browser/office work.
- Record the user's packaging hold and a source/archive/official-document assessment of desktop options and gaps against ZCode and DeepSeek Harness. The roadmap prioritizes artifact/configuration contracts, recovery, measured startup/runtime slimming and browser integration before a desktop prototype. No new package, framework migration or change to the Codex integration plan.
- Fix navigation from Settings to Chat: activating the Chat rail entry now switches the main page and reveals the conversation list together; repeated activation keeps the selected session. Other navigation retains its compact-sidebar behavior.
- Replace skill execution in the details drawer with a conversation handoff: retain input and selected skill in a new draft, preserve existing drafts, and send only from the composer. Missing API configuration does not block opening a draft.
- Attach credential-free skill configuration status and exact runtime/configuration paths to chat and the legacy skill API, including image skills selected by the Agent. Setup instructions are not evidence of a missing key; offline presence is not proof of a successful API call.
- Connect output-path conversion to assistant replies, check local targets through `/api/output-status`, and disable missing/unverified links with a recheck action. Existing absolute paths under outputs map to the content library; external sources retain their URLs.
- Add `save_artifact.py` for local-file copies and HTTP(S) downloads into persistent topic directories. Reject empty/oversized files and overwrites, clean partial downloads, and support portable filesystems without hard links. Portable workspace guidance requires actual saved files before delivery.
- Verification: 53 focused frontend checks passed, with the changed link checks rerun (6 passed); focused backend checks passed, including the final artifact/configuration subset (25 passed), and portable regressions passed (104 passed / 1 skipped). Production build and lint completed with existing warnings. Real isolated Chromium verified chat navigation, skill drafts/reload, Word downloads, HTML preview/download, missing links and 390px handoff; actual local HTTP downloads and data-directory relocation passed. No new real model/paid image request or rebuilt portable ZIP; the previously missing Word file is not recovered.

## 2026-10-10 最新便携交付回执

- **本轮可交接文件**：`dist/portable-20261010/Easel-preview-2f1818d-c38a.zip`，Windows x64 便携预览版，1,169,390,503 字节。完整解压到短、可写目录（如 `C:\Easel`），再运行 `Easel.exe`；也可使用启动/检查/停止 CMD。
- 固定源码：`2f1818d4d11d0ea09968fb1e83af76a90a30a1c1`；`sourceDirty=false`、仅Git跟踪文件，ZIP内`data/`为空，不含用户Key、平台登录态或个人作品。后续交付文档提交不会改变此ZIP来源。
- SHA-256：`6407d221b4ff92a9d25f02c0906b06da3c66310829558484b3b8f469eeaf765b`；同目录 `Easel-preview-2f1818d-c38a.zip.sha256` 可校验。
- 检查：最终全量前端 **916通过、0失败**，npm ci/lint/生产构建完成；账号及便携后端250通过1跳过（此前定向结果，不当作后端全仓全量）。三处旧导航/图标断言已修正，相关20项复跑通过。
- 构建换行回执：prebuild仅将生成JSON的CRLF改为LF，内容与HEAD一致；恢复原源码后跳过重复生成再次编译，生产产物逐字节一致，源码/产物哈希重新验证通过，未修改测试结果。
- Windows路径回执：长临时目录触发网关依赖文件路径限制，首次装配中止且未产出ZIP；改用短构建路径完成后移入dist。使用时仍须完整解压到短目录（如`C:\Easel`），不要使用多层嵌套交接目录。
- 打包性能回执：对已复制文件逐项对比源/目标SHA后复用，后续复制仍使用原装配器；文件哈希改12路并发，归档前完整清单、路径/链接、逐文件SHA保护均保留。运行脚本为本次构建辅助，不修改发行源码。
- 归档性能回执：保留已完成的压缩条目并重建ZIP中央目录（先通过小样本恢复检查），剩余文件12路读取、按顺序压缩，整包解压逐条CRC检查；不把未关闭的中间ZIP交付。
- 包体实测：归档前每文件SHA校验、ZIP SHA-256、完整解压CRC/文件清单与关键入口/前端SHA校验、空data首次启动、首页及API/静态资源HTTP、真实浏览器入口跳转通过；独立副本停止→重新启动→停止通过，原7880工作台仍可访问。界面入口明细另见交付验收单；不将HTTP检查当作浏览器操作。
- 手册、checklist与验收单已更新，dist同目录提供当前手册；包内文档固定于构建源码。全新Windows机器和原生GUI双击尚未实测；其他平台真实投稿、付费生成及SMTP未扩展验证。小红书此前唯一授权投稿经用户App确认公开正确，自动网页读回仍未知，未重复发布。
- [x] 本轮全量前端检查、便携归档、空数据首启、隔离启停与浏览器入口验证完成。
- [x] 运营手册、用户checklist及dist交接文件同步完成；源码和交付文档的Git回执分别记录。

以下保留历史迭代记录；涉及旧候选或“尚未打包”的旧描述由本回执覆盖。

## 2026-10-10 打包前收口

- 模型图标：生图/视频当前模型复用厂商图标；gpt-image-2显示OpenAI，未知模型通用图标。真实桌面与390px未遮挡、页面无横向溢出。
- 对话：超过3轮才显示左侧节点；工具执行摘要10px、实测22px行高；回到底部操作保留。
- 模型刷新不再插入“读取中”文字，保留已有选项；思考强度依据声明自动匹配可用档位，黄色info只hover/focus解释。真实Grok由高自动切关闭，悬停提示通过，测试前模型/强度已恢复，未发送请求。
- 登录：缓存保留原在线时间，失败/未知标记待确认，迟到结果不覆盖新身份；B站过期Cookie保留但不再视为有效，确认恢复后回正。公众号浏览器会话与AppID分离。
- 发布前逐平台强制只读在线检查，检查阶段和spinner可见；失效/未知/超时跳过该平台，保留草稿，连点不重复检查；确认提交前再比对账号快照。
- 真实小红书只读检查：有效，已显示上次确认时间；视频号/知乎未连接，快手/抖音无法确认；不将未知当退出，不重新扫码、不重复投稿。此前唯一授权发布由用户App验收通过，网页自动核实仍未知。
- 验证：定向前端95项及缓存3项通过；账号/便携后端250通过1跳过（包含原146项，不重复累计）。生产build/lint通过，保留既有warning。新便携包的全量前端、解压校验和空data启停结果另记。
- 最新授权：完成即打包到dist，明确可交接ZIP/SHA256与运营手册；旧等待签收约定已被覆盖。全新Windows/原生GUI双击/其他平台真实发布/付费生成/SMTP不报通过。

## 2026-10-10 · 上游兼容补漏与运营收口 / Compatibility and operator handoff

- 画像创建入口使用统一名称校验；新增7项非法名称拒绝回归，不写文件、不启动模型。
- 移植34项上游凭据镜像回归，保留独立 relay 渠道与隔离测试配置。
- workspace 同步先替换硬链接，再拷贝并核对单链接；技能删除防空路径，三项原生 Git Bash 隔离检查通过。
- 合并远程字体请求并非阻塞加载；错误页按钮颜色跟随主题。
- 新增上游四项链接语料回归；兼容报告记录78路径映射及未整批采用的上游新能力。
- 整理运营手册与最新源码验收单；主动问答/刷新和引用指针 hover 已取得真实浏览器证据。小红书唯一发布由用户 App 核实公开且内容正确，自动读回仍未知。
- 相关后端385 passed /1 skipped、兼容前端19 passed；办公室58项单记，生产构建/lint通过（既有warning）。历史全量结果不冒充本源码最终全量。

## 2026-10-10 · 办公室区域、显式漫游与窄屏卡片

> **2026-10-10 区域与窄屏补验**：办公室新增工作/茶水/休闲/健身/卫生间近看入口，健身植物及卫生间相机遮挡已修；真实浏览器五区域、键盘Enter、员工近看/全景复位及390px布局通过。显式开启的独立模拟角色沿外围过道漫游，实测移动、暂停位置不变、关闭移除，不改变真实成员任务与状态。办公室↔运行记录核对同一已完成会话与轮次。390px技能说明滚轮到434px末尾，卡片修复后146px、列表无横向滚动；触摸设备未测。发布中心390px小红书/知乎切换仅显示一个预览，已恢复小红书单选，未预检或再次投稿。58项相关前端检查（25场景/漫游/重试、33办公室页面/任务焦点）、生产构建及lint通过（既有warning）。主动提问完整链路、上游兼容报告和真实业务未签收项继续；未打包。

> **October 10 office and narrow-screen verification:** five camera views cover work, coffee, lounge, fitness and washroom areas. Plants and the washroom camera were adjusted after real occlusion checks. Real browser checks passed for the five areas, Enter navigation, employee close-up/reset and 390px bounds. An explicitly enabled simulation mascot walks the perimeter; movement, a stable paused position and removal on close were verified without changing observed task/member states. Office and activity views matched the same completed chat and turn. At 390px the skill details scrolled to the 434px end, cards fit their list, and switching Xiaohongshu/Zhihu kept one preview visible. The original platform selection was restored; no new submission was made. Touch hardware remains untested. All 58 relevant frontend checks, build and lint passed (existing warnings). Full question/answer execution, upstream compatibility and outstanding live-business acceptance remain pending; no package was built.

## 2026-10-10 · 跨作品解读失败分类与真实引用入口 / Analysis failures and quote selection

> **2026-10-10 跨作品解读与引用修复**：真实 deepseek-v4-flash 请求在3000 tokens预算下返回 finish_reason=length、空正文，其中2647 tokens用于思考；原提示误将截断归为无依据结论。预算改8192，区分截断/空正文/JSON解析/事实校验失败，在解读区显示具体原因和重新生成入口，成功后保持面板展开；失败不覆盖已有有效结果。真实页面生成并保存5条基于标题的解读（正文与指标缺失，不能做效果归因）。再次进页自动采集产生新观察时间，旧解读按既有材料版本规则失效；已保存数据仍留在库中，未重复请求模型。引用按钮保护选区快照，真实双击选取→点击→加入草稿已通过；info键盘聚焦、与展开引用互斥及Escape通过，真实鼠标hover仍待验。75项后端、34项前端定向检查、build和lint通过（既有warning）。其余迭代继续，便携包暂停。

> **October 10 analysis and quoting fix:** a real deepseek-v4-flash call exhausted the former 3,000-token budget (2,647 reasoning tokens, length stop, empty answer). The budget is now 8,192. Truncation, empty text, JSON parsing and evidence rejection have distinct errors, with an analysis-specific retry and an expanded result panel. Failed generation preserves an existing valid result. The real page saved five title-based observations; bodies and metrics are missing, so performance attribution is unsupported. A later automatic collection created a new observation timestamp and invalidated the old interpretation under the existing version rules, without deleting its stored row or repeating inference. Real selection-to-quote insertion and keyboard tooltip checks passed; real pointer hover remains unverified. All 75 backend and 34 frontend focused checks, build and lint passed (existing warnings). Remaining work and portable packaging are pending.

## 2026-10-10 · 技能状态同行与折叠标题对齐 / Compact skill metadata and disclosure alignment

2026-10-10 界面密度与标题对齐：技能列表的配置状态与能力徽标放入同一紧凑行，真实窄屏空间不足时自然换行；活动摘要与模型思考共用14px SVG箭头、9px间距及等高标题。桌面与390px真实浏览器确认标题文字/箭头横坐标一致，点击及Enter展开/收起正常；桌面技能标签中心线一致，390px无页面横向溢出。35项定向检查、生产构建和lint通过（既有warning）。旧未完成项继续，便携打包暂停。

October 10 density and alignment: skill setup status and capability badges share a compact row, wrapping only when narrow columns run out of space. Activity and reasoning headers share a 14px SVG chevron, 9px gap and equal row height. Real desktop/390px checks confirmed matching icon/text positions and click/Enter toggles; desktop skill badges align and 390px has no page overflow. All 35 focused checks, build and lint passed (existing warnings). Remaining iteration work and portable packaging are pending.

## 2026-10-10 · 队列连续执行与输入交互 / Queue continuation and composer interactions

> **2026-10-10 输入与队列补充**：引导成功后自动接续剩余消息，空闲引导直接发送，运行中先等停止确认；手动停止、发送失败或缺素材仍暂停并保留消息。空闲回到底部显示箭头，运行中显示三点并在hover/focus时切换箭头。已选技能增加类型icon，附件提供图片缩略图/大预览与文件名/格式；“＋”可添加媒体、文件、文件夹素材或打开技能选择。生图/视频比例增加真实宽高示意，提示词输入与思考强度灰色区段增强辨识。引用info改为临时hover/focus提示，与展开引用互斥，Escape关闭。旧标签页切页失败定位为重建删除旧模块，预览构建已保留旧哈希资源；不刷新旧页面实际打开工坊成功。109项定向检查、生产构建和lint通过（既有warning）；真实队列自动取得“引导后继续正常”“剩余队列自动继续正常”。桌面/390px附件与菜单、图标、比例、输入已检查；引用hover属组件检查，尚无真实浏览器选择引用复核。旧未完成项继续保留，便携包仍未生成。

# Changelog

Changes maintained by [StarrySea1412/Easel](https://github.com/StarrySea1412/Easel) are documented here, with earlier upstream history retained. Current feature development is on `codex/creator-workflow`.

## [Unreleased]

### 2026-10-12 Codex execution experience assessment / 执行过程对标规划

- Document official Codex item/reasoning/command/diff events and audit Easel's OpenClaw snapshots plus the existing Codex integration workspace without changing its plan. / 核实官方执行事件，对照现有 OpenClaw 快照和 Codex 工作区；不改接入计划。
- Record display and state gaps: small truncated command titles, bounded history, output hidden by diffs, and missing process exit/background-session details. Prioritize unified operation cards, live events, file review and recovery. / 记录命令可读性、历史限额、diff 与输出互斥及进程状态缺口，规划统一操作卡、实时更新、文件审查和恢复。
- Real Chromium inspected the existing desktop/390px UI with simulated records; no live model/tool task or new UI implementation. Packaging remains on hold. / 真实浏览器仅检查隔离模拟记录，无真实模型/工具任务、新 UI 实现或打包。

### 2026-10-10 paused guidance and queue menus / 暂停引导与队列菜单

- Move the narrower queue above the composer; send the selected idle message without a stop request and retain paused neighbours. / 内收队列移至主输入框上方；空闲引导直接发送所选消息，邻居仍暂停。
- Make menus exclusive with outside/Escape dismissal and explain resume blockers. Actual App sequential-dispatch and menu regressions pass; a real chat confirmed idle guidance and queue resume at 390px. / 更多菜单互斥并支持关闭，继续排队说明阻止原因；实际App发送回归及真实390px短回复完成。

### 2026-10-10 publishing workspace and queue follow-up / 发布与队列追加整改

- Reorganize publishing into shared editing/media and a single platform-tab preview with independent versions; retain per-platform preparation, progress and durable receipts. Confirmation explicitly identifies excluded targets. / 共享编辑与单平台标签预览，分别显示平台准备与进度，确认框列出未提交平台。
- Persist selected media order, preview the cover/video, support image reordering, and add loading feedback. Precheck suggestions must not invent performance claims. / 保存媒体顺序，增加封面/视频预览、图片排序与 loading，预检禁止编造收益承诺。
- Preserve a read-only Xiaohongshu candidate preview through the follow-up worker without claiming submission identity or public success. / 只读核实保留候选预览，但不据此宣称公开发布。
- Keep tool navigation on one line and scroll overflowing tabs. Restored queues stay paused without a permanent informational error; dragging moves the entire row while neighbours make room. / 导航不换行；恢复队列保持暂停，整条拖动带相邻让位。
- Focused checks: frontend publishing/storage/receipts 80 passed, queue/steering 14 passed, backend receipts/readback/follow-up 222 passed; build and lint passed (existing warnings remain). Desktop browser evidence is recorded; 390px override did not take effect, so this iteration's mobile check remains pending. No new portable package.

### 2026-10-10 composer, channels and public Zhihu ranking

- Compact queued rows follow the pointer as a whole, retaining an empty source placeholder and animating actual reorder only. Redundant move-up/down menu entries are removed. Editing reuses the main composer; one primary action switches between stop and queue-send.
- Guidance stops the active turn, waits for confirmation and continues with the exact selected message while retaining paused neighbours; failure preserves the queue. The tooltip states this behavior and responds to viewport/layout changes.
- Quick pinning and chat previews distinguish selected skills from actual execution evidence. Quote drafts retain their source independently until submitted. Gateway thinking declarations use a small info control, and visible thinking counts are explicitly estimated tokens.
- CC Switch display names persist by exact channel identity and are editable. Initial status reads only the model list; click-to-open details avoid duplicate hover tooltips. Historical usage retains its original channel label.
- Return-to-latest shows animated dots and a down arrow on hover/focus. Publication receipts no longer occupy every page header. Error avatars settle into a visible held pose.
- Zhihu public question ranking replaces the rate-limited 60s endpoint as primary; 60s and explicitly configured DailyHot instances remain fallbacks. Only observed heat/question creation time is retained, without fabricating ranking update timestamps.
- Actual desktop and 390px browser checks and remaining real execution boundaries are recorded in the checklist. No new installer/package has been built.

### 2026-10-09 conversation nodes and execution feedback

- Left-side ticks preview the user question and same-turn reply; streaming data updates retain the preview. Keyboard navigation, Enter jump and Escape dismissal are supported.
- Empty execution lists preserve backend warnings and retry; errors and late responses are isolated by session and turn.
- 28 focused repository checks and production build passed. Actual desktop and 390×844 browser checks passed; user acceptance is pending before packaging.

### 2026-10-09 conversation execution and accounting

- Native gateway RPC preserves exact session, model and thinking selection; final authoritative text corrects out-of-order streaming output without resending a paid request. Real DeepSeek/Kimi/Grok short replies and a browser queue continuation were observed.
- Per-chat queues retain text and model/skill snapshots, support edit/reorder/remove/pause, and pause on failures or reload. Attachments must be reattached after reload. Next-turn queueing is explicitly distinguished from unsupported live steering.
- Compact expandable tool rows show actual receipts, elapsed time and successful file diffs. SQLite transcripts, including bounded zstd events and fresh-session generations, are read without database mutation; skill audits and the office use the same turn boundaries.
- Usage reads the current project's JSONL/SQLite records idempotently. Channel quotes use decimal four-bucket pricing and a final multiplier, retaining per-request rate provenance. Stream speed and wait-inclusive log estimates follow CC Switch eligibility thresholds and weighted aggregation; missing measurements/prices remain unknown.
- Image workbench readiness uses dedicated IMG_* settings. The offline `check --dedicated-channel` does not borrow chat credentials or claim network availability. Visual skills proactively propose an AI artwork and deterministic layout workflow; model-generated advice still requires receipt-based validation.
- Only Ultra uses purple particles; model cards start collapsed, health actions belong to each card, logged-in account actions are gated by confirmed account state, and skill removal closes its hover guide.
- Core affected backend checks: 399 passed, one environment-specific skip; frontend: 842 passed. Actual browser evidence and remaining operator/business checks are kept in the checklist. No new installer release is claimed.


### 2026-10-09 R46–R65 follow-up: clearer setup, QR login and navigation / 配置、扫码与导航追加整改（交付收尾）

- Combine imports with model configuration: show saved versus pending defaults, keep Save and use nearby, and fold CC Switch/OpenClaw previews into the same page. Clicking a detected source reads candidates; explicit confirmation writes the selected slot. Preserve other drafts and compatibility for old import links. / 导入集中同页，来源卡点击即预览，确认才写入；保存与待保存状态分清。
- Explain unavailable composer models with reload and settings actions. Audit strict selection for OpenClaw 2026.9.6, including actual read-only CLI/HTTP capability checks returning available=true; 48 targeted backend checks pass without inference, expanded permissions or configuration writes. Add appearance-card links to default model settings and actual Agent assignment. / 核验2026.9.6严格指定，补输入框原因和员工模型入口；真实调用与成员身份单独验收。
- Extract QR images with white margins and distinguish them from full-page previews; show codes at 320px with 480px zoom, plus original-image and reconnect controls. Backend 140 and frontend 16 targeted checks pass. The current 7877 Zhihu QR source is 166×166; actual browser display is 318×318, zoom is 480×480 and Escape restores focus to the connection button. / 知乎码图显示与键盘已验；手机扫码、身份及二维码390px布局未验。小红书API曾success仅记状态。
- Restart the configured source project at 7877; model capability available=true, three saved models, gateway=true and 115 skills. Real browser checks confirm saved/pending model state without writes, source-card preview with three candidates and the employee default-model entry. Stop the mistakenly started empty 7876. / 当前实例模型同页与入口已实际检查，未确认导入/保存、模型推理或真实Agent分配。
- Remove final-chat placeholders and retain archived empty records; 86 early checks pass. Start both columns collapsed, ignore old expanded values and keep manual controls independent; R58 supersedes the earlier R55 restoration plan, with 69 targeted checks. / 7877实测最后归档最近0、刷新保持、恢复正常；7875最新前端520/390px默认折叠通过。
- Implement stable-account Xiaohongshu/Bilibili loading of up to 20 recent works with caching, timestamps and known/unknown totals, default My data and account→question→action. Fix normal whoami timestamp updates being mistaken for login changes; combined backend109 and sync28 checks pass, with overlap. / 三步与加载状态真UI已验，误判缺陷已修复；真实非空采集仍待确认。其他五平台保留导入，样本不当全历史。
- Implement shared dashboard/chat tool groups and stable send/create positions. R61 replaces large guidance with a compact status row, optional error/reload details and an Add/settings menu item. Its TypeScript/build and actual 7875 chat/dashboard checks pass at 520/390px. / 输入工具与紧凑状态已验，QA服务没有用户模型配置，不当作7877配置丢失。
- Replace the thinking list with a compact purple slider popup, centered current strength and selected model, plus a reset icon. Mouse and arrows/Home/End save immediately; Enter closes, Escape returns focus, busy state blocks changes. All nine values, medium default and request snapshots are preserved; 16 combined thinking/model-picker checks and related lint pass. / R62依据用户参考图调整，不虚构运行型号；最终浏览器与联合构建另补。
- R63 source-based model retrieval and R64/R65 provider icons, collapsing and visible basic editing remain in integration; do not count them as accepted yet. Operator guide, summary, startup and template are prepared, with documents ZIP and new Git synchronization pending. / 前端全量804与扫码/兼容联合148为此前阶段结果；最新联合检查另记，不累计重叠套件。独立身份、非空采集、推理、发布/SMTP、长会话与新程序包生命周期未验。

### 2026-10-09: professional analysis and operator handoff / 专业分析与运营交接

- Added seven-platform diagnostic capabilities, optional advanced metrics, explicit sample quality and comparable cohorts, evidence-bound topics and frozen seven-day experiments. Platform changes automatically refresh live data and reject stale responses. / 新增七平台诊断、可选高级指标、样本质量、同条件比较、证据题材和实验；切平台自动读取并隔离旧响应。
- Added composer model/thinking selection, measured model status, custom text and objective random image probes, durable opt-in schedules and a shared rolling quota. / 输入框可选模型/思考强度，展示实测状态；自定义文本/随机图片检测及默认关闭的自动测活统一限流。
- Added conversation ticks and user-confirmed Agent title suggestions; fixed CC Switch mapping and Xiaohongshu browser-login recovery. / 新增侧边刻度和需保存的 Agent 命名建议，修复配置映射和小红书浏览器登录恢复。
- Added the [operator handoff guide](docs/operator-handoff-2026-10-09.md), platform research and final-package audit boundaries. Frontend full suite: 755 passed; final changed-component suite: 47 passed. Backend combined affected suites: 422 passed, with 145 final focused checks passing (overlapping, not summed). TypeScript, lint and production build passed. / 检查覆盖模拟请求与界面契约，真实业务和最终 ZIP 尚未验收；旧包与公开安装器未更新。

### 2026-10-09 R28: current portable candidate acceptance extension

- Test the actual `76bbaf6-3fb7` extraction with its embedded Python: pdfplumber, pdfminer.six and native PDFium return the expected one-page text; the 612×792 rendering passes pixel and visual checks. Loaded module and native DLL paths and hashes match the distribution. This covers one synthetic English page, without inheriting the historical package's results.
- Preserve the initial preflight failure caused by an existing Chromium `debug.log`; the retry records that log without changing distribution files. Native desktop capture and window activation remain unavailable, and no ready clean Windows acceptance environment was identified. No product source or ZIP was changed for these checks.

### 2026-10-09 R27: moderation follow-up and portable browser verification

- Read Xiaohongshu and WeChat Channels creator-page responses using status rules traced to public first-party JavaScript. Require explicit public visibility and completed publication; review, scheduled, restricted and unknown results remain distinct. Xiaohongshu can expose a validated explore URL; Channels retains its work ID without guessing a public URL. Authenticated live platform responses remain unverified.
- Add a lifecycle-owned read-only worker for Xiaohongshu, Channels, Bilibili, Douyin and Kuaishou. Keep the original receipt, exact work ID or closed submission window; use increasing intervals bounded to 24 hours and 12 automatic attempts. Shared receipt cards offer manual checks and pause/resume. Querying a receipt never uploads or republishes content.
- Recover interrupted checks and unclaimed completion work after restart. Claim calendar/mail handling durably, reject another receipt claiming the same platform work, and recheck ownership after storage recovery. Claimed but uncertain mail is not automatically resent.
- Guard same-platform login, logout, identity checks, publication and moderation reads with a shared reservation; waiting and process cleanup remain outside the lock. Other platforms can still proceed.
- Frontend tests **700/700**, lint, TypeScript and production build pass; Python full suite reports **2070 passed / 7 skipped**. A localized C# compiler-output warning was corrected in its test probe, then that test passed with warnings treated as errors. Real browser checks cover manual verification, pause/resume, reload, completion on another page, read state, navigation and 390px layout using isolated platform samples; no real posting or SMTP delivery was attempted. Git delivery and the new ZIP identity are recorded separately in the [requirements ledger](docs/user-requirements-2026-10-08.md).
- Build frozen source `76bbaf69` into `Easel-preview-76bbaf6-3fb7.zip` (1,133,615,933 bytes). All 52,694 file hashes and the complete distribution inventory match before archiving and after actual extraction; the initial data directory is empty. The new copy starts from System32 with an isolated PATH in 160.51 seconds. Its 15 HTTP checks, 12 module imports and both bundled Chromium variants pass; browser executables and driver paths match the package.
- Verify the actual new workbench in a real browser: onboarding, model forms, skill selection and requirements, the demo switch across reload, and receipt/publishing/notification navigation. Remove the temporary skill and draft, keep demos off and leave the new local instance running for acceptance. Earlier PDF parsing, relocation and lifecycle checks belong to the historical `20a709c` package and are not inherited by this candidate.
- Native launcher execution and service readiness were observed during the earlier supplemental check, but desktop capture/input failed and the ready label could not be confirmed. GUI interaction, a clean Windows environment, real platforms/models/SMTP, signing and a public Release remain unverified. Exact package identity, local entry and boundaries are recorded in the [portable preview guide](docs/windows-portable.md).

### 2026-10-08 R25: publication receipts and notifications

- Keep Web publishing outcomes in the data directory with a persistent, shared receipt center across pages. A successful process exit no longer claims publication: pending review, draft, unknown, rejected and public results stay distinct. Only confirmed public outcomes enter the published calendar.
- Connect Bilibili's existing before/after work readback to the Web runner and shared structured receipt. Carry validated public URLs through supported platform scripts, the backend, calendar and optional success email. Identify each operation separately so different works cannot suppress each other's notifications.
- Keep mail queue, SMTP acceptance and failure separate from the platform outcome; honor the saved automatic-notification setting. Recover known results with a visible storage warning on disk failures, and mark interrupted operations as unverified after restart without retrying publication or email.
- Rebuild and verify the frontend with 697 passing tests, lint and TypeScript; 258 publishing/backend/mail/storage/portable regressions pass, with the final manifest notification correction separately covered by 32 mail tests. Real browser checks cover simulated outcomes, reminders across pages, reload recovery, read state, navigation and the 390px receipt panel. Platform responses and SMTP are isolated test doubles; no real posts or mail were sent. Xiaohongshu/Channels public readback, continued checks after moderation and the independent scheduled-publishing executor remain outside this delivery. Details and final evidence: [publishing acceptance](docs/publish-receipts-2026-10-08.md).

### 2026-10-09 R24: Windows portable preview acceptance

- Prepare a separate Windows x64 portable candidate with a graphical `Easel.exe` entry, start/status/stop command fallbacks, bundled runtimes and a data directory relative to the extracted folder. The graphical window is intended to stop this copy's services when closed; command-file users use the explicit stop entry.
- Fix the candidate component targets at CPython 3.12.10 embedded amd64, Node 24.19.0, OpenClaw 2026.9.2, FFmpeg 9.0.1, and Playwright-matched Chromium 153.0.8010.12 / r1243 with headless shell, FFmpeg r1011 and winldd r1007. Keep a separate exact portable Python lock, component provenance, checksums and third-party licenses. Users provide model credentials; optional Whisper/rembg model weights are not preinstalled.
- The first ZIP exposed a missing PDF fallback dependency and a cold configuration check exceeding 60 seconds. Add pinned pdfplumber, pdfminer.six and pypdfium2 packages, preserving the original 119 packages, and allow 120 seconds for bounded configuration validation; its 39 launcher regressions pass. The final extracted candidate's own Python passes common-library imports, actual PDF text extraction and native page rendering.
- Produce `Easel-preview-20a709c-0b56.zip` (1,133,545,960 bytes). Verify all 52,690 file hashes before archiving and after actual extraction, including the full inventory and initially empty data directory. The final copy starts from System32 with an isolated PATH, preserves configuration, browser origin, selected skills and a draft across folder relocation, and reuses its exact processes on repeated startup. Two copies run independently; stopping either leaves the other intact. A gateway startup during concurrent extraction timed out and cleaned up; a separate startup after file verification passed. The failed attempt remains recorded.
- Document the five-component builder input, full extraction, lifecycle and precise acceptance evidence in the [portable preview guide](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/windows-portable.md). Graphical double-click testing, a clean Windows VM, real model/platform publishing and signing remain unverified. No public Release has been created, and the existing 0.2.6 online installer EXE / ZIP remains unchanged. Git delivery is recorded separately in the [requirements ledger](docs/user-requirements-2026-10-08.md).

### 2026-10-08 follow-up: responsive layouts, quick-create skills, office tasks and first-run setup

- Replace the settings navigation's horizontal scroller with a wrapping grid and allow model-channel choices to wrap. Dashboard, creator pages, analysis and the office now use their available container width, including space taken by expanded sidebar columns. Fix squeezed calendar/profile/action rows, adapt idea columns, keep card actions reachable by keyboard and touch, and constrain long forms and process panels to the visible height. Wide data tables retain their own internal scrolling.
- Reuse the chat skill picker, selected chips and detail editor in the dashboard quick-creation box. Additional instructions belong to the current creation draft, with guides available through hover or keyboard focus. An accepted submission transfers the text, selected skills and instruction snapshot into the new conversation. Rejected sends and failed local saves preserve the draft; later draft edits are not cleared by an earlier submission. Global skill files and historical messages remain unchanged.
- Put the office's selected task, responsible member, reported step, latest receipt and output-location actions before the 3D scene, with model and execution controls nearby. Keep missing, stale and simulated evidence explicit: a tool return does not finish a task, and workspace files are not automatically attributed to a member. The design draws on Tencent's public Marvis documentation, without copying its assets or claiming a client-side comparison; see the [research and implementation boundaries](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/marvis-office-2026-10-08.md).
- Start or continue a main-conversation task from the office through the shared chat execution path, with confirmed interruption and retained results. Persist an optional per-turn `modelRef` through request/history recovery and retries, while showing requested and observed models separately. Explicit channel/model selection is enabled only for the audited strict-override contract in OpenClaw **2026.9.2**, with runtime version, permission and model-policy checks. Failed validation rejects the selected-model task without silently changing models or transports; a registered model does not establish valid credentials or real inference.
- Refresh member controls when a newer observation arrives, even if the member state is unchanged, and bind stop requests to the latest verified run identity. Whole-session interruption and a verified child Agent's stop scope remain distinct. The appearance editor's body portal follows the office's actual width while preserving the draft and mounted scene; independent character studies also adapt to the available width.
- Require each user interruption or added request to update the shared task document and priority order before code work resumes. Preserve earlier unfinished requirements, acceptance conditions and delivery status, then synchronize parallel assignments.
- Fix fresh Windows installation selecting a biliup source release that requires an extra Rust toolchain: pin 1.2.9 to match the release lock and use its Windows wheel. Leave example model credentials empty. Document the runtime-aware launcher and a consistent data directory for installation and later starts.
- Allow explicitly deferring Chromium with `-DeferBrowser` to initialize the core workbench. Keep an honest pending-browser checkpoint, retry it on a later normal installation, and retain failures from other stages. Extend the default official-download wait to 120 seconds while preserving a user's configured timeout. A full Chromium download still failed in this network; deferred setup and fresh-terminal launch succeeded with empty data and newly installed dependencies.
- Verification: **639/639 frontend tests**, **1449 Python tests with 6 skipped**, lint, TypeScript and production builds passed for the workspace changes. Subsequent installation fixes passed **65 targeted tests**. Real browser checks covered navigation/layout for 16 main pages at 390/768/1280px, plus the independent first-run dashboard, welcome flow and unconfigured model form. The [verification record](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/responsive-office-skills-2026-10-08.md) distinguishes full-suite timing, HTTP checks, simulated contracts and browser evidence. No real model/multi-Agent execution, complete platform-browser installation or new installer release is claimed.

### Earlier unreleased work

- Add Settings → General as the default settings entry, with a shared, accessible Show demo data switch. The preference persists in the current browser and synchronizes other tabs on the same origin. Disabling it immediately gates content-analysis examples and office demo members, timeline, process previews and sample outputs; empty or failed live reads never substitute demo records. Preserve saved works, conversations and appearance cards. Unreadable preferences temporarily close demos; failed writes keep the active choice and are not silently retried. Explicit model, video and backup settings links keep their destinations.
- Demo-setting verification: **572/572 frontend tests**, lint, TypeScript and production build passed. Actual desktop/390×844 browser checks covered keyboard and mouse switching, reload/new-tab recovery, settings navigation, actual-data analysis and cross-tab removal of open office demo previews. Backend code was unchanged; the earlier Python result below was not rerun for this follow-up.
- 2026-10-08: Split navigation into a compact toolbar and a separate conversation list. Both expand/collapse independently with separate saved preferences; the default keeps the icon toolbar narrow and conversations visible. Secondary pages remain reachable through More. Shared custom Select controls replace visible native dropdown menus across the workbench; the image/video switch and mask drawing tools reuse RadioGroup.
- Keep selected skill chips and their count visible in the composer. Hover and keyboard focus read the installed skill guide; clicking edits optional instructions for that skill in the current conversation, with save and clear actions. Preserve choices and instructions across navigation and reloads; each send records its own snapshot, leaving global skill files and earlier messages unchanged. Catalog failures do not erase choices, and failed saves retain editable drafts with an explanation.
- Add explicit saving for My Trends source choices, with icons for all nine sources, empty-list support and a restore-defaults action. Changes affect the current view immediately and persist only after Save Trends succeeds; storage failures never show a saved state. Item bookmarks continue to save topics into the idea library separately.
- Restore missing Zhihu heat labels and question-creation timestamps, honor source cooldowns and Retry-After, and add an opt-in DailyHotApi-Go fallback through the backend launch variable `EASEL_ZHIHU_DAILYHOT_URL`. It is disabled by default and tried only after primary-source failure/cooldown. The checked public demo is not a default dependency. This adapter accepts trending questions, not search keywords or the daily digest, and does not claim response-generation timestamps are ranking-update times. See [source evidence and configuration](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/zhihu-trends-2026-10-08.md).
- Unify the two sidebar columns, account and More popovers, and chat with the existing global surface, border, selected-state and focus tokens. Remove the chat page's separate forced light palette. The current application has no dark-theme entry; no dark-theme acceptance is claimed.
- Add a reference-image mask editor with brush, eraser, brush sizes, clear, cancel and apply controls. Encode a PNG at the original dimensions with fully transparent edit pixels and opaque preserved pixels, then use the existing mask upload path. An empty selection cannot be applied, canceling preserves the prior draft, and generation remains a separate action requiring provider support. The independently implemented interaction follows the [AI Image Studio comparison](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/image-studio-comparison-2026-10-08.md); templates, persistent image queues and channel comparisons remain future work.
- Add explicit editorial perspectives and material requirements for seven platforms, and pass platform context to single-work AI interpretation. Single-work AI validates verbatim quotations against their source materials. Cross-work AI stays within one platform/account, considers at most 12 works and 32 program-generated fact cards, and accepts at most six suggestions whose valid fact IDs cover at least two works each; it does not validate source quotes. Numbers remain in deterministic fact cards, and interpretation still requires human judgment. Saved results expire when relevant materials change, and concurrent changes reject stale writes. Suggestions prefill existing validation experiments and support JSON/Markdown export.
- Add an office attention summary inspired by stablyai/orca: distinguish reported problems, stopped agents and unknown states, then open the corresponding member's process. Waiting is separate from approval, and live/demo/stale observations remain distinct. This does not implement persistent task scheduling, exact artifact ownership or real handoff receipts. Review sources and licenses in the [Orca research](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/orca-research-2026-10-08.md); no third-party runtime dependency was introduced.
- Earlier October 8 stage checks: **555/555 frontend tests**, **1417 Python tests passed / 6 skipped**, with lint, TypeScript and production builds passing. The frontend total includes regressions confirming that a failed instruction save or clear followed by cancel keeps the previous requirements for the next send. Earlier counts below describe their own stages and are not added to these totals.
- Complete desktop and 390×844 browser checks for the sidebar, shared controls, skill instructions, trend-source preferences and masks. Office issue navigation used demo data; a 640×480 binary PNG mask reached the actual local upload backend. Skill-guide keyboard access was verified; independent mouse-hover behavior has simulated DOM coverage only. See the [2026-10-08 verification record](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/analysis-platform-orca-2026-10-08.md) and [user requirements checklist](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/user-requirements-2026-10-08.md). Real model/platform analysis and new installer delivery remain unverified; no paid generation or installer release was performed.

- 2026-10-05 stage: Rework chat around a Codex-inspired conversation column, a neutral single-surface composer, a persistent conversation title and an optional turn-navigation popover. That stage's sidebar defaulted to an icon rail and expanded to recent chats; its layout/default was superseded by the independent two-column navigation above. Account previews expose seven original platform brand icons with explicit unverified-login wording.
- Show and edit the image model inside the studio, persist the model ID against the existing service, and bind model/channel snapshots to actual queued jobs and output metadata. Accept clipboard images and video files with local previews; decode video reference frames in the browser without uploading the source video. Unsupported clipboard formats and video links have explicit fallback guidance.
- Audit content analysis against the running local service: fictional examples and structured-import workflows are available, while the current environment has no logged-in platforms or configured chat model. Persistent live archiving still requires stable account/work IDs that most platform collectors do not return. Fix punctuation-only transcripts causing a saved account report to fail with an IndexError. See [chat, studio and analysis verification](docs/chat-studio-analysis-2026-10-05.md) for test counts and pending browser checks.

- Raise component test coverage by 20 tests: the grouped sidebar (section order, default collapse, persistence, active-group protection), UsagePanel (honest 未上报 placeholders, session/project scopes, provider filter, fetch failure), MessageBubble (sanitized markdown, attachment-only turns, streaming typing/live panels, thinking expansion, copy/retry actions, error alerts) and shared pieces (skeletons, platform brand vs neutral icon, chat turn navigation keyboard moves). Also fix the test loader so asset imports (svg/png) resolve as opaque URLs instead of being compiled as modules, which previously made any component importing assets untestable.

- Earlier 2026-10-05 navigation stage, superseded by the two-column layout: regroup the sidebar into four labeled sections — 创作 (工作台/对话/生图工坊), 工具 (技能库/内容库/内容分析), 观测 (运行记录/Agent 办公室), 配置 (账号/画像/设置) — so Chat stays first-class instead of being squeezed down the list. Each section was collapsible with state persisted per tab; the active page's group stayed expanded, and narrow screens used a horizontal scroller without group headers.

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

Latest implementation and exact validation scope: [responsive layouts, dashboard skills and office tasks](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/responsive-office-skills-2026-10-08.md). Earlier boundaries remain in the [October 8 platform-analysis stage](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/analysis-platform-orca-2026-10-08.md), [2026-10-05 stage](docs/chat-studio-analysis-2026-10-05.md), [workspace experience iteration](docs/workspace-experience-validation-2026-10-01.md), [animal motion](docs/office-animal-motion-2026-10-01.md) and [professional office](docs/professional-office-2026-10-01.md) records. Earlier office browser checks used an isolated local workspace and simulated employee demonstrations; sampled poses do not establish collision-free motion at every instant or measured frame rates. Model and gateway protocol tests do not substitute for a real multi-agent run. These source changes are not included in the existing 0.2.6 installers.

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

## 2026-10-13

- 收敛内容分析、运行记录与 Agent 工作室首屏：筛选、请求浏览和成员名单改为按需展开，减少重复说明。
- 生图渠道模型名称与地址、密钥一次保存，设置页可直接完成配置。
# 2026-10-14 · 0.2.8 / 138 runtime repair

- Fixed the 138 Agent failures: accurate skill/reference paths, read-only server workspace guidance, safe saved-script execution, curl/file availability, a reachable Bing RSS search provider, and a sandboxed Chromium sidecar with real renderer health checks.
- Added actual installed OpenClaw/latest version detection and bounded official changelog evidence. The Environment Installation card can start a sourced Agent upgrade assessment; it never upgrades or restarts automatically.
- Deployed and verified 0.2.8 on 138. OpenClaw remains pinned to 2026.9.6 while official latest is 2026.10.3. The Agent assessment separates official facts, conditional relevance, unknowns, compatibility gates and rollback triggers.
## 2026-10-16 · Agent parallelism and startup-model cost guard / Agent并行与启动模型费用保护

- Add Settings → Agent collaboration with a required configured startup model, bounded concurrency, child count, depth and timeout. / 设置新增Agent协作，启动模型必须来自已配置完整模型，并限制并发、子任务、层级和超时。
- Deny `sessions_spawn` when no startup model is saved; lock child tasks to the selected model and reject over-limit timeouts through a local OpenClaw 2026.9.6 safety plugin. / 未保存启动模型时阻断` sessions_spawn`，子任务锁定所选模型，安全插件拒绝超时越界，避免静默调用昂贵模型。
- Local backend/frontend regression, lint/build, HTTP and browser entry checks passed. No paid inference, Agent task, 138 deployment or installer release. / 后端前端回归、lint/构建、HTTP与浏览器入口检查通过；未发起付费推理或Agent任务，138和安装包未更新。见[验证记录](docs/agent-runtime-safety-2026-10-16.md)。

## 2026-10-16 · Honest work-progress timeline / 工作进度时间线

- Replaced placeholder-like “waking the agent” and “thinking” activity text with ordered service events. / 将“唤醒 agent”“正在思考”等占位文案改为按顺序记录的服务事件。
- Separated heartbeat notices and thinking summaries from actual work steps; missing events remain explicitly unknown. / 心跳提示与思考摘要和工作步骤分开；后台未上报时明确显示未知，不伪造进度。
- Added completed, failed, stopped, reconnecting and backup-record states with narrow-screen layout coverage. Frontend tests (1025), build, lint and Python syntax checks passed; no paid task or 138 deployment. / 增加完成、失败、停止、重连和备份记录状态，并覆盖窄屏布局；前端1025项、构建、lint和Python语法检查通过，未发起付费任务或138部署。详见[工作进度记录](docs/work-progress-redesign-2026-10-16.md)。

\n
## 2026-10-16 · Agent loop and long-conversation reliability / Agent loop 与长对话可靠性

- Confirm normal multi-turn reuse: a stable OpenClaw session carries later prompts, tool calls and context compilation. / 确认正常多轮复用稳定 OpenClaw 会话，后续消息、工具调用和上下文编译都进入同一会话。
- Document the real boundary: Easel's Web supervisor, SSE carrier and Gateway recovery run are not one durable state machine; `chat_supervisor_lost` is an outer reconciliation outcome, not proof that OpenClaw cannot run long conversations. / 记录真实边界：Easel Web supervisor、SSE 连接与 Gateway 恢复 run 尚未统一为持久状态机，`chat_supervisor_lost` 是外层对账结果，不是 OpenClaw 不支持长对话的证明。
- Add a failure matrix and P0/P1/P2 repair order centered on a durable run ledger, recovery-attempt identity, stall/compaction events and startup version gates. No model call, paid retry, service restart or 138 deployment was made. / 增加故障矩阵和以持久 run 账本、恢复 attempt 身份、stall/compaction 事件及启动版本闸门为核心的修复顺序；本轮未调用模型、未付费重试、未重启服务或部署138。[调查记录](docs/agent-loop-long-conversation-investigation-2026-10-16.md)。
## 2026-10-16 · Durable Agent run ledger / Agent 运行账本

- Add a project-local per-turn ledger linking logical `turnId` to provider run identity, attempt, recovery relation, transport, event sequence, terminal state and resource settlement. / 增加项目级每轮运行账本，关联逻辑 `turnId`、provider run、attempt、恢复关系、传输层、事件序号、终态和资源结算。
- Reject a second POST for an existing logical turn and expose read-only run state through `/api/chat/last` and `/api/chat/runs/{turnId}`. / 同一逻辑轮次重复提交会被拒绝，`/api/chat/last` 和 `/api/chat/runs/{turnId}` 提供只读账本状态，避免把重连误变成重复付费请求。
- Keep cross-process takeover, stall watchdog, compaction transactions and real restart acceptance pending; no paid request, 138 deployment or installer release was made. / 跨进程接管、stall watchdog、压缩事务和真实重启验收仍待完成；本轮未调用付费模型、未部署138、未更新安装器。
- Focused backend/chat regression and syntax checks passed; see [the run-ledger record](docs/agent-run-ledger-2026-10-16.md). / 后端聊天专项回归和语法检查通过，详见[运行账本记录](docs/agent-run-ledger-2026-10-16.md)。

## 2026-10-16 · Ledger-backed orphan stop / 账本驱动的旧任务停止核实

- Prefer the durable provider run identity when an orphaned Web supervisor is stopped after restart, and write the confirmed terminal state back to the ledger. / Web 重启后显式停止旧任务时优先使用持久账本中的 provider run，并把已确认终态同步回账本。
- This is an explicit stop/reconcile path; automatic takeover and lossless continuation remain pending. / 这仍是用户显式停止/核实路径，自动接管与无损续跑继续待完成。

## 2026-10-16 · Stall warning watchdog / 停滞告警

- Record one durable `stall_warning` after a configurable no-event window (180 seconds by default), with the idle duration and last event sequence; the UI states that the provider is still being awaited. / 长任务在可配置无事件窗口（默认180秒）后记录一次 `stall_warning`，保存空闲时长和最后事件序号，并明确提示仍在等待 provider。
- The warning never kills or resubmits a request; full recovery and pressure acceptance remain pending. / 告警不会终止或重发请求，完整恢复和压力验收仍待完成。

## 2026-10-16 · Compaction lifecycle in the run ledger / 压缩生命周期入账本

- Persist OpenClaw compaction start/end and reported outcomes alongside the logical run while preserving the existing SSE display. / 将 OpenClaw 压缩 start/end 及 outcome 与逻辑轮次一起持久保存，保留现有 SSE 展示。
- This is observability only; cross-process compaction transactions and provider-exact token accounting remain pending. / 当前是可观测性记录，跨进程压缩事务和供应商精确 Token 账本仍待完成。
