## 0.4.0 · 2026-10-20 · Inline actions and structured progress / 对话行为与进度胶囊

- Move current-turn progress into a collapsible header capsule with step states, count, elapsed time and goal acceptance access. Inline tools and OpenClaw root/observed child actions retain exact turn ownership and recorded model/channel identities. / 采用用户龙虾SVG，与办公室共用行为及厂商图标；未知身份不按配置猜测。
- Give long tasks native update_plan/TodoWrite guidance and a bounded local CLI receipt fallback. Persist successful full-plan receipts; failure, stop and tool completion never check off unfinished steps. / 普通对话可独立拥有checklist，短问答不强制规划。
- Add task-source summaries and bounded failure-ID inspection/copying to Activity, including direct links from import/publication failures. / 任务可返回原对话、定时或发布入口，失败刷新保留快照。
- Fix Playwright startup under Windows Selector policy with a worker-owned Proactor loop; keep action errors through refresh and automatic resize, with serial visible-page polling. / 不改变全局事件循环或既有CDP/网络隔离。
- Validation: 102 focused backend checks, full frontend 1,180 tests plus final focused regressions, build/lint and real isolated browser acceptance. Browser navigation/input/screenshot evidence is real; agent, task and publication observations use fixtures. Actual 390 CSS px layout and dark/light checked. 138 deployment remains paused; no paid inference, live platform publication or new installer. [Evidence and limitations / 证据边界](docs/chat-progress-capsule-2026-10-20.md).

## 0.3.6 · 2026-10-19 · Session freshness, ClawHub downloads and failure receipts

- Pin `ownerHandle` when downloading a ClawHub archive; duplicate slugs otherwise return HTTP409. / 修复同名多作者技能下载漏传作者，保留官方409分类。
- Visible Accounts/Publish pages refresh every minute, recheck online conclusions after two minutes and wake on focus/network recovery. Manual refresh and publication bypass the online cache; background checks pause while hidden or during the page's QR flow, remain serial and preserve newer account changes. / 失效结果跨组件与标签页同步；过期/未知不计为已连接，本地标记不能覆盖新失效结论，检查失败保留身份但提示待确认。
- Bounded API journals and browser callbacks correlate failure IDs and retain stage/platform/build metadata. Publication reports account/media preflight blocks, identity and submission errors, and new failed/login-required receipts without retrying content. / 字段白名单排除标题、正文、素材路径、凭据与错误原文；沿用认证、轮转与限流。
- Backend 218 and frontend 124 focused checks pass; production build/lint pass (20 existing warnings). Isolated real-browser checks cover expired-cache -> periodic offline detection -> publication blocked -> persisted error ID; official PPT download/import was separately verified in a temporary directory on 138. Host 138 remains 0.3.5 / `193278acf42f`; deployment is explicitly paused and live publication remains unverified. [Details / 详情](docs/clawhub-failure-events-2026-10-19.md).

## 0.3.5 · 2026-10-19 · Cancel owned login flows / 结束所属扫码流程

- 关闭扫码窗口等待启动响应并取消对应attempt；结束前拦住新登录，失败可重试。Closing a QR dialog waits for startup and cancels only its owned attempt before allowing another login.
- 后端等待子进程实际退出才释放名额；HTTP断开后继续结算，旧请求不能结束新重连，已确认登录等待保存且保留success。Disconnected clients cannot release reservations early; stale cancellation cannot stop a newer runner; confirmed logins finish persistence.
- 保留Cookie/profile和既有作品；取消状态停止轮询、隐藏旧二维码。Profiles remain intact and cancelled flows no longer poll or expose stale QR images.
- 验证：后端155项、前端50项、build/lint（20个既有warning），隔离真实浏览器键盘关闭、结算状态和切平台通过。真实平台登录/身份/上传/发布按用户要求暂停，138隔离/正式已运行0.3.5 / `193278acf42f`，HTTP认证、版本和前端资源摘要通过。[实现与验收](docs/account-login-cancellation-2026-10-19.md)。

## 0.3.4 · 2026-10-19 · Platform login admission / 平台登录资源冲突

- 自动账号核验串行并在扫码期间停止后续检查，收到429不再连打全部平台；本标签页的手动核验与登录启动共用队列。Account checks and login startup share a serial queue.
- 浏览器名额在新登录进程启动前申请，已有二维码复用、凭据表单不额外占位；手动重连确认旧进程退出后立即释放，异常启动归还名额，HTTP断开不提前释放活任务。Reconnects reuse the active runner; restart retains the single-task limit.
- 登录成功等待profile写入进程退出，再显示成功/触发身份核验，避免保存与读取争用。Wait for profile persistence before reporting login completion.
- 验证：后端140项、前端46项及build/lint通过；138正式激活与用户扫码验收分别记录于[平台测试矩阵](docs/platform-login-testing-2026-10-19.md)。未公开发布内容，安装器未更新。

## 0.3.3 · 2026-10-19 · ClawHub import and selection / ClawHub导入选择

- ClawHub说明拆分YAML元信息和正文，渲染经过清理的Markdown，不自动加载外部图片。Author metadata and sanitized Markdown are displayed separately.
- 创作框支持按明确作者和固定版本“导入并选择”；文件存放在持久数据目录，保存失败或风险拦截不计入选择；已导入项可选择/移除并保持真实显示名。Imports persist with owner/version provenance and resolve to actual source paths in both Web and CLI.
- 导入仅保存文件，不执行脚本或安装钩子；限制归档体积/数量并拒绝越界路径和链接，不覆盖内置或其他作者技能。Import never executes hooks or shadows bundled skills.
- 模型列表和推理检测带明确Easel User-Agent，兼容拒绝默认Python标识的上游。Model probes explicitly identify the Easel client.
- 验证：后端定向144项、前端ClawHub/收藏/依赖11项通过；生产build/lint通过（0错误，20条warning）。138正式已运行0.3.3/dd33c38f02e4，HTTPS/登录/网关、199个原文件摘要、完整最小模型对话和ClawHub导入选择/刷新留存通过，390px技能选择及浏览器面板已核对。[发布回执](docs/release-138-0.3.3-2026-10-19.md)记录启动租约恢复及首次导入目录提示等限制。Production activation and focused UI checks passed; external skill execution, all workflows and installers remain outside acceptance.

## 0.3.2 · 2026-10-19 · Linux deployment compatibility / Linux部署兼容

- Include the product version source in the Docker frontend stage; lock PPTX runtime dependencies with wheel hashes. / Docker前端补版本源，Linux锁补PPTX依赖及校验值。
- Connect browser panels to the authenticated sandbox sidecar; connection failures do not launch Chromium inside the app container. / 浏览器面板复用鉴权沙箱，连接失败明确报错。
- Audit host138 disk usage and remove only identified unused build artifacts. New image activation remains pending. / 现场核对138磁盘，定向处理无引用构建产物；新镜像尚未激活。[Evidence / 证据](docs/deployment-138-preparation-2026-10-19.md)。

