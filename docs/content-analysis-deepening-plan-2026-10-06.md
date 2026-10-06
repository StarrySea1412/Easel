# 内容分析「深度化」实施计划

- 日期：2026-10-06
- 分支：`codex/creator-workflow`（基于提交 `2728713`）
- 状态：待评审 / Phase 0 待用户动作
- 关联文档：`docs/content-analysis-methodology-2026-09-30.md`（方法论）、`docs/content-analysis-workbench-2026-09-30.md`（工作台）、`docs/content-analysis-data-audit-2026-09-30.md`（数据审计）

---

## 1. 背景与现状评估（2026-10-06 实测 + 代码核实）

### 1.1 四层分析机制现状

| 层 | 实现 | 文件与入口 | 是否用模型 | 现状结论 |
|---|---|---|---|---|
| ① 确定性采集层 | 各平台创作中心数据抓取 | `web/app.py:4704`（`/api/analytics/{platform}`）、`skills/shared/scripts/account_stats.py`、`bili_login.py:207`（`cmd_stats`）、`weixin_mp_stats.py` | 否 | 链路通，7 平台全接（`app.py:4459` `ANALYTICS_PLATFORMS`）；当前 0/7 登录，无数据 |
| ② 本地规则诊断层 | 正则 + 字数统计的编辑检查 | `web/content_analysis.py:110`（`diagnostics()`） | 否 | 已实现标题承诺词、段落长度、举例/步骤标记、评论提问计数、逐字稿首尾呼应等检查；**每条自带 limitation 声明** |
| ③ 关键词统计层 | 分词 + 标签归并 + 指标均值 | `web/xhs_insights.py`（小红书）、`web/bili_insights.py`（B站，2026-10-05 新增） | 否 | 只读快照流；小红书走账号级证据目录，B站按平台存储 |
| ④ AI 深度解释层 | 单篇模型解读 + 逐字引用校验 | `web/content_analysis_ai.py`（`interpret`/`validate_findings`）、`web/content_analysis_routes.py:116`（`POST /interpret`）、前端 `ContentAnalysisWorkbench.tsx`「AI 深度解释」按钮 | **是（唯一）** | 代码与前端接线完整；**未配模型 Key 时 503**，当前环境不可用 |

### 1.2 已验证事实（2026-10-06 真实浏览器 + HTTP 探测）

- Web 工作台、内容分析页（演示/我的数据双模式）、账号中心（7 平台卡片）、热点雷达（真实热榜）、Agent 办公室（演示模式）全部渲染正常（截图留档会话产物）。
- `/api/analytics/insights/bilibili` 空快照返回可读提示；无快照时写选题 409；不支持平台 404 —— 防呆正确。
- `easel gateway start` 后 healthz OK（127.0.0.1:18789）；`easel ping` Step 1 OK、Step 2 FAIL（模型未配置）。
- `easel doctor` 当前两项 FAIL：`.env (API Key)`、`OpenClaw model routing`；`Skills synced` 已修复为 OK（115 技能 + 78 共享文件已入 `~/.openclaw-easel/workspace`）。
- AI 层反幻觉镣铐（代码核实，待 Phase 1 实测）：`validate_findings()` 丢弃含数字/百分比/因果词（导致/证明/提高/下降等）的模型输出；引用必须逐字存在于材料（`quote not in evidence[ident]` 即丢弃）；最多 8 条。

### 1.3 「没深度」的三个根因

1. **第④层死锁**：无 API Key → `/interpret` 503，用户看到的全是①–③层确定性输出；
2. **无数据**：0/7 平台登录，逐篇快照为空；②层的评论/逐字稿诊断写了代码但等米下锅；
3. **哲学性限制**：④层只做单篇编辑观察；跨作品对比数字由程序算好，模型不参与全局归因（设计如此，非缺陷，但留有按同哲学扩展的空间）。

---

## 2. 目标与非目标

### 2.1 目标

