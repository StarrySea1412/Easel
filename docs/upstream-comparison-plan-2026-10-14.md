# 上游更新对比与跟进规划 · 2026-10-14

**同日实施更新**：下表保留最初比较的历史基线。A的0.2.8隔离/正式真实工具验收与切换已完成，见[运行回执](runtime-repair-2026-10-14.md)；B已实施为独立0.2.9源码候选，逐项来源、行为与验收边界见[跟进记录](upstream-reliability-0.2.9-2026-10-14.md)。C–F仍为后续计划；0.2.9未部署或发布安装器。

建议继续保留本仓库的创作者工作流，先完成现有 0.2.8 候选的真实搜索、浏览器与部署闭环，再分批吸收上游的登录、采集、安装和模型配置修复。上游 v0.3.0 的多引擎与共享技能架构值得跟进，但需要接入我们的持久执行记录、会话绑定与权限交互，不能直接替换整套页面或运行链路。

## 1. 可核对的比较基线

2026-10-14 重新 fetch 两个远端后，基线如下。本文比较源码和已有验收记录，不代表重新验证上游运行环境或 138 服务。

| 对象 | 固定身份 | 实际状态 |
| --- | --- | --- |
| 上游 `ZJU-REAL/Easel` | [`bb3c8ff0463f36c202454d74171682ba6e470cb1`](https://github.com/ZJU-REAL/Easel/commit/bb3c8ff0463f36c202454d74171682ba6e470cb1)，`origin/main`，源码 0.3.0 | [v0.3.0 Release](https://github.com/ZJU-REAL/Easel/releases/tag/v0.3.0) 存在；本次 GitHub API 核对 assets 为 0，不等于已有可下载的新安装包 |
| 本仓库功能分支 | [`cd86691014022ad9a702935d886bdd2395283385`](https://github.com/StarrySea1412/Easel/commit/cd86691014022ad9a702935d886bdd2395283385)，`codex/upstream-compat-2026-10-10` | 0.2.8 候选源码已提交并推送；真实搜索、独立浏览器与新部署验收尚未完成 |
| 本仓库默认分支 | 比较开始时 `starry/main` 为 `e8bdfeb5f675d551437d2f84e6ffd155283637a0` | 首页说明持续同步，最新功能代码仍在工作分支；直接克隆 main 不会得到全部最新功能 |
| 138 最近已验运行发行 | 0.2.7 / build `1a324540854c4fe082ee30ec0256942b8c6ef5da` | 保留 10 月 13 日登录、真实模型、网页读取、文件与版本验收记录；此次未重验、未切换服务器 |
| 共同祖先 | `3fe2d9904c1619281ef57f81d9ee0b7854998399` | 双方分别演进；定制版有等效移植，不能用“提交不是祖先”判断行为修复一定缺失 |

增量范围从[上次兼容报告](upstream-compatibility-2026-10-10.md)已审上游 `278f4209b1d5fcad7beac859176395aa6ad2d311` 到 `bb3c8ff0`：31 个提交（25 个非 merge）、841 条文件变化记录，其中 719 条为重命名，654 条重命名内容完全相同，包括 653 个技能文件。大部分路径变化来自 `skills/openclaw → skills/builtin`，不等于新增数百项能力。共同祖先到最新上游的差异是另一统计口径，不混用。

## 2. 一致的产品思路

双方都把对话当作创作入口，并把模型调用、技能、平台账号与产物连接到实际工作流。仅能发送消息不足以完成创作任务：还要看得到执行状态，核实当前账号，找到真实文件，并在失败后恢复或解释原因。

双方也在区分模型供应商与执行引擎。供应商决定模型服务，引擎决定工具、上下文和权限如何执行。上游已把这一点做成统一的引擎选择；我们的 OpenClaw 与 Codex 已有独立接入及共享执行视图，下一步适合抽出统一契约。

还有一个共同方向是保留已有凭证和会话，避免安装、设置保存或引擎切换悄悄改变运行环境。CLI 被检测到、HTTP 能连通、模拟检查通过与真实任务完成应分别记录。这些原则继续作为移植约束。

## 3. 逐主题比较

下表的“较好”指当前实现更适合哪类目标，不是按功能数量打总分。源码存在也不等于真实服务已验收。

| 主题 | 上游最新实现及价值 | 本仓库已保存的实现及优势 | 跟进判断 |
| --- | --- | --- | --- |
| 执行引擎 | OpenClaw、Codex、OpenCode、通用 ACP、仅聊天模式统一选择；原生模型目录、CLI 探测、会话续接、私有 stdio 进程复用。扩展新引擎的结构更清晰 | OpenClaw/Codex 有持久事件、命令输出、diff、计划、公开思考摘要、终态与回放；轮次隔离、断线不重发。执行证据与故障解释更完整 | 先定义适配契约，再接现有两引擎，最后添加 OpenCode/ACP；不覆盖执行记录 |
| 登录与扫码 | 更新二维码捕获与新鲜度、扫码后状态、匿名重定向判断、验证竞态、平台维护/限制提示；视频号重资源拦截针对 ARM64 崩溃 | 已有创作者账号页面、错误分类与运行状态；历史兼容修复覆盖部分登录墙，不能据此声称覆盖本次所有新增扫码逻辑 | 第一批吸收可靠性修复；保留当前账号证据和代际失效规则，实际 App 扫码另验 |
| 小红书采集 | 有界等待、本人身份读取、创作中心数据与登录失效判断；统计采集持有 Profile 锁，防并发共用目录 | `account_evidence.py` 区分 live/import、账号目录和来源；账号分析有方法、样本与来源边界。当前 `account_stats.fetch` 仍直接启动浏览器，不能将旧文档的锁描述当作当前函数已受保护 | 优先移植等待边界、身份校验和锁；失败不得覆盖历史数据，不得读取另一账号数据 |
| 模型配置 | 自定义模型 reasoning 能力声明、自动 thinking 格式检测、直连 API 凭据隔离及 turn ID 与历史对齐 | 已有独立渠道、原子保存、实际模型选择与公开 reasoning 流；不伪造无来源思考，不静默回退模型 | 按行为差异吸收能力声明和自动检测；保留已有凭据事务与会话归属 |
| 安装与 PATH | 可跳过 OpenClaw，增强当前服务账户下 CLI 查找；Windows 安装保留进程 PATH，补 UTF-8/Python 3.10 兼容和 CI 诊断 | 自有启动隔离、便携路径、发行摘要、受保护部署和真实版本标识；安装副本不借用本机网关凭证 | 先移植低耦合 PATH/编码修复；安装选项与新版打包在专门批次验证 |
| 技能与提示资源 | `agents/`、`skills/builtin/` 统一跨引擎命名，安装器、同步器、CLI 与提示同时更新 | 115 技能及推荐、技能转聊天草稿、配置状态注入、共享文件保存；共享目录仍服务定制工作流 | 有价值，但属于路径迁移；需要兼容旧入口、私有记忆和用户技能，不能仅 rename |
| 产物体验 | `ArtifactGallery` 支持多产物、前后切换与键盘导航，阅读同轮多个结果更方便 | 已核验真实本地文件、缺失提示、HTML 预览、原文件和附件下载；内容项目、图片分类与创作分析更完整 | 在真实文件核验后增加画廊，复用现有分类、主题目录与下载语义 |
| 创作者业务 | 社媒内容技能、账号接入与基础工作台覆盖面广 | 内容分析、账号分析、创作项目、发布回读、队列暂停/恢复、通知及 Agent 办公室更贴近完整业务过程 | 保留定制产品结构；平台接口修复逐项移植，不把上游页面覆盖回来 |
| 交付与版本 | v0.3.0 源码版本及 Release、跨平台测试和已知问题说明 | 138 有独立 HTTPS/运行时认证、源码摘要、版本 API、模型/文件实测；运行发行与文档提交分开 | 我们应先消除“候选源码已推送但未部署”和“main 首页新、代码旧”的交付差距 |

上游最新提交还加入了可配置的 Codex 自动审批判断。该能力不属于低风险兼容修复，涉及已有审批约定与命令判定边界；暂不移植，不将它用于绕过我们现有确认流程。仅聊天模式也应明确不能执行工具或本地技能。

## 4. 推荐分批顺序与验收条件

以下为最初比较时的分批计划；A/B当前进度以上方同日实施更新和各自回执为准，其余功能不标记为完成。

| 优先级 / 批次 | 工作范围 | 依赖与通过条件 |
| --- | --- | --- |
| P0 / A：完成当前候选发行 | 固定一个源码提交构建前后端；补 curl、固定搜索插件、独立浏览器运行；隔离验收后备份切换 138 | 搜索必须有真实工具回执与可访问来源；curl 退出码真实；浏览器必须真实访问页面并产生可核对结果；隔离登录、既有文件摘要、模型/工具任务通过后才切换；正式版本、运行 SHA、页面及文件下载重新对账 |
| P1 / B：可靠性修复 | QR 新鲜度/扫码状态/匿名跳转/过期验证、XHS 有界采集/本人身份/Profile 锁、Windows PATH、UTF-8、模型 reasoning 声明与格式检测 | 先按补丁建立行为差异表。回归过期会话、超时、并发、账号切换、空数据不覆盖、旧验证不回写、凭据不丢失；浏览器检查键盘/390px；真实扫码和真实账号采集分别记录，缺账号条件保留未验 |
| P1 / C：共享资源迁移 | 将内置技能和引擎无关提示迁到统一路径，更新同步、安装、发现、推荐、调用及文档 | B 稳定后独立提交；旧路径兼容或明确迁移说明；115 技能可发现，真实代表技能可执行；私有记忆/用户技能/数据目录不被覆盖；Windows/Linux 路径和干净安装检查通过，打包仍按暂停要求处理 |
| P2 / D：多产物画廊 | 在聊天与内容库复用多个真实产物预览、左右键/ESC、前后切换和窄屏布局 | 复用已核实文件及现有共享控件；测试缺失/零字节/中文空格/外部链接/越界路径/多媒体，不把远程网站描述成完整离线文件；模型输出元数据可模拟，但文件预览与附件应使用真实文件 |
| P2 / E：统一现有引擎契约 | 用上游 adapter 思路封装现有 OpenClaw/Codex；统一模型目录、问答、取消、native session 与事件 | 保护现有 execution store、event ID、任务/轮次归属、审批和服务中断状态；回归断线续流、重启回放、停止、重复追问、模型固定、配置变化；不自动重发、不将旧会话静默换引擎 |
| P2 / F：新增引擎与发布入口 | E 稳定后接 OpenCode/通用 ACP/明确标识的仅聊天模式；整理 release 分支、main 源码入口和安装元数据 | 一个引擎一个验证批次：检测/认证/真实消息/模型/工具/停止/恢复/权限；通用 argv 仅受控本机配置、不走 shell。功能合入 main、开启新引擎与恢复安装包发布均按独立授权和实际验收推进 |

A已按原发布任务完成，B在独立分支按固定上游基线实施；运行链路和路径迁移各自形成独立提交，避免混入A的发布来源。

## 5. 移植时必须保护的行为

- 当前双列侧栏默认与刷新均收起；主动点击“对话”进入聊天并展开会话列，重复点击保留会话和草稿。新增设置入口使用共享选择控件，并检查键盘和窄屏。
- 保留内容分析、账号来源/身份/样本边界、发布回读和任务队列。上游修复不得把实际缺数据写成零值或把模拟数据写成 live。
- 保留持久执行记录、事件顺序、问答/审批和当前模型绑定。服务中断的不确定状态不能变成“成功”，断线不能触发自动重发。
- 保留真实文件存在/非空/目录边界核验、预览和附件下载。画廊只组织已核实的产物。
- 不迁移或提交密钥、平台登录态、个人作品与临时验收文件；不从其他 Windows 用户或其他项目借凭据。
- 本地及隔离测试管理员沿用用户要求的 `gaojitest / gaoji`，采用正常密码哈希、仅受控运行时配置。此次未修改认证或重复登录，历史入口为 `https://192.168.0.138:8444/`；公网凭据需独立满足密码要求。

## 6. 检查与交付边界

前一聊天在保存 `cd866910` 后运行的相关后端 131 项通过，前端全量 962 项通过、0 失败；已复核 `read_thread` 中完整退出回执和本地 `.scratch/git-snapshot-20261014-frontend.log` 尾部。后端范围是采集错误、工具包装、设备初始化、部署能力、便携启动与工作区启动七个套件，不是全后端仓库。日志保留本地，不提交。

这些是候选源码历史自动化证据，不代替搜索、浏览器、扫码、真实账号、138 新发布或新安装器验收。本文改动仅为 Markdown；本轮检查文档链接、引用源文件、Git 差异和远端 SHA，不重复无关全量测试，也不报告新的页面验收。

| 当前交付项 | 状态 |
| --- | --- |
| 上游比较、双语说明与分批计划 | 本报告完成；源码比较与 Release 元数据已核对 |
| 候选 0.2.8 源码保存 | `cd866910` 已推送；新文档提交身份与运行发行分开 |
| README / README_EN / CHANGELOG / 进度清单 | 随本报告更新；main 只同步文档入口，功能代码仍在工作分支 |
| 真实搜索、独立浏览器、隔离与正式 0.2.8 部署 | 未完成，见[候选发行记录](full-release-2026-10-13.md)和[部署总结](deployment-summary-2026-10-13.md) |
| 新引擎、共享路径迁移、画廊 | 本报告中的待实施计划，不算已实现 |
| 完整恢复/回滚专项、代表性负载、全菜单、各平台/付费媒体、Codex 服务器启用 | 保留原清单未验范围，见[部署任务](deployment-138-tasks-2026-10-13.md) |
| Windows 新安装器 / 便携包 | 暂停；源码推送不代表新包已发布 |

## 7. 源码与历史证据入口

上游固定 SHA 来源：

- [v0.3.0 更新记录](https://github.com/ZJU-REAL/Easel/blob/bb3c8ff0463f36c202454d74171682ba6e470cb1/CHANGELOG.md)、[引擎设计与验证边界](https://github.com/ZJU-REAL/Easel/blob/bb3c8ff0463f36c202454d74171682ba6e470cb1/docs/agent-harnesses.md)、[适配接口](https://github.com/ZJU-REAL/Easel/blob/bb3c8ff0463f36c202454d74171682ba6e470cb1/easel/harnesses/base.py)。
- [账号统计](https://github.com/ZJU-REAL/Easel/blob/bb3c8ff0463f36c202454d74171682ba6e470cb1/skills/shared/scripts/account_stats.py)、[扫码登录修复 c8ad1f36](https://github.com/ZJU-REAL/Easel/commit/c8ad1f36)、[采集修复 eee47f86](https://github.com/ZJU-REAL/Easel/commit/eee47f86)、[Windows PATH 修复 e6d5e8eb](https://github.com/ZJU-REAL/Easel/commit/e6d5e8eb)。
- [模型能力声明 a9164842](https://github.com/ZJU-REAL/Easel/commit/a9164842)、[thinking 自动检测 9ccba752](https://github.com/ZJU-REAL/Easel/commit/9ccba752)、[产物画廊](https://github.com/ZJU-REAL/Easel/blob/bb3c8ff0463f36c202454d74171682ba6e470cb1/web/frontend/src/components/ArtifactGallery.tsx)、[审批判定](https://github.com/ZJU-REAL/Easel/blob/bb3c8ff0463f36c202454d74171682ba6e470cb1/easel/harnesses/permissions.py)。

本仓库实现与验收说明：

- [执行体验实现](execution-experience-implementation-2026-10-12.md)、[Codex 集成计划](codex-runtime-integration-plan-2026-10-10.md)、[账号分析更新](account-analysis-major-update-2026-10-09.md)、[内容分析方法](content-analysis-methodology-2026-09-30.md)、[发布回执](publish-receipts-2026-10-08.md)。
- [执行持久化](https://github.com/StarrySea1412/Easel/blob/cd86691014022ad9a702935d886bdd2395283385/easel/execution_store.py)、[Codex 服务](https://github.com/StarrySea1412/Easel/blob/cd86691014022ad9a702935d886bdd2395283385/easel/codex_service.py)、[账号来源证据](https://github.com/StarrySea1412/Easel/blob/cd86691014022ad9a702935d886bdd2395283385/skills/shared/scripts/account_evidence.py)、[文件保存](https://github.com/StarrySea1412/Easel/blob/cd86691014022ad9a702935d886bdd2395283385/skills/shared/scripts/save_artifact.py)。
- [进度](secondary-development-progress.md)、[用户要求与未完成项](user-requirements-2026-10-08.md)、[138 运行手册](../deployment/138/RUNBOOK.md)。保留上游来源、项目许可证和第三方归属。

## English comparison and adoption plan

Keep the fork's creator workflow and finish the current 0.2.8 candidate release first. Then adopt upstream reliability fixes in small commits. Upstream's common runtime architecture and neutral skill paths are useful, but they must preserve our durable execution evidence, account isolation, session ownership and permissions.

**Verified source baselines.** On October 14, fetching both remotes confirmed upstream `bb3c8ff0463f36c202454d74171682ba6e470cb1` (source 0.3.0) and our functional branch `cd86691014022ad9a702935d886bdd2395283385` (candidate 0.2.8). Upstream has a v0.3.0 GitHub Release with zero attached assets, checked through the API. Our main branch started at `e8bdfeb5`; its documentation describes newer work, while the functional code remains on `codex/upstream-compat-2026-10-10`. The latest verified 138 runtime is still 0.2.7/build `1a324540854c`, with October 13 evidence; this comparison did not recheck or change it.

The upstream increment since the previously reviewed `278f4209` contains 31 commits and 841 changed-file records. Of 719 renames, 654 have identical contents, including 653 skill files. The migration from `skills/openclaw` to `skills/builtin` explains much of the file count. The branches share ancestor `3fe2d990`, but equivalent fixes in the fork require behavior comparisons rather than ancestry checks alone.

**Shared direction.** Both projects connect chat, tools, skills, accounts and actual outputs into a creative workspace. Both distinguish model providers from execution engines and aim to preserve credentials and native sessions. Detecting a CLI, reaching an HTTP endpoint, passing fixture tests and completing a real task provide different evidence.

| Area | Upstream strength | Fork strength and adoption decision |
| --- | --- | --- |
| Runtimes | Unified OpenClaw/Codex/OpenCode/ACP/chat-only selection, native model catalogs and process reuse | Richer durable commands, output, diff, progress, approvals and replay; adapt the interface before adding engines |
| Login and collection | Fresh QR capture, anonymous redirect detection, stale-verification handling, bounded XHS reads and profile locking | Account/source isolation and analysis evidence; adopt fixes without replacing identity or historical data |
| Configuration and installation | Model reasoning declarations, automatic format detection, PATH/UTF-8 fixes and optional OpenClaw installation | Independent channels, transactional saves, gateway isolation and release verification; compare each behavior before porting |
| Skills and artifacts | Neutral resource paths and a keyboard-accessible multiple-artifact gallery | Skill recommendations, creator projects and verified real-file previews/downloads; migrate paths separately and build the gallery on file verification |
| Delivery | Tagged source release, cross-platform tests and documented limits | Verified internal HTTPS/model/file deployment and runtime identity; finish the pending release and clarify the main/source mismatch |

**Phased work.** A (P0): finish real search, curl and isolated browser checks; build frontend/backend from one fixed source commit, verify the isolated environment, back up, activate 138 and reconcile runtime SHA, UI and file downloads. B (P1): port QR, identity, timeout, concurrency, PATH, encoding and reasoning configuration fixes; validate stale responses, account changes, failed reads and credential preservation. Real App scanning and account collection remain separate acceptance steps. C (P1): migrate shared resources only after discovery, sync, installation and legacy paths are accounted for; preserve private memory, user skills and all 115 discoverable skills. D (P2): add a real-file gallery with keyboard and narrow-screen checks. E (P2): wrap existing engines in a common contract while retaining event IDs, turn ownership, stop behavior, approvals and replay without automatic resubmission. F (P2): add engines one at a time and resolve release/main/install entry points through their own implementation and acceptance scope.

The upstream configurable Codex automatic-approval logic changes permission behavior and is deferred. Chat-only mode must clearly state that it cannot execute local tools or skills. New engine selection must not silently switch existing conversations.

**Evidence limits.** The earlier candidate-save turn completed 131 focused backend tests and 962 frontend tests; complete tool receipts and the local frontend log were reviewed. These are historical automation results, not new search/browser/login/deployment acceptance. This turn updates Markdown and checks links, source references, diffs and remote commits. Packaging remains paused. Recovery/rollback drills, representative load, all-menu checks, platform integrations, paid media and server Codex activation retain their previous unverified status. The internal/isolated runtime test account remains user-authorized with a normal password hash; no account is embedded in source or images and no login was repeated for this documentation task.
