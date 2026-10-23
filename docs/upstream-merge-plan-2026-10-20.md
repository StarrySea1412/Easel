# 上游 main 拉取规划（2026-10-20，2026-10-21 修订）

> 本文只是整合方案，供审阅后再执行；至今没有 merge、rebase、checkout 或修改业务源码。
> 数据来源：`git fetch origin` 后的真实引用，以及 `git merge-tree --write-tree --no-messages HEAD origin/main` 的只读合并预演（只写 Git 对象库，不碰工作区和索引）。

## 0. 2026-10-21 修订说明

上游在 10-18 之后又走了 26 个提交，10-20 版本文里的引用、冲突数和执行基线已经过期。本文正文已按 10-21 的实际状态改写，下表是两次测量的差异：

| 项 | 10-20 原文 | 10-21 实测 |
| --- | --- | --- |
| 上游 `origin/main` | `8d08b216`（10-18 18:45） | `3f1d4fb8`（10-21 14:46） |
| 上游领先提交 | 201 | **227**（151 功能 + 76 合并） |
| 本分支 HEAD | `8e836509`（未推送） | `cc1b6d46`（**已推送**，与 `starry/` 一致） |
| 本分支领先提交 | 288 | 290 |
| 合并预演冲突 | 56 个文件 | **58 个文件** |
| 冲突新增项 | — | `easel/gateway_endpoint.py`、`skills/shared/scripts/login_state.py` |
| 主工作区未提交项 | 37 | 53（33 已修改 / 20 未跟踪） |

新增的 26 个提交集中在三块，都会随整批合并进入：原生工具预算与截止账本（per-run tool admission、deadline ledger、验证绑定到已认证网关调度）、产物检查点与视频断点续拼（`skills/shared/scripts/artifact_checkpoints.py`、`auto-short-video/assemble.py` 从校验过的镜头检查点恢复）、以及 `openclaw.json` 的 UTF-8 BOM 容错与多处 CI 修复。详见 §3.4。

同时本轮对「上游已修、我们仍是旧实现」的差异做了一次实证抽查（§4.3）：确认 2 处真实缺口（上传整读进内存、回环健康探测被代理劫持），并推翻了 2 处只凭提交说明就该判为缺口的假设。这类抽查应作为合并前必做项，避免把「上游改了」直接当成「我们必须改」。

## 1. 结论

1. **建议整批合并上游，不再逐文件吸收。** 上一轮（10-10）采用「逐文件比较、按需移植」，适合当时 78 个路径的小范围增量；现在上游从 v0.2.1 起已积累 227 个提交，聊天快照锁、多 harness、发布中心、工具预算互相依赖（PR #104/#124/#129/#130 是一串无法拆开的修复，工具预算与检查点又是另一串），继续 cherry-pick 会重复解决同一批依赖，而且永远不保留祖先关系，下次拉取冲突只会更多。
2. **必须在隔离 worktree 执行。** 主工作区当前有 53 项未提交变更（33 已修改 / 20 未跟踪），其中 `web/app.py`、`easel/gateway_questions.py`、`web/frontend/src/styles/index.css` 与上游改动直接重叠；直接 merge 会把这些功能改动卷进冲突，还会影响并行工作。
3. **冲突量可控，真正需要判断的集中在 6 组。** 预演得到 58 个冲突文件；新增文件、测试、文档可以机械取上游，语义判断集中在：`web/app.py`（聊天启动与锁）、`SettingsPanel.tsx`（我们已重做供应商流程）、`ChatPage.tsx`（进度胶囊 / 子代理 / 浏览器面板）、CSS 设计系统、`skills/shared/scripts/*`（我们改过的发布与统计）、`gateway_questions.py`（凭证解析）。
4. **合并不等于上线。** 本轮范围到源码合并、测试、文档、推送开发分支；138 部署和安装包发布需要单独授权，按 AGENTS 约定不自动触发。

## 2. 引用与规模

| 引用 | SHA | 说明 |
| --- | --- | --- |
| 本分支 HEAD（`codex/upstream-compat-2026-10-10`） | `cc1b6d46` | v0.7.3；已推送，与 `starry/` 同名分支一致 |
| 已推送开发分支（`starry/codex/upstream-compat-2026-10-10`） | `cc1b6d46` | 远端与本地一致，无未推送提交 |
| 上游 `origin/main` | `3f1d4fb8` | 上游 `pyproject.toml` 仍标 0.3.0，实际持续发布（2026-10-21 14:46） |
| 合并共同祖先 | `3fe2d99`（v0.2.1，2026-09-24） | 此后双方独立演进，从未合并过上游 |