1. 第④层端到端可用（配 Key → 真实材料 → 引用校验 → 建立验证实验）；
2. 在**不破坏反幻觉约束**前提下新增"跨作品 AI 全局解读"（数字仍由程序产出）；
3. 把评论、逐字稿喂进材料层，激活已写好的②层诊断；
4. B站快照升级账号级归属，消除跨账号混淆；
5. 实验回收闭环（到期提醒 + 差分对比视图）；
6. （差异化）Agent 驱动的内容周报，走你 fork 已有的 OpenClaw 对话线。

### 2.2 非目标（明确不做）

- 不让模型输出任何数字、百分比、因果断言、增长预测（所有新增 AI 出口沿用机械校验）；
- 不做跨平台横向排名（口径不同，`account_analysis.py` 已明确禁止）；
- 不自动发布、不提升采集频率（小红书风控边界，README 已警示）；
- 不改动演示数据（它是产品说明书，不是分析源）。

---

## 3. 总体架构（目标态）

```
平台创作中心                    本机证据层                        分析层                        呈现
────────────                ─────────────                   ─────────────                 ─────────────
小红书创作中心 ─┐            outputs/_analytics/             ② 规则诊断（零模型）           逐篇看作品
B站创作中心   ─┤─ 采集 ─→   ├ <account>/notes.jsonl  ─→     ③ 关键词统计（零模型）   ─→    先看结论
抖音/快手/…  ─┘            ├ bilibili-notes.jsonl（2.3 后   ④ 单篇 AI 解释（引用校验）      找内容方向
                            │  迁移为账号目录）        ─→     ④+ 跨作品 AI 解读（2.1，      下一步怎么做
评论/逐字稿  ───── 补料 ─→  ├ workbench.sqlite                       数字机械校验）（新）     实验看板（2.4，新）
（xhs_comment /             └ experiments / reviews                                          Agent 周报（3，新）
 bili reply API /
 语音转文字技能）
```

---

## 4. Phase 0 — 通电（用户动作为主，预计半天）

| # | 任务 | 执行者 | 具体步骤 | 验收标准 |
|---|---|---|---|---|
| 0.1 | 配置模型 Key | 用户 | 方式 A：设置页「服务商预设 / 从 CC Switch 导入」；方式 B：项目根 `.env` 写 `ANTHROPIC_API_KEY`，或 `EASEL_LLM_API_KEY` + `EASEL_LLM_BASE_URL`（OpenAI 兼容） | `easel doctor` 该项 OK |
| 0.2 | 设置模型路由 | 用户/协助 | `openclaw/openclaw.json5` 设 `agents.defaults.model.primary`（随 0.1 一起） | `easel ping` Step 2（Agent say PONG）OK |
| 0.3 | 网关常驻 | ✅ 已完成 | `easel gateway start`（18789，healthz OK） | 页面左下角离线标识消失 |
| 0.4 | 登录平台 | 用户扫码 | 账号中心：小红书（App 扫码）和/或 B站（登录引导，cookie 存 `data/cookies.json`） | 账号中心 ≥1/7；`/api/analytics/platforms` 对应平台 `loggedIn: true` |
| 0.5 | 首次采集 | 用户 | 内容分析 → 我的数据 → 采集当前登录账号 | 逐篇快照文件非空；建议面板出现候选词 |

## 5. Phase 1 — 现有 AI 层端到端验证（我做，约 1 小时，依赖 0.1–0.5）

| # | 任务 | 做法 | 验收 |
|---|---|---|---|
| 1.1 | 单篇解释真实跑通 | 选一篇真实作品，调 `POST /api/content-analysis/interpret`（platform/accountId/contentId） | 返回 `findings` ≥3 条，每条含逐字引用；前端「AI 深度解释」区渲染并显示 `model · at` |
| 1.2 | 反幻觉镣铐实测 | 用测试 provider 注入含「提高了 30%」「证明了」「导致」的假输出，以及不存在的引用串 | 全部被 `validate_findings` 丢弃；材料不足时报可读错误（400/503 语义不变） |
| 1.3 | 解释→实验闭环 | 从一条 finding 点「建立验证实验 →」 | 实验入库（`store.experiment`），PATCH 状态可用，`GET /export` 含该实验 |
| 1.4 | 体验记录 | 记录延迟、失败重试、按钮 busy 态 | 输出补丁（如需加 loading 文案）随 Phase 2 一起提交 |