## 0.3.1 · 2026-10-19 · Explicit chat request protocols / 对话请求协议设置

- Expose the shared protocol selector for built-in and custom chat channels; persist the selected API and use it for discovery, saved probes and OpenClaw requests. No provider-name inference or fallback between protocols. / 所有对话渠道明确选协议，保存、发现、检测与后续请求一致，不按名称猜测或跨协议重试。
- Preserve legacy and unknown configurations, protect gateway-owned protocols, resolve custom discovery credentials by exact identity, and keep import compatibility aligned with saved APIs. / 保留旧配置与未知值、说明网关管理边界，修复自定义渠道列表身份，导入按当前协议匹配。
- Fix narrow provider header geometry; 225 backend and 72 frontend focused checks, build/lint and isolated browser checks pass. No live supplier call or deployment. / 修复窄卡标题排版；定向后端225项/前端72项、构建/lint与隔离浏览器检查通过，未真实推理或部署。[Details / 详情](docs/model-protocol-settings-2026-10-19.md)。

## 0.3.0 · 2026-10-19 · Browser panel and auxiliary-chat expansion

- Major feature release from 0.2.8. Adds the redesigned browser panel, default icons for panel and web tabs, and explicit source-versus-running-version identification. Version source: `pyproject.toml`; the Vite UI embeds the same version.
- Source release only. The verified 138 deployment remains 0.2.8 / `12f144c8848fc8a2fbc49a1acbfbbde1e63bb681`; 138 was not changed in this work.
- Validation: 1,148 frontend tests, 23 final focused checks, 29 backend browser/version checks, lint (0 errors; 18 existing warnings) and production build pass. Desktop light/dark screenshots, default/site icons and menu keyboard actions verified in isolation. The 390px viewport override did not take effect, so this revision's narrow-screen visual check remains pending. See [verification and limits](docs/browser-redesign-version-2026-10-19.md).
- Evaluated TypeSafe Jev for optional content checks; no SDK, credentials or model calls added. It does not replace the chat model or Subagent lifecycle implementation. / 完成Jev选型评估，建议先评中文内容质检，当前不作为核心依赖。[评估](docs/jev-evaluation-2026-10-19.md)。