- 上游侧：227 个提交（151 功能 + 76 合并），940 个文件，+27,597 / −1,660 行；其中 137 个是新增文件。
- 本分支侧：290 个提交，1,041 个文件，+137,275 / −4,954 行（含定制功能与历史交付文档）。
- 版本号：上游 0.3.0，本分支 0.7.3。上游版本号小于我们，合并后不能采用上游的 `__version__`。

## 3. 会加进来的内容

### 3.1 本轮 fetch 新到的 43 个提交（10-12 → 10-18）

| 主题 | 代表提交 | 价值 | 与我们冲突的位置 |
| --- | --- | --- | --- |
| 人工审核发布 | `e2d4a046`、`b29d0d72` | 发布中心增加「自动 / 人工审核」双路径，`EASEL_PUBLISH_MODE` 可在后端禁用自动提交；新增 `easel/manual_publish.py`、`ManualPublishPage.tsx`、`PublishingPage.tsx`、`docs/manual-publishing.md` | `PublishPage.tsx`、`PublishingPage.tsx`、`web/app.py` 发布接口 |
| 聊天并发与快照归属 | `f60a137e`、`5966d6ad`、`6f63e489`、`2d7b9e0b`、`93bb70ff` 等 8 个 | 排队轮次不再覆盖当前快照；取消/启动失败正确释放会话锁；网关完成事件排在队列 token 之后；锁前不做会话清洗 | `web/app.py` 的 `api_chat_stream` 启动段，与我们自研运行管理重叠 |
| 模型路由 | `7502ef82` | 自定义 provider 保留 `namespace/model` 形式的模型 ID | 与我们 0.7.0 的渠道重建同区域 |
| 诊断与评测 | `3bdc6ffe`、`1907305a`、`f20d5421` | `doctor` 增加 OpenClaw 循环保护诊断；新增工具契约探针、Agent 故障取证脚本 | 多为新增文件；`easel/commands/doctor.py` 有冲突 |
| 平台修复 | `3711dbdb`、`af03c7e8` | 知乎发布成功判定、微信草稿创建防重复提交 | `skills/shared/scripts/*`、`skills/builtin` |
| 画像 | `91509a93` | 个人主页浏览和切换已有 persona | `ProfilePage.tsx`（我们已改版） |
| 其他确认 bug | `0cb046a9` | 一次修复 20 个后端 / CLI / 技能 / 前端缺陷 | 分散，需逐条对照 |
| 文档与群二维码 | `4ffdc980` | 微信交流群二维码更新 | 二进制文件冲突，直接取上游 |

### 3.2 共同祖先以来、上一轮未纳入的累积能力

这些不在本次 fetch 的 43 个提交里，但整批 merge 会一起带进来，需要提前决定是否启用：

| 能力 | 代表提交 | 说明 |
| --- | --- | --- |
| 多 harness 子系统 | `0d53744c` | 新增 `easel/harnesses/*`（codex / acp / rpc）與 `HarnessSettings.tsx`；我们目前是 OpenClaw + 自研 Codex 服务，没有这一层 |
| 直连 OpenAI 兼容对话 | `5ab3f509` | 新增 `easel/direct_api.py`；我们已有自研 provider 直连，功能重叠 |
| 本机 agent 免 Key 接入 | `419ac7e7` | `easel/local_agents.py`；上一轮明确未纳入，这次会随合并进入代码但可不接线 |
| 设置与凭据修复 | `06348c0d`、`82b6f896`、`a514673e`、`c9e8a9e` 等 | 与我们的渠道命名、协议选择、镜像槽位实现重叠，必须语义核对，不能整段取上游 |
| 安装器与网关脚本 | `19eea157`、`7b932b14`、`78797d78` 等 | `setup.sh` / `setup.ps1` / `scripts/gateway.*` 大面积改动，与我们 Windows 启动器冲突 |
| 前端公共件 | `b42318d8` 等 | `ThemeToggle.tsx`、`SettingsSelect.tsx`、`ArtifactGallery.tsx`；可只引入不接线 |
| 本地写防护 | `e1195dc9`、`2a82e9bd`、`6f5dba3e` | 我们已有等价实现，以行为测试对齐即可 |
| workspace 同步脚本 | 上游新增 | `agents/sync.sh`、`agents/workspace/AGENTS.md`；合并进入但不自动执行 |