## 6. Phase 2 — 深度增强（四个独立可交付项）

### 6.1 任务 2.1：跨作品 AI 全局解读（主力，建议首个开发）

**动机**：主题对比、总览数字是程序算的（`content_analysis.py:335 summarize`、`report():237`），模型只看单篇；用户要的"深度"主要是全局归因与跨篇规律。

**新增端点**：`POST /api/content-analysis/insights`（挂在 `content_analysis_routes.create_router` 内）

- 请求：`{ platform, accountId }`
- 服务端构造**事实清单**（fact sheet），每条事实有稳定 ID、全部由程序计算：
  ```json
  {"facts": [
    {"id": "F1", "text": "主题「教程」3 篇，7 天平均收藏 850（日常类 76）"},
    {"id": "F2", "text": "作品 BV1xxx 近 7 天播放 +4,200，同账号快照差分"},
    {"id": "F3", "text": "评论高频问题：「怎么选豆子」出现 4 次"}
  ]}
  ```
- 模型 system prompt 约束：只允许引用 fact ID 与**逐字复述事实文本中的数字**；返回
  ```json
  {"insights": [{"factIds": ["F1","F3"], "observation": "…", "action": "…"}], "maxItems": 6}
  ```
- **机械校验（新增 `validate_insights()`）**：
  1. `factIds` 必须存在且非空；
  2. observation/action 中出现的每个阿拉伯数字必须逐字出现在所引 fact 文本中（正则抽取 `\d[\d,，.]*` 集合比对）；
  3. 命中 `%|％|导致|保证|必然|一定会|证明|算法|涨粉原因` 等模式整条丢弃（沿用 `validate_findings` 词表并扩展）；
  4. 全部被丢弃 → 503「模型没有返回可通过数字核验的解读」，不降级输出。
- 存储：`store.save_insights(platform, account_id, insights)`（SQLite 新表或复用 reviews 表加 scope 字段）。
- 前端：「找内容方向」视图加「请求全局解读」按钮 + 结果卡（每条显示引用的 fact 徽标）+「建立验证实验」。
- 测试（离线，全部假 provider）：数字编造被丢弃、factIds 不存在被丢弃、正常输出通过、空 facts 400、端到端 pytest 仿照 `tests/test_xhs_insights.py` 风格新建 `tests/test_content_insights_ai.py`。
- 规模：后端 ~220 行、前端 ~120 行；**1 个人天**。

### 6.2 任务 2.2：评论与逐字稿喂进材料层

**动机**：`diagnostics()` 的 `comment-coverage`（评论提问计数）、`script-opening/script-flow`（逐字稿）已实现但依赖 `content.comments/transcript` 字段，当前无采集来源。

- **小红书评论**：`account_stats.py` 小红书笔记已带 `xsec_token`（注释指明"供 xhs_comment.py 直接抓评论"）。新增桥接：`POST /api/content-analysis/capture-comments`，参数 `{platform:'xiaohongshu', contentId}`，子进程调 `xhs_comment.py` 抓单篇评论 → 写回 workbench 材料（`store.ingest` 的 `comments` 字段）。低频、单篇、用户点击触发。
- **B站评论**：`bili_login.py` 新增 `comments` 子命令（cookie 已有）：`GET api.bilibili.com/x/v2/reply?type=1&oid=<aid>`；`cmd_stats` 的 archives 响应已含 `aid`，随 notes 输出，供映射。
- **逐字稿**：短期走「补充/更新材料」表单手工粘贴（字段已存在）；中期复用现有"语音转文字"技能做可选的自动转写（视频 URL → 音频 → 文本），单独 PR 评审后再接。
- 验收：补料后重跑诊断，`comment-coverage` / `script-*` 维度自动出现；证据引用为评论原文。
- 规模：小红书桥接 ~120 行、B站 ~100 行；**各 0.5 人天**。