Changes maintained by [StarrySea1412/Easel](https://github.com/StarrySea1412/Easel) are documented here, with earlier upstream history retained. Current feature development is on `codex/creator-workflow`.

## 2026-10-19 · Shared Chromium browser and Agent observations / 共享浏览器运行时

- Real per-chat Chromium tabs, navigation, screenshot/DOM/text/log observations and verified actions; retain the page reader mode. / 每对话独立Chromium标签，导航及版本化截图/DOM/正文/日志、操作后观察，保留正文读取模式。
- Shared Codex dynamic tool and local CLI bridge for resumed threads/OpenClaw; current-session image evidence follows existing attachment paths. / 新Codex线程注册浏览器工具，旧线程与OpenClaw通过CLI共享同页；截图接入现有会话附件与视觉输入。
- Fix redirect-hop guarding, early cancellation, empty-session slot usage and coordinate-click navigation races. / 修复重定向逐跳校验、早期取消、空面板占用会话及坐标点击导航竞态。
- 40 backend / 58 targeted frontend tests, build/lint and real isolated browser UI pass; real model quality and deployment remain unverified. / 40项后端、58项前端定向、构建/lint和真实隔离浏览器界面通过；真实模型质量与部署另验。[Details / 详情](docs/browser-runtime-2026-10-19.md)。

## 2026-10-19 · Panel launcher and browser page evidence / 新增面板与网页证据

- Replace the sidebar-wide auxiliary-chat entry with a full panel launcher; files, browser, terminal, changes and auxiliary chat have independent tabs. / 右栏统一“新增面板”，文件、浏览器、终端、变更与辅助对话作为工具标签，保留关闭重开及更多工具中的目标。
- Reuse current artifacts and read-only execution receipts. Browser reads page text, keeps source/time, preserves failed-read snapshots and explicitly adds analysis evidence to the main draft without auto-sending. / 接入现有产物与只读回执；浏览器读取正文、展示来源时间、失败保留快照，“分析此页”显式加入主草稿且不自动发送。
- Prefer useful semantic HTML regions over navigation, keeping the body fallback. / 优先语义正文区域，避免导航占满引用，保留普通网页回退。
- 29 targeted frontend / 13 backend reader tests, build and lint pass (18 existing warnings); desktop/390px UI verified with explicit fixtures, plus separate live HTTP reading. No live model call, service restart, 138 deployment or installer update. / 前端定向29项、读取后端13项、构建/lint通过；桌面及390px用显式fixture验UI，另验真实HTTP读取。未调用真实模型、重启服务、部署138或更新安装包。[Details / 详情](docs/panel-home-browser-research-2026-10-19.md)。

## 2026-10-19 · Auxiliary chat and Subagent observability / 辅助对话与子任务观测

- Reuse the main composer in auxiliary chats, with child-scoped attachments/skills/model/effort, streaming, questions, Codex approvals, stop retry and artifacts. Only accepted sends clear the child draft. / 辅助对话复用主输入区，接入素材、技能、模型、思考强度、流式状态、问答、Codex审批、停止重试及产物；仅接收成功清理子草稿。
- Persist closed tabs and reopen the original session; inherit the parent engine/persona and reconnect pending child turns. / 关闭标签保留记录及后台任务，重开原会话；新建继承父引擎/画像，刷新恢复既有子轮次。
- Add identity/time-checked child reply summaries and spawn/status events to Agent Office. A reply is separate from completion; parent end does not prove child termination. / 办公室新增核验身份与时间的子回复及委派/状态事件；回复不等于完成，父轮结束不推定子任务停止。
- Research Codex, DeepSeek Harness, Grok Bot and installed ZCode 3.16.1; document remaining durable-directory, follow-up and cancellation-settlement gaps. No live model call, backend restart, host 138 deployment or new installer. / 调研四个产品并明确持久目录、追问及取消结算差距；未调用真实模型、重启后端、部署138或更新安装包。[Details / 详情](docs/sidechat-subagent-deepening-2026-10-19.md).
- Validation: 1,136 frontend tests and 159 targeted backend tests passed; build and lint passed (18 existing warnings). / 验证：前端全量1136项、后端定向159项、构建与lint通过（18个既有warning）。


## 2026-10-18 · 自动沿用 drops its hint line / “自动沿用”去掉说明文字

- The model menu's first entry now reads just 自动沿用 — the “未单独指定时使用设置中的默认模型” line was redundant for a one-word concept, and other entries keep their descriptions. / 模型菜单首项只保留“自动沿用”四字，去掉“未单独使用设置中的默认模型”这行说明；其余条目说明不变。1,104 frontend tests, lint (0 errors), build pass. / 前端 1104 项测试、lint（0 错误）、构建通过。

## 2026-10-18 · Quieter notification rows: jump = read, hover-only check / 通知行精简：跳转即已读、✅ 只在 hover 出现

- The row's right edge drops the jump chevron and the always-on check: clicking the message already jumps and marks the notice read, so the check now only appears while the row is hovered (or keyboard-focused) and read rows render no check at all — no grey placeholder. The state column keeps its width so rows stay aligned. / 行右侧去掉跳转箭头 › 与常驻已读勾 ✓：点击消息本身就是“跳转＋标为已读”，✅ 只在行 hover（或键盘聚焦）时出现，已读行完全不渲染勾（不再有灰色占位）；右侧列保留占位宽度，行不跳动。
- Keyboard path unchanged: Tab reaches the check, `:focus-within` reveals it, and clicking it still returns focus to the filter button. 1,104 frontend tests, lint (0 errors), build pass. / 键盘路径不变：Tab 可聚焦该勾、`:focus-within` 使其显现、点击后焦点回到筛选按钮。前端 1104 项测试、lint（0 错误）、构建通过。

## 2026-10-18 · Sidebar 对话 entry overviews every conversation status / 侧边栏“对话”入口总览所有会话状态

- The rail's 对话 entry now carries the same status vocabulary as the conversation list: a spinning loader while a conversation runs (or stops), and colored dots for real outcomes (green 已完成, red 失败/需处理, amber 待验收/待输入/排队/待核实, gray 已停止/已暂停). / 工具栏“对话”入口使用与对话列表完全相同的状态语言：进行中/停止中显示旋转 loading 图标，真实结果用状态点（完成绿、失败/需处理红、待验收/待输入/排队/待核实琥珀、已停止/已暂停灰）。
- It overviews ALL conversations: statuses are ordered by urgency (running → failed → … → completed), up to three chips render in full and a compact “+N” appears beyond that; hover and the accessibility description summarize per-state counts (“运行中 · 失败 2 · 已完成”). Plain chats and imported backups stay clean, so the entry is unmarked when nothing has an outcome. / 覆盖全部会话：按紧急度排序（运行中→失败→…→已完成），≤3 个全显示、超出显示“+N”；hover 与读屏给出逐状态计数（如“运行中 · 失败 2 · 已完成”）。普通闲聊与导入备份不显示；无任何状态时入口保持干净。
- The numeric running badge was replaced by this cluster (the count still lives in the expanded list's run summary). 1,103 frontend tests, lint (0 errors), build pass. / 原数字角标由该聚合角标取代（运行计数在展开列表的运行摘要中保留）。前端 1103 项测试、lint（0 错误）、构建通过。

## 2026-10-18 · Model menu: 自动沿用 plus a pinned 模型设置 footer / 模型菜单：“自动沿用”＋“模型设置”固定底栏

- The first entry of 本轮使用模型 is now 自动沿用 (was 沿用会话模型); the same wording is used in the breakdown fallback hint and the settings “saved default” note. / “本轮使用模型”首项文案改为“自动沿用”（原“沿用会话模型”）；拆解页回退提示与设置面板“已保存默认”指引同步改为“自动沿用”。
- 模型设置（管理模型）moved out of the scrolling candidate list into a pinned footer separated by a rule, so it stays reachable no matter how many models exist; the candidate list above scrolls on its own. / “模型设置（管理模型）”从可滚动候选列表中移出，成为带分隔线的固定底栏——模型再多也不随列表滚走，上方的候选列表独立滚动。
- Implemented as an optional `footer` on the shared Select (virtual last entry for keyboard navigation): Arrow keys reach it from the last model, Home/End/Enter work, `aria-activedescendant` points at it, and selects without a footer render exactly as before. 1,102 frontend tests, lint (0 errors) and build pass. / 以共享 Select 的可选 `footer` 实现（键盘导航视作列表末尾虚拟条目）：方向键从最后一个模型可移到它、Home/End/Enter 可用、`aria-activedescendant` 指向底栏；无 footer 的其它下拉外观与行为不变。前端 1102 项、lint（0 错误）、构建通过。

## 2026-10-18 · Rename in the outputs library / 内容库支持重新命名

- Every card in 内容库 now offers 重命名 beside 删除: the name becomes an inline editor (Enter saves, Escape or blur cancels, an unchanged name sends nothing) and the list reloads with the new name; folder cards rename whole directories. / 内容库卡片在“删除”旁新增“重命名”：名称就地变输入框（Enter 保存、Esc/失焦取消、与原名相同不发请求），保存后列表刷新；文件夹卡片整目录改名。
- Backend `POST /api/output/{path}/rename` reuses the delete route's guards — outputs-only targets, 403 on protected system data, 400 on blank names or path separators, real 409 on collisions — and keeps the original extension so typing “会议记录” for `notes.md` yields `会议记录.md` (an explicitly typed suffix is not doubled). Image-generation prompt sidecars (`.<name>.easel-image.json`) move with their image. / 后端 `POST /api/output/{path}/rename` 复用删除路由的防护——仅限内容库内、系统数据 403、空名/路径分隔符 400、同名冲突如实 409——并保留原扩展名（`notes.md` 输入“会议记录”得到 `会议记录.md`，显式带后缀不重复追加）；生图提示词旁车随图片一起改名。
- Tests: backend 5 (`tests/test_outputs_rename.py`), frontend 1,101 (new jsdom `outputs-rename` flow: Enter posts the right URL/body and refreshes, Escape cancels, same-name no-op). The 7880 backend needs a restart for the new route. / 后端 5 项（`tests/test_outputs_rename.py`）、前端 1101 项（新增 jsdom 改名流程：Enter 按正确 URL/请求体提交并刷新、Esc 取消、同名不发请求）。7880 需重启后端后新路由生效。

## 2026-10-18 · Editable skill metadata with tags, presets and auto-classification / 技能可编辑元数据：标签、预设分类与自动分类

- Skills now carry an editable metadata layer (`<DATA_DIR>/skill-meta.json`): display name, description, tags and category, merged into `/api/skills` without touching third-party SKILL.md files; a 分类筛选 row and tag chips appear on the 技能库 grid, and each card's drawer hosts the editor with preset + custom categories (新建并选用). / 技能新增可编辑元数据层（`<DATA_DIR>/skill-meta.json`）：显示名、描述、标签、分类，合并进 `/api/skills`、不改第三方 SKILL.md 本体；技能库出现分类筛选与卡片标签，抽屉内可编辑（预设分类＋自定义“新建并选用”）。
- 自动分类 offers an offline rule engine (zero cost, keyword rules → tags with a preset category) and a “用 AI 识别” path that calls your configured default model through the existing single-completion runner; results preview before applying and only fill gaps —手动设置过的分类与标签永不被覆盖. / 自动分类提供离线规则（零成本，关键字→标签＋预设分类）与“用 AI 识别”（经既有单次补全通道调用你配置的默认模型）；结果先预览后应用、只补齐缺口，手动设置过的分类与标签不被覆盖。
- Backend: `web/skill_meta.py` (store + validation + rules/AI classify) with four routes; tests: skill-meta backend pytest 5, frontend 1,098 (filters, chips, classify preview/apply). / 后端 `web/skill_meta.py`（存储/校验/规则与 AI 分类）四条路由；后端 5 项、前端 1098 项测试。7880 需重启后端后新路由生效。

## 2026-10-18 · Skills nav jump fix / 技能库侧栏跳转修复

- Jumping scrolls the known page container with rect math instead of `scrollIntoView`, and lands instantly (smooth animation proved to be throttled in the embedded/background environment). The scroll-follow highlight uses the same rect math. Verified live: clicking 发布 21 moves the page to the section, 发现 brings it back. / 跳转改为精确滚动已知容器（rect 计算）并**即时落位**——实测平滑动画在嵌入/后台环境会被节流推迟；滚动跟随高亮用同一 rect 判定。7880 实点“发布 21”滚到位、“发现”滚回顶。

## 2026-10-18 · A jump sidebar for the 技能库 sections / 技能库分区侧边栏直接跳转

- The empty left gutter of 技能库 is now a sticky section sidebar: one row per pipeline layer (icon, name, count) that jumps straight to that section, plus 回到顶部; scrolling keeps the current section highlighted (`aria-current`), keyboard reachable, hidden under 900px without touching the existing layout. / 技能库左侧留白改为粘性分区侧边栏：每个流水线层一行（图标＋名称＋计数），点击直接跳到对应分区，并带“回到顶部”；滚动时高亮当前分区（`aria-current`）、键盘可达，<900px 隐藏且不影响现有布局。
- 1,097 frontend tests (new deterministic section-nav case with injected geometry), build, lint (0 errors). / 前端 1097 项（新增分区导航用例，显式注入几何使滚动高亮可断言）、构建、lint（0 错误）。

## 2026-10-18 · Capacity basis moves into an ⓘ hover / “容量依据”收进 ⓘ 悬停

- The context-usage panel no longer keeps the capacity-basis block on screen: an ⓘ beside the used/total percentage carries the basis line, the official window with its source address (plain text, since hover tooltips are not clickable), the runner/session limits and the early-compaction warning. The “核对模型上下文设置” button and the existing 统计口径 ⓘ stay. / 上下文容量面板不再常驻容量依据块：占用总量旁新增 ⓘ，悬停/聚焦展示占比依据、原厂标称与来源地址（纯文本——悬停浮层不可点击，如实说明）、运行器/会话限制与提前压缩警告；“核对模型上下文设置”按钮与既有 统计口径 ⓘ 不变。
- Dead `.context-window-facts` styles removed; the panel test now asserts the block is gone from the visible panel and present in the hover. 1,096 frontend tests, build, lint (0 errors). / 清理死样式；用例改为断言可见面板不含该块、悬停内含全部段落。前端 1096 项、构建、lint（0 错误）。

## 2026-10-18 · Conversation share MCP: complete share, takeover, load-back / 对话分享 MCP：完整分享、接管与回传

- New `web/conversation_share.py` (store + routes under `<DATA_DIR>/conversation-shares/`) and an stdio MCP server `mcp/conversation_share_mcp.py` (newline JSON-RPC, zero deps, same convention as easel-notify): `share_conversation` publishes the complete transcript, `read_conversation_share` gives an external model the full context to take over, `append_to_shared_conversation` records its output, and `easel-share://<token>` exposes it as a resource. / 新增分享存储与路由（`<DATA_DIR>/conversation-shares/`）和 stdio MCP 服务（逐行 JSON-RPC、零依赖、与 easel-notify 同约定）：`share_conversation` 发布完整快照，`read_conversation_share` 让外部模型拿到全量上下文接管，`append_to_shared_conversation` 记录接管产出，`easel-share://<token>` 作为资源只读暴露。
- The chat header gains 分享 and 加载接管内容: appends merge back into the original conversation with `appendId` dedupe and a “来自分享接管 · 来源 · 时间” label, persisted through the store whitelist so reloads neither lose nor duplicate them; a previously missed child-session persistence gap (`parentSessionId` dropped by `decodeSessions`) was fixed with a round-trip test. / 会话头部新增「分享」与「加载接管内容」：追加按 `appendId` 去重、标注来源与时间合并回原对话，经由存储白名单持久化（刷新不丢不重）；顺带修复 `decodeSessions` 丢失 `parentSessionId`（辅助对话刷新后会回到主列表）的问题并加了往返测试。
- Research: ZCode 3.15.3 local evidence (public_importable shares with artifacts, task fork) plus reachable official pages for Cursor/VS Code/Claude Code; ChatGPT/Claude/Devin/Open WebUI marked as unreachable pages per policy. Nobody ships load-back into the original conversation — that is this round's differentiator. / 调研：ZCode 本机实证（public_importable 分享含产物、任务分叉）＋ Cursor/VS Code/Claude Code 可达官方页；ChatGPT/Claude/Devin/Open WebUI 页面不可达按约定标注。没有竞品做“回传原对话”，这是本轮差异点。
- clawhub-style note: the 7880 backend needs a restart for the share routes; the MCP server and the client are ready. Backend 10 new tests + frontend 1,096 tests, build, lint (0 errors). / 7880 后端需空闲重启后分享路由才生效（MCP 与前端已就绪）。后端新增 10 项测试、前端 1096 项、构建、lint（0 错误）。

## 2026-10-18 · Side panel with an auxiliary chat (variant C, MVP) / 对话侧边面板与辅助对话（方案 C 首版）

- The chat page gains a right side panel: collapsible, resizable (width persisted locally), tabbed — 辅助对话 plus 目标 (the existing goal panel moves in as its tab; the 查看当前目标 button still opens it). / 对话页新增右侧面板：可收起、可调宽（宽度本机记忆）、多标签——“辅助对话”与“目标”（原目标面板并入为标签，“查看当前目标”行为不变）。
- 辅助对话 is a child session of the current conversation (research: ZCode's selection-side-chat + Cursor's /side): entries are the header button and the composer command menu (/side, /btw); it keeps its own transcript, never joins the main message flow, and stays out of the session list. The parent's last exchange can be quoted into the side draft, and the side reply can be quoted back into the main draft — both explicit, nothing is injected automatically. / 辅助对话是当前会话的子会话（依据 ZCode selection-side-chat 与 Cursor /side 的调研）：入口为头部按钮与命令菜单（/side、/btw）；独立记录、不进入主消息流、不出现在会话列表；可把主对话上一轮引用进侧边草稿、把侧边答复引用回主草稿——均为显式操作，不自动注入。
- No paid model call is made by opening the panel; sending still goes through the normal gateway path. 1,092 frontend tests, build, lint (0 errors). / 打开面板不产生任何模型调用；发送仍走既有网关链路。前端 1092 项、构建、lint（0 错误）。

## 2026-10-18 · ClawHub counters are visible / ClawHub 统计数字可见

- The registry's public counters — downloads, installs, stars, versions and comments — are now fully mapped by the backend (comments was dropped before) and search results carry them too (from `native.skill.stats`). There is no GitHub-style issue tracker upstream, so the UI shows the real comment count instead of inventing one. / 上游公开计数（下载/安装/星标/版本/评论）已完整映射（此前丢了评论），检索结果也携带统计（取自 `native.skill.stats`）；上游没有 GitHub 式 issues，界面展示真实的评论数而非虚构。
- Both ClawHub surfaces show “下载 X · 评论 Y” on result rows and the full set on the detail pane (missing values are omitted, 万-compressed). Note: the 7880 backend needs a restart for comments/search-row counters; the detail's downloads/installs/stars/versions show immediately. / 两处结果行显示“下载 X · 评论 Y”，详情显示全量（缺项省略、万位压缩）。7880 旧后端需重启后评论与检索行统计生效，详情的下载/安装/星标/版本立即生效。
- clawhub pytest 19, 1,087 frontend tests, build, lint (0 errors). / clawhub 后端 19 项、前端 1087 项、构建、lint（0 错误）。

## 2026-10-18 · ClawHub loading states get real skeletons / ClawHub 搜索与详情加载改用骨架屏

- Both ClawHub surfaces — the 技能库 panel and the chat composer's skill picker — now show shimmer skeletons while loading: three result/card skeletons during search and a title/meta/body skeleton while the author notes load, instead of a lone text line above empty space. The loading text stays in the accessibility tree (`role=status` + `.sr-only`). / 技能库面板与对话技能选择器两处：搜索中显示 3 个结果/卡片骨架，详情加载显示标题/元信息/正文骨架（shimmer），不再是一行字加空白；加载文案保留在无障碍树（`role=status` + `.sr-only`）。
- 1,087 frontend tests, build, lint (0 errors). / 前端 1087 项、构建、lint（0 错误）。

## 2026-10-18 · Skill verification opens on hover and leads with what was called / “Skill 核验”改为悬停展示并先回答“有没有调用”

- The chip's evidence panel no longer needs a click: hover or focus opens a floating panel (the pointer can move into it; click pins it for touch; Escape/outside closes), and it loads the turn's audit automatically on first open — showing “本轮已调用：A、B” with per-skill 执行成功（有证据）/失败/已尝试/已读取说明 states plus evidence bullets, or the honest “未观察到 Skill 调用证据 / 未找到本轮记录” line; 查看运行记录 stays. / 芯片证据面板不再需要点击：悬停或聚焦弹出浮层（指针可移入；点击可钉住供触屏；Escape/外点关闭），首次打开自动加载本轮核验——先给出“本轮已调用：A、B”，逐技能显示执行成功（有证据）/失败/已尝试/已读取说明与证据条目，或如实显示“未观察到调用证据/未找到本轮记录”；“查看运行记录 →”保留。
- Reading a guide is explicitly not an invocation; a failed load offers 重新读取 instead of looping requests. 1,087 frontend tests, build, lint (0 errors). / 读取说明不等于执行；加载失败提供“重新读取”而不循环请求。前端 1087 项、构建、lint（0 错误）。

## 2026-10-18 · One right-edge action per notification row / 通知行右侧不再竖排堆叠

- The unread dot moved next to the timestamp in the meta line, and the right column now holds only the centered “mark read” check — no more dot stacked above the check. Unread/read semantics, aria labels, filters and “全部已读” stay unchanged. / 未读点移到元信息行时间右侧，右侧只保留居中的“标为已读”勾按钮，不再上下堆叠；未读/已读语义、无障碍标签、过滤与“全部已读”不变。
- 1,086 frontend tests, build, lint (0 errors). / 前端 1086 项、构建、lint（0 错误）。

## 2026-10-17 · One rename entry per row / 会话行不再重复“重命名”图标

- The session row no longer shows its own rename pencil on hover — the hover card's title (with its pencil) is the single visible rename entry, alongside F2 and the “…” menu; the row keeps the pin, running indicator and the menu. Dead row-button styles removed. / 悬停会话行不再显示行内重命名铅笔——悬停卡片标题（带铅笔）成为唯一可见入口，F2 与“…”菜单重命名不变；行内保留置顶、运行指示与“…”菜单，行内按钮死样式已清理。
- 1,086 frontend tests (sidebar hover case now enters rename through the card), build, lint (0 errors). / 前端 1086 项（会话悬停用例改为卡片重命名路径）、构建、lint（0 错误）。

## 2026-10-17 · Dense explanation text now lives in ⓘ hovers / 详细口径说明收进 ⓘ 悬停

- The context-usage panel's “统计口径 · 快照参考” block is gone: the ⓘ next to 上下文容量 carries all five paragraphs (dynamic note, breakdown note, char/token estimate, skills note, capacity source) on hover/focus, and the 快照参考 (stale) marker moved onto the snapshot line so it stays visible. / 上下文容量面板的“统计口径 · 快照参考”折叠块移除：标题旁 ⓘ 悬停/聚焦承载全部 5 段（动态 note、分类说明、字符换算、技能注记、容量来源），`快照参考`（stale）标记移到快照行保持可见。
- The usage panel footer keeps the “数据来源与统计口径 · OpenClaw / Codex · 非服务商账单” line, live issues and the update time visible; the static notes (channel/cost/performance/pricing/scope) moved into the ⓘ hover. / 用量面板页脚保留“数据来源与统计口径 · OpenClaw / Codex · 非服务商账单”可见行、动态 issues 与更新时间；静态说明（渠道/成本/性能/定价/范围）进入 ⓘ 悬停。
- `InlineInfo` gained an opt-in `wide` tooltip; everything else about the shared component is unchanged. 1,086 frontend tests, build, lint (0 errors) and browser checks. / `InlineInfo` 新增可选 `wide` 宽条（多段文案适配）；共享组件其余行为不变。前端 1086 项、构建、lint（0 错误）与浏览器核对。

## 2026-10-17 · ClawHub skill search can be bookmarked / ClawHub 技能检索可收藏

- Search results and details in both ClawHub surfaces — the 技能库 panel and the chat composer's skill picker — now carry a ☆ toggle; the 技能库 panel adds a 我的收藏 section (查看详情、移除收藏、官方页面). / 技能库 ClawHub 面板与对话技能选择器两处的搜索结果和详情都加了 ☆ 收藏开关；技能库面板新增“我的收藏”区（查看详情、移除收藏、官方页面）。
- Favorites are local bookmarks of public metadata only (`easel:skill-favorites`, 100 max) and never install or run anything; a failed local save keeps the star honest and reports it. / 收藏只是公开元数据的本地书签（`easel:skill-favorites`，最多 100 条），绝不安装或运行；本地保存失败时不虚标“已收藏”并如实提示。
- 1,086 frontend tests (favorites round-trip and storage-failure cases added), build, lint (0 errors) and browser checks. / 前端 1086 项（新增收藏持久化与存储失败用例）、构建、lint（0 错误）与浏览器核对。

## 2026-10-17 · Explicit starts only, and status dots as real signals / 只有显式入口新增对话，状态点只在有真实结果时出现

- Only the two explicit entries add a conversation row — the sidebar 新建对话 button and the dashboard 开始创作 composer. 看热点“一键做成内容”、技能开聊 and 爆款拆解 now merge into the selected conversation (with a fresh row only when there is nothing safe to merge into: no selection, a backup import, or a still-running session). / 只有两个显式入口会新增列表条目——侧栏“新建对话”和工作台“开始创作”；看热点“一键做成内容”、技能开聊、爆款拆解并入当前选中的对话（没有可安全并入的会话时才新建：未选中、备份导入或仍在运行）。
- Status dots became signals instead of decoration: a plain finished chat no longer keeps a permanent green dot; green shows for a finished task run or an accepted goal, red stays for failures, and running/stopping rows now use a spinning loading icon instead of a pulsing dot. / 状态点从装饰变回信号：普通聊天结束不再常驻绿点；任务执行完成或目标通过验收才亮绿，失败保持红点；运行/停止中的行改用转圈的 loading 图标，不再用脉冲圆点。
- 1,084 frontend tests, build, lint (0 errors) and browser checks on the sidebar list. / 前端 1084 项、构建、lint（0 错误）与侧栏列表浏览器核对。

## 2026-10-17 · The goal chip appears only in conversations that have a goal / “目标”按钮只在有目标的对话中出现

- The composer's 目标 chip no longer sits in goal-less conversations: it shows only while the conversation has a goal (any status) or while goal setup is open, and setting stays on `/goal`, `/目标` or the `/` command menu (the typed text becomes the objective). / 没有目标的对话不再常驻“目标”按钮：仅当对话已有目标（任意状态）或正在设置目标时显示；设置入口保持 `/goal`、`/目标` 或 `/` 命令菜单（输入内容即目标）。

## 2026-10-17 · Pro polish: one radius ladder, no half-pixel type / 界面“更 pro”：圆角与字号收敛

- Every `border-radius` now comes from one ladder — 6 / 8 / 12 / 16 / 20 px plus pill (`--radius-xs/sm/md/lg/xl/pill`; `--radius` kept as an 8px alias) — replacing 12 mixed raw values across 65 CSS files; only intentional 2/3px decorative dots and 50% circles stay raw. / 全库 border-radius 收敛为 6/8/12/16/20 + pill 五档 token（`--radius` 保留为 8px 兼容别名），替换 65 个 CSS 文件中的 12 种混杂数值；仅保留装饰性 2/3px 小形状与 50% 圆形。
- Half-pixel font sizes are gone: 11.5 → 11 / 12.5 → 12 / 13.5 → 13 (rounded down, so no text grows or re-wraps). / 半像素字号去除：11.5→11、12.5→12、13.5→13（向下取整，不引入任何文字变大与换行风险）。
- Monospace collapsed to a single `--font-mono` stack (was three variants); inline TSX radii (buttons, badges, skeleton) use the tokens as well. / 等宽字体统一为 `--font-mono`（原 3 种写法）；TSX 内联圆角（按钮、徽标、骨架屏）同步走 token。
- No functional or interaction change. 1,082 frontend tests, build, lint (0 errors) and dark/light + 390px browser checks on 工作台/对话/设置/定时任务. / 功能与交互零变化；前端 1082 项、构建、lint（0 错误）与浅/深色、390px 浏览器核对。

## 2026-10-17 · Goals live in the conversation / 目标归于对话

- The command menu now stays inside the conversation column (anchored to the composer, width follows the composer, never overlapping the sidebar or session list) and drops up when space is tight. / “对话命令”菜单只在对话区内弹出（锚定输入框、宽度随输入框，不压侧栏与会话列），空间不足时向上弹出。
- Goal mode aligned with Codex: the composer text is the goal; the 可衡量结果/执行选项 settings form is gone; completion defaults to delivered evidence + explicit user confirmation; limits keep the product defaults (5 rounds / 20 min / 40 tools / 0 images, still recorded). Model confirmation and stop/verification semantics are unchanged. / 目标对齐 Codex：输入框内容即目标；去掉“可衡量结果/执行选项”设置表单；完成默认=交付证据+用户确认；上限沿用默认（5轮/20分钟/40工具/0图，记录中保留）。模型确认与停止/验收语义不变。
- The 定时任务 page keeps only scheduled plans: the goals list and the goal-creation branch are removed — goals are managed entirely in conversations. / “定时任务”页只留定时计划：移除“对话目标”列表与目标创建分支，目标完全由对话管理。
- Read the local ZCode 3.15.3 bundles (read-only; extracts in an ignored output dir) and recorded how ZCode implements goals (`session/goal` protocol, goalStats, independent verification timeline) and its “进程” panel (the TodoWrite list in the status panel) in a comparison doc. / 只读解析本机 ZCode 3.15.3 bundle，记录目标（`session/goal` 协议、goalStats、独立验收时间线）与“进程”（状态面板里的 TodoWrite 待办列表）实现，形成对照文档。
- Verified 1,082 frontend tests, production build, lint (existing warnings only) and real-browser checks of the menu position, goal composer and 定时任务 page. No paid model, host 138 or installer changes. / 前端 1082 项、生产构建、lint（仅既有警告）与真实浏览器核对菜单定位、目标输入区与定时任务页；未调用付费模型、未改 138 与安装包。

## 2026-10-17 · ComfyUI demo mode and info-hover explanations / ComfyUI 模拟运行与说明悬浮展示

- The ComfyUI panel stays usable without a configured workflow: a local “模拟运行” renders an ffmpeg placeholder clip (clearly badged 模拟, labelled in the artifact registry as non-model output) through the same job lifecycle, with cancellation that leaves no file; live submission stays fail-closed and is still the only paid path. / 未配置工作流时面板仍可用：本地“模拟运行”经同一作业生命周期生成清晰标注的占位视频（琥珀“模拟”徽标，产物登记注明非模型输出），取消不留文件；真实提交仍保持 fail-closed，且始终是唯一付费通道。
- Explanations moved out of collapsed blocks: the ComfyUI heading, cinematic-parameter summary, video-studio “模型与生成说明” and the notification footer storage note now use the info-icon hover/focus tooltip (`InlineInfo hover`). / 解释性文案移出折叠：ComfyUI 标题、镜头参数摘要、视频工坊“模型与生成说明”和通知面板存储说明改用 ⓘ 图标 + 悬停/聚焦浮层。
- First commit the pending workspace ComfyUI work on its own (`bd26881c`, plus a placement fix `fd3f058b`) so this round builds on a committed base without touching the outstanding chat-budget work. / 先把并发未提交的 ComfyUI 工作单独提交（`bd26881c`，另有归位修复 `fd3f058b`），本轮在其已提交基线上推进，未触碰仍待提交的 chat budget 工作。
- Verified 57 backend checks (8 ComfyUI, incl. demo completion/cancel/fail-closed), 1,082 frontend tests, build/lint and isolated browser acceptance on 7899 (real service + real panel: demo run, media playback, artifact rows, demo-aware cancel, info tooltips, dark and 390px). No real ComfyUI or paid model call; no 138 deployment or installer update. / 已验证 57 项后端（ComfyUI 8 项，含模拟完成/取消/fail-closed）、前端 1082 项、构建/lint 与 7899 隔离浏览器（真服务+真面板：模拟运行、媒体播放、产物登记、取消文案、ⓘ 浮层、深色与 390px）；未调用真实 ComfyUI 或付费模型、未部署 138、未更新安装包。

## 2026-10-17 · Settings reorg: theme placement and default-on multiagent / 设置页整理：主题归位与 multiagent 默认启动

- Move dark mode out of its standalone 外观 page: the appearance card now lives in 更多设置, and the sidebar gains a one-click light/dark toggle (system-following switches by current appearance; a browser that cannot persist says so). / 深色模式移出独立“外观”页：外观卡片进入“更多设置”，侧栏新增一键浅/深切换（跟随系统时按当前显示切换；无法持久化时如实提示）。
- Multiagent (Agent 协作) defaults to on: a workspace that never saved the card starts on its configured main model at the next backend start (default limits, spawn deny lifted); explicit choices, including an explicit disable, are never overridden. / multiagent（Agent 协作）默认启动：从未保存过的环境在下一次后端启动时按已配置主模型自动启用（默认限额、解除 spawn 阻断）；显式选择（含显式关闭）永不被覆盖。
- The Agent card moves into 模型与渠道 → 对话通道; the toggle presents the default on with the main model preselected, the badge stays honest (未启用 until the config really allows spawn), and saving still requires an explicitly configured startup model. / “Agent 协作”卡片移入“模型与渠道 → 对话通道”；开关默认勾选并预选主模型，徽标保持诚实（配置真实允许前显示未启用），保存仍要求明确选择已配置的启动模型。
- Verified 171 backend checks, 1,078 frontend tests, build/lint and isolated browser acceptance on 7898 (real components + real backend functions: toggle, save, auto-seed default, legacy deep links, 390px). No paid model, 138 deployment or installer update. / 已验证 171 项后端、前端 1078 项、构建/lint 与 7898 隔离浏览器（真组件+真后端函数：切换、保存、启动自播种默认、旧深链映射、390px）；未调用付费模型、未部署 138、未更新安装包。

## 2026-10-17 · Notification inbox cleanup and refinement / 通知收件箱清理与精修

- Only durable events (stable id + jump target) enter the notification inbox; confirmation toasts stay transient, so the inbox no longer stacks duplicate, low-value noise (Apple HIG: repeated notifications fill Notification Center). / 只有持久事件（稳定 id + 跳转目标）进入通知收件箱；确认类提示仅临时弹窗，收件箱不再堆积重复与低价值噪音（Apple HIG：重复通知会塞满通知中心）。
- Add a verified one-tap cleanup for records that older builds persisted from confirmation toasts. It posts to a dedicated `POST /api/notifications/remove` route, so a backend that has not been restarted fails closed instead of clearing everything; removed ids get tombstones so stale tabs cannot revive them. / 为旧版本遗留的提示类记录增加“验证式一键清理”：专用 `POST /api/notifications/remove` 路由，未重启的后端安全失败、绝不退化为清空全部；删除的 id 写入墓碑，旧标签页无法复活。
- Bound notification subjects (whitespace collapse, URL → hostname, 24-char clamp); tighten the panel (header 90→67px, one-line rows 79→65px, sticky date groups, semantic colors only for real outcomes) and move toasts to consistent SVG icons. / 通知标题做空白归一、URL 主机化与 24 字截断；面板头部 90→67px、单行行高 79→65px、日期分组吸顶、语义色只给真实结果；Toast 换用一致的 SVG 图标。
- Verified 88 backend checks, 1,076 frontend tests, production build, lint (existing warnings only) and isolated browser acceptance on 7897 (cleanup 7→3 rows, transient toast never recorded, tombstone blocks stale re-push, 390px no overflow). No paid model, 138 deployment or installer update. / 已验证 88 项后端、前端 1076 项、生产构建、lint（仅既有警告）与 7897 隔离浏览器（清理 7→3、瞬时提示不进箱、墓碑防复活、390px 无溢出）；未调用付费模型、未部署 138、未更新安装包。

## 2026-10-17 · Goals and schedules aligned with Codex / 目标与定时任务对标 Codex

- Add the Codex lifecycle command surface: `/goal` views the current goal, `/goal pause|resume|clear` (暂停/继续/清除) act locally without sending model messages, and the `/` menu lists the commands that match the goal's state with keyboard selection. / 增加 Codex 生命周期命令面：`/goal` 查看当前目标，`/goal pause|resume|clear`（暂停/继续/清除）在对话内本地执行不发给模型，`/` 菜单按目标状态列出可用命令并支持键盘选择。
- User messages now take priority without cancelling the goal; only a live goal round blocks sending, and interruptions pause the objective so it can resume from the recorded state. / 用户消息优先且不再取消目标，仅目标轮次运行中暂不能插话；中断即暂停目标，可从当前记录继续。
- Reaching any execution limit stops substantive work with one deterministic wrap-up (usage, progress, blocker, next step) and never marks the goal complete. / 达到轮次/时长/工具上限时写入一次确定性收尾（用量、进度、阻塞、下一步），明确“达上限≠完成”。
- Scheduled plans add a monthly rule (day of month 1–31, short months skipped, DST-safe preview) and a “needs attention” marker from the latest run; `/定时 <text>` opens the plan form prefilled from chat. / 定时计划新增每月规则（1–31 号、短月跳过、DST 安全预览）与按最近运行标记“需要处理”；对话内 `/定时 <正文>` 打开预填的计划表单。
- Verified 118 backend checks, 1,072 frontend tests, production build, lint (existing warnings only) and isolated browser acceptance on 7896, which caught and fixed a cancelled goal still showing the budget label. No paid model, 138 deployment or installer update. / 已验证 118 项后端、前端 1072 项、生产构建、lint（仅既有警告）与 7896 隔离浏览器验收；验收中发现并修复“已取消目标仍显示已达执行上限”，未调用付费模型、未部署 138、未更新安装包。

## 2026-10-17 · Conversation status dots moved to the left / 对话状态点左置

- Move each session status dot before the title in the sidebar, with a fixed flex slot so completed, failed and running states remain aligned when titles truncate. / 将每条会话状态点移动到侧栏标题之前，并用固定弹性占位保持标题截断时的对齐。
- Preserve the real status normalization, tooltip/error detail, accessible label, running count, hover rename, pinning and keyboard behavior. / 保留真实状态归一、悬浮提示/错误详情、无障碍名称、运行计数、悬浮重命名、置顶和键盘操作。
- Verified 32 focused sidebar tests, production build, lint (existing warnings only), diff check, and the local 7895 browser at desktop and 390px. / 已验证32项侧栏专项、生产构建、lint（仅既有警告）、diff检查，以及7895桌面和390px页面。

## 2026-10-17 · ComfyUI 视频工作流与电影镜头提示词

- Add a fail-closed ComfyUI API workflow adapter with node validation, prompt/history/view polling, cancellation semantics, MP4 verification and ArtifactStore registration. / 增加 fail-closed 的 ComfyUI API 工作流适配器，支持节点校验、prompt/history/view 轮询、取消语义、MP4 校验和 ArtifactStore 登记。
- Add bounded cinematic prompt fields inspired by Melies' camera-language taxonomy, and add an inline ComfyUI panel in the video studio. / 增加参考 Melies 镜头语言分类的有界提示词字段，并在视频工坊加入 ComfyUI 面板。
- Render delivered video artifacts with native controls and refresh/download actions. / 对话产物中的视频支持原生播放、刷新和下载。
- Verified 5 backend ComfyUI tests, 1,066 frontend tests, TypeScript production build, Python compilation and diff checks. No real provider call, 138 deployment or installer release. / 已验证5项 ComfyUI 后端测试、前端1066项、生产构建、Python编译和diff检查；未调用真实服务、未部署138、未更新安装包。

## 2026-10-17 · Inline goal composer correction / 目标入口纠正

### 2026-10-17 · Conversation status dots / 对话状态点

- Replaced visible sidebar completion/failure labels with compact semantic status dots: green for completed, red for failed, blue for running, and amber/gray for intermediate or stopped states.
- Kept status text in `title` and accessible labels so the compact list does not lose meaning or failure context.

- Restored goal setup to the existing chat composer instead of a replacement form: one textarea, preserved draft, toolbar, model, attachments, skills and stop path.
- Added collapsed execution options, explicit model lock after save, idempotent retry, IME-safe Enter/Shift+Enter/Escape handling, and the existing conversation goal panel.
- Verified 1,065 frontend tests, production build, lint (existing warnings only), 7880 entry behavior, and isolated goal execution with HTML preview and progress states. No paid model, 138 deployment or installer update.

## 2026-10-17 · Goal reliability after harness research / 框架调研与目标可靠性

- Audit official Grok Bot, DeepSeek Harness, Codex and ZCode sources; document current capabilities and remaining gaps. / 保留输入区目标与列表运行数、结果Badge。
- Suppress automatic continuation without admitted work tools; stop treating reworded text or step descriptions as progress. Require complete checks, a successful current run and explicit matching human approval. / 失败、停止、漏项与核验异常不冒充完成。
- Scope goal panel errors and pending state to their goal identity. / 66项后端、59项前端、构建/lint及隔离浏览器已验；7880后端未重启，无付费调用，138/安装器另验。[证据与边界](docs/harness-followup-2026-10-17.md)。

## 2026-10-16 · Inline goals and chat status / 输入区目标与对话状态

- Replace the goal modal with an inline composer; keep current model, collapsed execution options, ordinary drafts and retry IDs. / 输入区直接设置，启动失败不重复创建，运行时保留暂停/停止入口。
- Show deduplicated running counts on the chat icon and list; add completion/failure badges and separate stopped, queued, unconfirmed and goal review states. / 状态来自最近轮次回执，不推测旧消息或备份完成。
- 89 focused checks and isolated 390px light/dark keyboard paths passed; build/lint passed with 18 existing warnings. / [用法与验收边界](docs/inline-goals-session-status-2026-10-16.md)，仅本机7880，138/安装器另验。

## 2026-10-16 · Hover rename / 对话悬浮重命名

- Add a hover/focus pencil and F2 shortcut; make preview titles editable inside the floating card. / 跨列表与浮层保留悬浮，编辑期间不因鼠标移出而消失。
- Require explicit save, reject blank titles and respect IME composition; preserve current chat/draft and restore focus. / 保留原菜单与会话持久化，手工改名不调用模型。
- Validate 49 focused checks, build/lint and isolated 390px light/dark browser paths. / [用法及验收](docs/session-hover-rename-2026-10-16.md)，仅本机7880，138/安装器未更新。

## 2026-10-16 · Conversation goal mode / 当前对话目标模式纠正

- Move goal setup into the current chat with `/goal` and `/目标`; add a compact side panel for reported steps, elapsed time, pause/resume and blockers. / 按用户截图纠正主入口，定时任务保留独立管理。
- Persist `easel_goal_update` steps using trusted tool admission and stop/revision barriers; preserve cumulative limits on revision and separate work completion from human quality approval. / 未收到步骤不造计划，未完成步骤不提前完成目标。
- Verify focused backend/frontend checks, build/lint and isolated desktop/390px light/dark keyboard paths. / 本机7880可验；[实现与边界](docs/conversation-goal-mode-2026-10-16.md)，无付费调用，138/安装器未更新。

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