### 3.3 明确不照搬的部分

- 上游 README / 首页文案不整段覆盖，只吸收新功能段落并保留 fork 说明与上游归属。
- 上游安装器的 nightly CI / PSScriptAnalyzer 配置不替换我们的安装流程。
- 不运行 `agents/sync.sh`，不覆盖用户个人 workspace。
- 不把上游旧静态页或旧运营文档覆盖我们的 React 入口。

### 3.4 10-21 新到的 26 个提交（10-18 → 10-21）

规模：33 个文件，+2,044 / −27 行，21 个新增文件。三项能力，全部随整批合并进入：

| 主题 | 代表提交 | 内容 | 是否与我们重叠 |
| --- | --- | --- | --- |
| 原生工具预算与截止账本 | `2817a81d`、`462ae312`、`7f0809e0`、`5a223fd0`、`3f1d4fb8` | per-run 工具准入、单调截止账本、预算验证绑定到已认证的网关调度；最后一次提交把默认改为「不限」并按检查点校验视频 | 无实现；会在 `agents/tool-budget/`、`scripts/verify_native_tool_budget.mjs` 新增目录，不冲突 |
| 产物检查点与视频续拼 | `42fdb454`、`afa87bd7`、`efa20582`、`3805342e`、`ddf98c56` | `skills/shared/scripts/artifact_checkpoints.py`；`auto-short-video/assemble.py` 从校验过的镜头检查点恢复；损坏 manifest 一致报错 | `assemble.py` 属 `skills/` 冲突区，需按上游逻辑接我们的参数与错误文案 |
| BOM 与 CI | `42fdb454`、`46b839b4`、`7db3828c`、`df660539` | `openclaw.json` 容忍 UTF-8 BOM；Linux 安装 venv、Windows 隔离路径、原生就绪探测的测试修复 | `easel/openclaw_workspace.py` 我们已有自定义解析，取上游的 BOM 容错即可 |

## 4. 合并预演结果

预演命令（只读，可复现）：

```bash
git merge-tree --write-tree --no-messages HEAD origin/main
```

结果：退出码 1，**58 个冲突文件**。分布：