### 6.3 任务 2.3：B站逐篇快照升级账号级归属

**动机**：`account_stats.record_note_snapshot`（`account_stats.py:358`）对非小红书平台按平台文件存（`bilibili-notes.jsonl`），换账号会混；`bili_insights` 面板已如实标注该限制，但这是深度天花板。

- `bili_login.py cmd_stats` 已输出 `nickname`，且 nav 响应含 `mid`（`bili_login.py:222`）——把 `mid` 提升为输出字段 `accountId`；
- `app.py:4788` 附近 B站入库分支改为走 `account_evidence.ingest`（账号目录 `evidence/bili-<mid>/notes.jsonl`），与小红书同构；`record_note_snapshot` 为 bilibili 增加 account 分支；
- 一次性迁移脚本（`scripts/migrate_bili_notes.py`）：读旧 `bilibili-notes.jsonl` → 归入对应账号目录（旧文件无账号则整体归 `legacy` 并在前端标注"归属未核验"）；迁移前自动备份原文件；
- `_load_note_snapshot_records('bilibili')`（`app.py:4592`）与 `/api/analytics/notes/bilibili` 改读账号目录；
- 测试：`tests/test_bili_insights.py` 增补账号切换隔离用例；迁移脚本对空文件/坏行/重复 note 幂等。
- 规模：**0.5 人天**。

### 6.4 任务 2.4：实验看板（回收闭环）

**动机**：实验可建（`POST /experiments`）可改（`PATCH /experiments/{id}`）但无列表入口、无到期提醒、无结果对比。

- 后端补 `GET /api/content-analysis/experiments?platform&accountId&status`；
- 前端「下一步怎么做」视图改为实验看板：按状态分组（进行中/待回收/已完成）、按创建时基线快照自动计算"回收差分"（同作品最新快照 vs 基线，纯程序计算、缺失标缺失）；
- 每个到期实验给「去采集 → 填结果」动线；差分数字可直接一键生成新的跨作品解读 fact（与 2.1 打通）；
- 测试：状态流转 + 差分计算单测（缺失指标不算 0）。
- 规模：**0.5–1 人天**。

## 7. Phase 3 — Agent 驱动内容周报（依赖 0.1/0.2，1–2 人天）

- 新技能 `skills/openclaw/skill-content-review/`：`SKILL.md`（何时用/需要什么/产出什么）+ `scripts/weekly_report.py`；
- 脚本只做两件事：从 `outputs/_analytics` + workbench SQLite 汇出**事实 JSON**（同 2.1 的 fact sheet 格式）；把模型解读约束写进调用模板（逐字数字、无因果词）；
- 对话页预设技能卡「复盘我最近的内容」：走 gateway 调 Agent 执行技能，产出 Markdown 周报写入 `outputs/reviews/`；
- 这一步把你 fork 的差异化能力（115 技能 + Agent 线）与内容分析打通，是相对上游最值得立的差异点；
- 验收：真实 Key 下产出一份周报，数字全部可在 fact sheet 中逐字对上。

## 8. 依赖与里程碑

```
M0 通电（Phase 0，用户）─→ M1 AI 层验证（1h）─→ M2.2 评论/逐字稿（1d）
                                              ─→ M2.1 全局解读（1d）
M2.3 B站账号归属（0.5d，无依赖，可即刻开工）
M2.4 实验看板（0.5–1d，依赖 2.1 的 fact 结构复用）
M3 Agent 周报（1–2d，依赖 M0 + 2.1）
```

- 2.2（B站评论部分）、2.3、2.1 的后端骨架（假 provider 单测）**不需要 Key，可先行开工**；
- 总量约 **4–6 人天**（不含用户登录与真实数据等待期）。