| 区域 | 数量 | 说明 |
| --- | --- | --- |
| `web/`（后端 + 前端） | 21 | 前端 18 个组件/lib/CSS，后端 `app.py` |
| `skills/` | 10 | 发布、统计、登录脚本（本轮新增 `login_state.py`） |
| `easel/` | 8 | gateway_questions、gateway_endpoint、openclaw_cmd、persona、doctor、commands/*、`__init__` |
| `tests/` | 5 | 其中 4 个是 add/add |
| `scripts/` | 2 | `gateway.sh` / `gateway.ps1` |
| 根目录与配置 | 8 | `setup.sh`、`setup.ps1`、`pyproject.toml`、`.env.example`、`.gitignore`、两份 README、`CONTRIBUTING.md` |
| 文档 / agents / 二进制 | 4 | `docs/skill-function-mapping.md`、`agents/sync.sh`、`agents/workspace/AGENTS.md`、微信群二维码 |

### 4.1 高风险文件（按双方改动行数排序）

| 文件 | 我方改动 | 上游改动 | 预判处理策略 |
| --- | ---: | ---: | --- |
| `web/app.py` | 6298 | 2184 | 逐 hunk 语义合并。以上游锁状态机为骨架，重新挂接我们的运行注册、子代理、浏览器、问答与用量接口（见 §5.3） |
| `skills/shared/scripts/xhs_publish.py` | 371 | 972 | 以上游重构为底，逐项补回我们的登录反馈、审核后只读核实与回执语义；用上游新增测试兜底 |
| `setup.sh` | 41 | 858 | 保留我们的部署/恢复流程，吸收上游的镜像探测与失败兜底；不合并与我们无关的安装器分支 |
| `skills/shared/scripts/account_stats.py` | 269 | 571 | 保留逐篇快照与账号分析，接入上游草稿过滤和并发锁 |
| `setup.ps1` | 640 | 432 | 保留 Windows 启动器；只吸收与 PATH、编码相关的修复 |
| `skills/shared/scripts/web_publisher.py` | 266 | 406 | 保留本地发布适配，吸收上游登录态与二维码修复 |
| `SettingsPanel.tsx` | 1325 | 399 | 以我们的供应商流程为底，选择性接入上游新增设置块；不整段回退 |
| `weixin_mp_stats.py` | 486 | 392 | 保留我们的统计口径，吸收上游登录墙与读回保护 |
| `styles/index.css` | 1055 | 207 | 以上游新增样式为参考，落到我们拆分后的 `styles/*.css` 新文件，不往聚合入口堆叠 |
| `web/frontend/src/lib/api.ts` | 1107 | 170 | 保留我们的 API 封装，补上游新增端点函数 |
| `AccountsPage.tsx` | 671 | 162 | 保留我们的状态机与骨架屏，吸收上游登录细节 |
| `easel/commands/doctor.py` | 60 | 250 | 保留我们的配置路径解析，移植上游循环保护诊断 |

### 4.2 双方都新建的同名文件（add/add，12 个）

`easel/gateway_endpoint.py`、`skills/shared/scripts/login_qr.py`、`web/frontend/src/lib/linkifyOutputs.ts`，以及 8 个测试文件（`test_account_stats_login`、`test_agnes_image`、`test_ai_video_env`、`test_chat_question_replay`、`test_gateway_endpoint`、`test_local_write_guard`、`test_output_delete_protect`、`test_persona_security`、`test_settings_stale_mirror`）。

处理原则：先比较两端内容，若上游已包含我们的修复则取上游；否则保留我们的实现，把上游新增用例并入同一测试文件，**不丢任何一侧的回归**。

### 4.3 上游已修、本分支现状核查（2026-10-21 实证）

不能把「上游提交说明写了」当成「我们一定缺失」。本轮对四个候选逐条读代码、必要时跑最小复现，结论如下：

| 上游修复 | 我们的实际实现 | 判定 |
| --- | --- | --- |
| `/api/upload` 改 1MB 分块流式落盘、边写边限、超限删除半成品（`0cb046a9`） | `web/app.py:5601` 仍是 `data = await f.read()` 后再比大小；超限时也不会清理已写入的目标文件 | **真实缺口**。超限的多 GB 文件会在事件循环里整读进内存才被拒绝，等于用 OOM 换一个 413 |
| healthz 回环探测改用显式 no-proxy opener（`0cb046a9`，上游称已实测复现） | `easel/commands/ping.py:59` 与 `easel/commands/doctor.py:124` 在进程内直接 `urllib.request.urlopen`；`ping.py:25` 的 `no_proxy` 属于 `_proxy_env()` 返回的**子进程环境**，不会写回 `os.environ`，对这次探测完全不起作用 | **真实缺口**。实测两种组合都失败：设 `http_proxy` 指向死端口且 `no_proxy=example.com`，以及 `no_proxy` 未设，访问 `http://127.0.0.1:7880/` 均报 `WinError 10061`。只要用户环境里有 `http_proxy`（Clash、公司代理常见），`easel ping` 与 `doctor` 就会把健康的网关判成 FAIL，甚至引导用户重启网关——正是历史上「面板常驻网关离线」那一类误报 |
| `_schedule.json` 读改写加共享 `threading.Lock`，称并发发布会丢记录（`0cb046a9`） | 我们走 `easel/local_records.py`：写时 `_write_lock` 跨进程加锁，并在锁内重读、比对 revision，不一致抛 `RecordConflict` | **不成立**。`RecordConflict` 继承 `RecordError`，`_write_schedule` 会转成 HTTPException 并作为「发布已完成，但排期记录未保存」提示，属于「冲突时明确失败」而非静默丢记录 |
| `_read_job_events` 跳过撕裂行，否则恢复流会一直重放不到内容（`0cb046a9`） | `web/app.py:3967` 已是逐行 `json.loads` + `except: continue` | **不成立**，我们已有等价实现 |

处理原则：这两项在合并前可以独立修（改动小、不与上游合并冲突），不必等整批 merge；后两项记录在此，避免合并时误把我们的正确实现换成「看起来更新」的上游版本。

## 5. 执行阶段

### 阶段 0：保存现场与基线（必须先做）

1. 分组提交当前 53 项 WIP（浏览器实时画面、子代理活动、问题交互、进度胶囊、对应文档），**排除**本地验收临时文件：`web/frontend/__*-qa.html/tsx`、`.artifacts/`。
2. 核对远端：本分支 `cc1b6d46` 已推送，无需补推；若期间又有新提交，先推平再动合并。
3. 打回滚点并推送：

```bash
git tag backup/pre-upstream-2026-10-21
git push starry backup/pre-upstream-2026-10-21
```

4. 记录合并前基线（当前分支已知红灯要单独记录，避免算成合并回归）：

```bash
python -m pytest -q                      # 记录 passed/failed/errors 明细
cd web/frontend && npm test && npm run lint && npm run build
```

5. 创建隔离 worktree：

```bash
git worktree add ../Easel-upstream-merge -b codex/upstream-merge-2026-10-21 HEAD
```

**退出条件**：主工作区干净；基线报告落盘；worktree 可独立构建。

### 阶段 1：合并上游

```bash
cd ../Easel-upstream-merge
git config merge.conflictStyle zdiff3
git merge --no-ff origin/main -m "merge: integrate upstream main 3f1d4fb8 (v0.3.0 + 227 commits)"
```

- 保留祖先关系，不用 squash，不使用 `-X ours` / `-X theirs` 一刀切。
- 冲突文件按 §5.2 顺序处理，每处理完一组就跑该组测试，不攒到最后。
- 合并前先复跑一次 `git merge-tree --write-tree --no-messages HEAD origin/main`；上游仍在活跃提交，冲突清单会变。

### 阶段 2：解冲突顺序

1. **构建与配置**：`pyproject.toml`（版本保留 0.7.3，依赖取并集，含新增 `beautifulsoup4`）、`.env.example`、`.gitignore`、CI。
2. **后端基础件**：`easel/__init__.py`、`gateway_questions.py`、`openclaw_cmd.py`、`persona.py`、`commands/*`。
3. **后端核心**：`web/app.py`（单独一段，见 §5.3）。
4. **技能脚本**：`skills/shared/scripts/*` 与 `skills/builtin/*`，逐脚本保留我们的业务语义，吸收上游修复。
5. **前端基础**：`lib/api.ts`、`lib/store.ts`、`lib/whoami.ts`、`lib/linkifyOutputs.ts` → `App.tsx`。
6. **前端组件**：`ChatPage`、`SettingsPanel`、`AccountsPage`、`ProfilePage`、`PublishPage`、`PublishingPage` 等。
7. **样式**：`styles/index.css` 与 `src/index.css`。
8. **测试**：保留双方用例，add/add 文件合并。
9. **脚本与文档**：`setup.*`、`gateway.*`、README 中英、docs、二维码。

### 5.1 通用判定规则

- 上游新增文件 / 测试 / 文档：直接取上游。
- 双方改同一文件但功能不重叠：取并集，保持我们的命名和主题变量。
- 双方都改了同一行为：先读上游补丁意图和对应测试，再以「保留我们的产品行为 + 吸收上游缺陷修复」为准；不允许为了过合并而删我们的功能。
- `web/app.py`、`SettingsPanel.tsx`、`ChatPage.tsx`、`styles/index.css` **禁止整文件取一侧**。

### 5.2 关键专项

**`gateway_questions.py`**：两处改动正好互补——我们补了 `resolve_credentials()` 凭证解析，上游补了 connect 失败/非 JSON 帧时关闭 socket。合并后应同时具备；用我们新增的 `tests/test_gateway_questions.py` 和上游相关用例共同验证。

**技能脚本**：`xhs_publish.py` 上游重构幅度最大（972 行），先读上游测试 `tests/test_bugfix_regressions.py` 等确定行为契约，再把我们的登录反馈、回执与只读核实逐函数接回；`weixin_mp_stats.py`、`web_publisher.py`、`login_qr.py` 同理。未真实登录平台的结论不能写成已验证。

**样式**：我们的入口是 `src/index.css`（6 行聚合）→ `styles/index.css`（1701 行）→ 各拆分文件。上游把新样式直接追加在旧的单文件 `src/index.css` 里，不能照搬；应新增 `styles/publishing-manual.css`、`styles/profile-library.css` 并在 `styles/index.css` 末尾导入，避免重复选择器和优先级打架。

**前端组件**：上游新增的 `SettingsSelect.tsx`、`ThemeToggle.tsx`、`ManualPublishPage.tsx`、`PublishingPage.tsx`、`HarnessSettings.tsx`、`ArtifactGallery.tsx` 作为独立文件引入，只在确认接线的地方使用；我们的设计系统与侧栏交互保持不变。

### 5.3 `web/app.py` 专项（最高风险）

上游这次把 `api_chat_stream` 的启动段重写成带状态机的结构（`locked` / `claimed` / `started`、取消与启动失败都保证释放锁、拿到双锁后才写快照、再清洗历史、再选 transport）。我们的定制入口（`start_chat_run`、子代理活动、浏览器桥、问答、agent office、用量）都嵌在同一片区域。

执行要求：

1. 先完整理解上游新状态机，让锁与快照归属逻辑原样落地。
2. 再按 hunk 把我们的入口接到正确位置：注册运行进程必须在 transport 启动成功后；快照写入必须只在 `claimed` 之后；任何 `finally` 清理都不能漏掉我们的运行表与事件队列。
3. 逐项核对我们的新增路由没有被上游重写覆盖；合并后跑 `git diff origin/main -- web/app.py` 确认每一处「只属于我们」的差异都还有理由。
4. 必须同时跑两套测试：
   - 上游：`tests/test_gateway_snapshot_ownership.py`、`tests/test_gateway_stream_completion.py`、`tests/test_chat_event_log_recovery.py`、`tests/test_rpc_client_pressure.py`。
   - 我们的：`tests/test_child_activity.py`、`tests/test_gateway_questions.py`、`tests/test_browser_runtime.py`，以及聊天相关既有用例。

## 6. 合并后验证矩阵

| 层 | 检查 | 通过标准 |
| --- | --- | --- |
| 后端全量 | `python -m pytest -q` | 与阶段 0 基线相比**无新增失败**；新增上游测试全部通过；既有红灯单独列明 |
| 后端定向 | 聊天流/锁/恢复、设置与凭据、发布、问答、浏览器桥、账号 | 全部通过，且覆盖上游新用例 |
| 上传与探测（合并前即可先做） | 超限文件上传不整读进内存、半成品被清理；`http_proxy` 指向死端口且 `no_proxy` 不含回环时 healthz 仍返回 OK | 两项各补一条回归测试；见 §4.3 |
| 前端 | `npm test`、`npm run lint`、`npm run build` | 全量通过；lint 0 错误（既有 warning 可保留）；构建成功 |
| 路由 | `/api/chat/stream`、`/api/chat/jobs/*`、`/api/settings/*`、`/api/publish*`、`/api/question*`、`/api/browser/*` | 实际启动服务后逐条可达，行为与合并前一致（新增人工发布接口可用） |
| 数据兼容 | 会话/事件账本、排期、发布回执、渠道配置 | 旧数据可读；新字段有缺省值；不做批量转换或清理 |
| 浏览器 | 对话（进度胶囊 / 子代理 / 问题卡片）、实时浏览器、设置供应商、发布中心、账号中心、个人主页 | 真实浏览器逐项点击核对；区分模拟数据与真实后端 |
| 边界 | 138、安装包 | 本阶段不动；需要上线时另开授权与部署回执 |

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 聊天启动状态机语义合并错误 | 会话锁泄漏、快照被覆盖、消息丢失 | 以上游状态机为骨架；双套测试；先跑隔离实例再动 7880 |
| 设置页 / 模型路由回退 | 渠道配置被旧镜像值覆盖 | 保留我们的保存契约与测试；不整段取上游 |
| 技能脚本取上游后丢我们的业务语义 | 小红书/公众号发布回执、统计口径退化 | 逐函数接回 + 上游回归 + 我们的既有测试 |
| CSS 聚合结构被破坏 | 样式重复、优先级错乱 | 新样式落独立文件；构建后看实际页面 |
| 合并带入未启用的子系统 | 默认行为变化 | 新模块先「代码在、入口关」，验收后再决定开启 |
| 并发工作冲突 | 主工作区改动被卷进合并 | 阶段 0 先提交并推送；全程在 worktree 操作 |

回滚路径：`git reset --hard backup/pre-upstream-2026-10-21`（仅在隔离分支），远端 `starry` 只在验收通过后更新；不 force push。

## 8. 需要确认的三件事

1. **版本号**：推荐 **0.8.0**。理由：合并会新增人工审核发布、多 harness、工具预算与截止账本、产物检查点等模块，属于「大模块新增」；若决定这些新能力全部隐藏、只吸收修复，则按兼容修复递增 **0.7.4**。
2. **新子系统是否启用**：推荐分两步——先合并代码、默认不接线；等人工发布 / harness 各自验收后再逐个开启。避免一次合并同时改变用户可见行为。
3. **推送范围**：推荐只推 `codex/upstream-merge-2026-10-21` 和现有开发分支；`starry/main` 仍只同步首页说明，不直接合并上游（与上一轮约定一致）。

## 9. 工作量预估

按冲突簇划分，预计 4–5 个工作段（比 10-20 版多一段，因为检查点与工具预算这两块新增目录需要单独接线与验收）：

| 工作段 | 内容 | 主要产出 |
| --- | --- | --- |
| 0 | 独立修 §4.3 的上传与回环探测两处缺口 | 两条回归测试先绿，合并时不必再和这些改动抢同一片代码 |
| 1 | 阶段 0 + 构建/配置/后端基础件 | 干净基线、worktree、可编译后端 |
| 2 | `web/app.py` + 技能脚本 | 聊天流与发布链路通过定向测试 |
| 3 | 前端组件与样式 | 构建通过、页面可用 |
| 4 | 工具预算 / 检查点 / harness 新模块接线（默认关闭） | 新模块代码在、入口关，逐个验收 |
| 5 | 全量回归、文档、版本、推送 | 合并提交与验证回执 |

## 10. 本轮不做什么

- 不部署 138，不重启线上服务，不发布安装包。
- 不清理或转换用户会话、账号登录态、发布回执。
- 不覆盖 `starry/main`，不 force push，不夹带本地 QA 临时文件或密钥。
- 不把「上游存在」当成「已实现 / 已验收」；每一项能力以合并后的实际入口与测试为准。

## 附：58 个冲突文件完整清单（2026-10-21 预演）

预演命令同上；这是当前 `HEAD`（`cc1b6d46`）与 `origin/main`（`3f1d4fb8`）的结果。上游仍在持续提交，执行合并前需复跑。

```text
.env.example
.gitignore
CONTRIBUTING.md
README.md
README_EN.md
agents/sync.sh
agents/workspace/AGENTS.md
assets/readme/wechat-group.png
docs/skill-function-mapping.md
easel/__init__.py
easel/commands/doctor.py
easel/commands/ping.py
easel/commands/skill.py
easel/gateway_endpoint.py
easel/gateway_questions.py
easel/openclaw_cmd.py
easel/persona.py
pyproject.toml
scripts/gateway.ps1
scripts/gateway.sh
setup.ps1
setup.sh
skills/builtin/skill-my-account/references/commands.md
skills/shared/scripts/account_stats.py
skills/shared/scripts/ai_video.py
skills/shared/scripts/calendar_ops.py
skills/shared/scripts/douyin_publish.py
skills/shared/scripts/login_qr.py
skills/shared/scripts/login_state.py
skills/shared/scripts/web_publisher.py
skills/shared/scripts/weixin_mp_stats.py
skills/shared/scripts/xhs_publish.py
tests/test_gateway_endpoint.py
tests/test_local_write_guard.py
tests/test_persona_security.py
tests/test_settings_stale_mirror.py
tests/test_web_security.py
web/app.py
web/frontend/index.html
web/frontend/src/App.tsx
web/frontend/src/components/AccountsPage.tsx
web/frontend/src/components/ChatPage.tsx
web/frontend/src/components/DashboardPage.tsx
web/frontend/src/components/ErrorBoundary.tsx
web/frontend/src/components/IdeasPage.tsx
web/frontend/src/components/MessageBubble.tsx
web/frontend/src/components/OutputsPage.tsx
web/frontend/src/components/ProfilePage.tsx
web/frontend/src/components/PublishPage.tsx
web/frontend/src/components/SettingsPanel.tsx
web/frontend/src/components/Sidebar.tsx
web/frontend/src/components/TrendsPage.tsx
web/frontend/src/index.css
web/frontend/src/lib/api.ts
web/frontend/src/lib/linkifyOutputs.ts
web/frontend/src/lib/store.ts
web/frontend/src/lib/whoami.ts
web/frontend/src/styles/index.css
```