## 9. 测试与验收矩阵（每项交付按此四栏记录，未实测不报通过）

| 交付项 | 真实浏览器 | HTTP 可达性 | 模拟数据（离线单测） | 真实后端 |
|---|---|---|---|---|
| 2.1 全局解读 | 解读卡渲染/实验动线 | 新端点 200/400/503 语义 | 数字校验器全分支 | 真实 Key + 真实作品 |
| 2.2 评论/逐字稿 | 补料表单回填 | capture-comments 404/504 | 坏 JSON/空评论跳过 | 单篇真实评论落库 |
| 2.3 B站账号归属 | 面板不再显示平台混存警告 | notes 端点按账号返回 | 迁移幂等/坏行 | 双账号切换隔离 |
| 2.4 实验看板 | 到期分组/差分展示 | GET experiments 200 | 差分缺失算例 | 真实回收一轮 |
| 3 Agent 周报 | 对话入口/产物链接 | gateway 状态 | 技能自检（离线） | 真实周报一份 |

## 10. 风险登记册

| 风险 | 等级 | 缓解 |
|---|---|---|
| 小红书采集触发风控 | 高 | 只读本人创作中心、低频、用户点击触发；发布保持手动确认 |
| 平台改版解析静默失败 | 中 | 保留"未确认空列表不落盘"防护；来源/时间照实标注 |
| 引用/数字校验拒杀率过高，冷启动体验差 | 中 | 温和 prompt、失败给可读原因与重试；观察 10 篇样本后调词表 |
| B站迁移丢数据 | 中 | 迁移前备份原 jsonl；脚本幂等；旧文件保留一个版本周期 |
| 模型延迟/费用 | 低 | 单篇 ≤16k 字符截断（现状）、insights facts ≤40 条；按钮 busy 态 |
| 多账号混淆 | 中 | 2.3 完成前 UI 维持"按平台保存"的如实标注 |
| gateway 长驻稳定性 | 低 | `easel gateway status/logs` 已有；异常时页面有离线标识 |

## 11. 交付与文档同步约定

- 每个任务独立 PR/提交，随附四栏验收记录；未实际检查的入口不报通过；
- 功能落地时同步中英文 README、更新记录与进度文档（按仓库协作约定执行）；
- 不提交密钥、登录态与本地验收临时文件（`.env`、cookies、快照流均在忽略清单内）。

---

## 附录 A：本轮评估涉及的关键代码坐标

- `web/app.py`：247（LOGIN_RUNNERS）、4459（ANALYTICS_PLATFORMS）、4507（platforms 端点）、4614（insights GET）、4657（idea POST）、4704–4808（采集与入库，B站分支 4713/4788）
- `web/content_analysis.py`：110（diagnostics）、168（draft）、180（Store/SQLite）、237（report）、275（experiment）、330（save_review）、335（summarize）、346（markdown）
- `web/content_analysis_ai.py`：evidence_for / validate_findings / interpret（无 provider 503）
- `web/content_analysis_routes.py`：14（create_router）、116（/interpret）
- `web/xhs_insights.py`、`web/bili_insights.py`：候选词/均值/证据结构
- `skills/shared/scripts/account_stats.py`：333–404（notes 快照）、407（clear）、890（cmd_fetch）
- `skills/shared/scripts/bili_login.py`：207（cmd_stats，ps=20、note_id=bvid）
- 前端：`ContentAnalysisPage.tsx`（平台元数据、B站双面板）、`ContentAnalysisWorkbench.tsx`（逐篇诊断、AI 深度解释按钮、实验入口）、`BiliInsightsPanel.tsx`、`lib/api.ts`（fetchBiliInsights/addBiliSuggestion/BiliNoteEvidence）
- 测试：`tests/test_bili_insights.py`（15 例）、`tests/test_xhs_insights.py`、`tests/test_content_analysis_workbench.py`
