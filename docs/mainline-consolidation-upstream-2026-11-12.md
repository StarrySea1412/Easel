# 定制主线整合与上游更新调查 · 2026-11-12

## 范围与结论

用户要求把本地代码“合并到一条”，再看看上游更新。本次将已交付的0.50.2定制代码与用户仓库原main历史收敛到 `starry/main`。新开发从main创建 `codex/` 功能分支，验证后合回main；默认安装及贡献说明随之更新。

本次没有产品行为变更，业务源码保持0.50.2交付基线；另补齐内容分析演示测试对账号健康事件/独立账号模块的两处导出替身，不改产品版本；没有把旧实验分支、未提交草稿或尚未验收的上游合并现场当成已完成代码导入。没有删除旧分支/工作区，也没有强推。上游仅调查及无工作区写入的试合并预览，没有整仓导入。最终Git提交及远端核对在交付回执中记录。

产品单一版本来源仍为 `pyproject.toml` 的0.50.2，前端package/lock不变。此次不部署138、不发布安装器、不调用真实模型或平台投稿。138上次已验运行构建仍是 `e609ab3d71a573a90609336e77227869f7af941e`，详见[部署回执](release-138-0.50.2-2026-11-12.md)；本轮未重新实测线上状态。

## 固定比较基线

以下统计在本次整合前冻结，不能用整合后的main重算再混用口径。

| 对象 | 固定提交 / 状态 |
| --- | --- |
| 最新已交付定制基线 | `b65075377078d3e3c48f5116de9d74f2bec96900`，包含0.50.2代码与138部署回执 |
| 原用户仓库main | `be3a86d04119110c67f894b7e0b158b1f172c475`，此前主要同步双语首页 |
| 定制基线与原main共同祖先 | `de08f202423bf6e2e35bd9af0e2cb90648ef2ea8` |
| 上游origin/main | `9eaec64a35858405dedacf8ab2627b53fe65b467`，2026-11-12 13:23:21 +08:00 |
| 定制基线与上游共同祖先 | `8d08b216105bd7c7057c84c97cd637cec44db609` |

已实际刷新 `starry`（StarrySea1412/Easel）和 `origin`（ZJU-REAL/Easel）。相对原main，定制基线独有713个提交、原main独有187个提交；原main相对共同祖先只改8个说明文档，没有独有业务代码。相对上游共同祖先，定制基线独有532个提交，上游独有99个提交（其中70个非merge）；这不等于99项本地缺失功能。

## 主线合并与冲突处理

在干净候选分支 `codex/consolidate-main-20261112` 上以最新定制基线为起点，先提交需求登记，再执行对原 `starry/main` 的普通merge；保留双方父提交与历史，随后以普通快进推送更新远端main。

出现7个文档冲突，未出现业务源码冲突：

| 文件 | 决策 |
| --- | --- |
| `AGENTS.md` | 保留当前交付、隐私、双语文档与未提交工作保护规则；明确新主线main |
| `CONTRIBUTING.md` | 保留当前开发说明；改为从main开发、向main提PR |
| `README.md` / `README_EN.md` | 保留0.50.2及真实部署证据、上游归属；改源码安装分支并增加本报告入口 |
| `docs/known-issues.md` | 保留当前定制问题及边界 |
| `docs/known-issues_EN.md` | 恢复原main历史英文说明，顶部明确历史参考属性并指向当前问题/部署，避免已有英文链接丢失 |
| `web/frontend/README.md` | 保留当前前端结构和开发说明；默认维护分支main |

`WINDOWS-START-HERE.md` 同步main入口，并明确源码整合不等于Windows安装器已发布。恢复历史英文问题文档，同时将用户清单中本已失效的0.13分发回执链接改为已推送历史提交f27a59f2上的精确文件链接；其余相对文档链接、许可证及第三方归属保留。

## 历史分支与未提交内容

盘点166个本地及starry分支引用，其中119个已是最新定制基线祖先；其余47个引用包含历史首页链、补丁等价链与旧主题分支，不能按引用数量认定功能遗漏。旧main链由本次merge保留。`git cherry` 是补丁级证据，不能代替行为验收；当前文件存在也不证明旧改动已完整吸收。

下表先去除已包含/原main祖先/重复SHA的引用，再做补丁等价比较；不同分支可共享旧提交，因此计数不可直接相加。

| 主题分支 | 冻结HEAD | 补丁等价数 | 非等价数 | 处理 |
| --- | --- | ---: | ---: | --- |
| `codex/agent-workspace-0.16.0` | `cadaa896` | 0 | 5 | 保留旧链；非等价提交见下方逐项清单，未机械合并 |
| `codex/aihub-reasoning-2026-10-12` | `7e3de088` | 0 | 11 | 保留旧链；非等价提交见下方逐项清单，未机械合并 |
| `codex/browser-live-view-2026-10-20` | `c9af58d6` | 0 | 3 | 保留旧链；非等价提交见下方逐项清单，未机械合并 |
| `codex/codex-runtime-integration-2026-10-10` | `47161e46` | 0 | 1 | 保留旧链；非等价提交见下方逐项清单，未机械合并 |
| `codex/compact-continue-0.43.5` | `fcc39a34` | 0 | 7 | 保留旧链；非等价提交见下方逐项清单，未机械合并 |
| `codex/goal-conversation-2026-10-17` | `b31da460` | 39 | 0 | 补丁等价，保留历史，不重复导入 |
| `codex/goals-codex-align-2026-10-17` | `82a51d8f` | 1 | 0 | 补丁等价，保留历史，不重复导入 |
| `codex/multi-account-distribution-0.13.0` | `62beb426` | 0 | 14 | 保留旧链；非等价提交见下方逐项清单，未机械合并 |
| `codex/notifications-ux-2026-10-17` | `f817546d` | 1 | 0 | 补丁等价，保留历史，不重复导入 |
| `codex/portable-model-import-fixes` | `12583174` | 0 | 8 | 保留旧链；非等价提交见下方逐项清单，未机械合并 |
| `codex/qizhi-agent` | `653d8cf2` | 0 | 2 | 保留旧链；非等价提交见下方逐项清单，未机械合并 |
| `codex/settings-reorg-2026-10-17` | `96a849a8` | 2 | 0 | 补丁等价，保留历史，不重复导入 |
| `codex/shared-browser-0.13.3` | `d8fc86e4` | 0 | 1 | 保留旧链；非等价提交见下方逐项清单，未机械合并 |
| `codex/upstream-compat-2026-10-10` | `3a951816` | 0 | 10 | 保留旧链；非等价提交见下方逐项清单，未机械合并 |
| `codex/upstream-merge-0.12.0` | `46797b65` | 0 | 9 | 保留旧链；非等价提交见下方逐项清单，未机械合并 |
| `codex/upstream-merge-0.8.0` | `efd46138` | 0 | 1 | 保留旧链；非等价提交见下方逐项清单，未机械合并 |
| `codex/upstream-reliability-0.2.9` | `0c389774` | 4 | 34 | 保留旧链；非等价提交见下方逐项清单，未机械合并 |

明确映射及限制：

- 原账号增长快照 `3a951816` 已由当前 `83e89ff2` 移植；原 `C:/project/Easel` 工作区本次盘点为干净，未在该目录执行新合并。
- 旧浏览器观察链与当前 `ba08ba68` 等实现有主题重合；这只是定位依据，不声称三条旧补丁逐一完全等价。
- 当前任务阶段已有research-delivery、reviewed-delivery、parallel、planned等契约，旧0.16 content-pipeline不能直接覆盖。
- portable/model/goal/compact等历史主题有重构、移植或文档版本差异。下方80条去重非等价历史提交保留待按行为核对，不称为80项缺失功能，也不称已全部合入。纯文档旧回执不作为当前验收事实。

### 未提交工作区留存

其他19个dirty工作区的HEAD、status与1438个tracked dirty文件做了前后指纹比较；不导出私有正文，不提交账号资料。以下仅列工作区末段或分支及变更数量，避免将本机私人路径写入公共仓库。

| 工作区 / 分支 | 变更文件数 | 原合并状态 | 本次处理 |
| --- | ---: | --- | --- |
| `codex/upstream-sync-2026-11-03` | 218 | MERGE_HEAD存在，原现场保留 | 仅盘点及指纹，不迁入main |
| `codex/regression-audit-2026-10-27` | 20 | 非合并中 | 仅盘点及指纹，不迁入main |
| `codex/agent-workspace-0.16.0` | 5 | 非合并中 | 仅盘点及指纹，不迁入main |
| `codex/compact-continue-0.43.5` | 2 | 非合并中 | 仅盘点及指纹，不迁入main |
| `e9d3/Easel` | 72 | 非合并中 | 仅盘点及指纹，不迁入main |
| `easel-report-build/Easel` | 1 | 非合并中 | 仅盘点及指纹，不迁入main |
| `codex/goal-conversation-2026-10-17` | 3 | 非合并中 | 仅盘点及指纹，不迁入main |
| `codex/web-workflow-0.15.0` | 36 | 非合并中 | 仅盘点及指纹，不迁入main |
| `codex/gpt-responses-xhs-0.46.13` | 2 | 非合并中 | 仅盘点及指纹，不迁入main |
| `codex/chat-activity-0.14.4` | 2 | 非合并中 | 仅盘点及指纹，不迁入main |
| `codex/model-status-clarity-0.7.6` | 2 | 非合并中 | 仅盘点及指纹，不迁入main |
| `codex/latest-account-distribution-0.49.0` | 2 | 非合并中 | 仅盘点及指纹，不迁入main |
| `codex/codex-live-0.44.0` | 19 | 非合并中 | 仅盘点及指纹，不迁入main |
| `codex/qizhi-agent-integration` | 23 | 非合并中 | 仅盘点及指纹，不迁入main |
| `codex/super-agent-0.46.0` | 8 | 非合并中 | 仅盘点及指纹，不迁入main |
| `codex/upstream-merge-0.12.0` | 1080 | MERGE_HEAD存在，原现场保留 | 仅盘点及指纹，不迁入main |
| `codex/upstream-merge-0.8.0` | 5 | 非合并中 | 仅盘点及指纹，不迁入main |
| `codex/aihub-reasoning-2026-10-12` | 1 | 非合并中 | 仅盘点及指纹，不迁入main |
| `codex/codex-runtime-integration-2026-10-10` | 28 | 非合并中 | 仅盘点及指纹，不迁入main |

两个重点遗留：`Easel-upstream-sync` 有218项未提交变更，MERGE_HEAD存在但无未解决索引；`upstream-merge-0120` 有1080项变更、62个未解决文件。均未误报为完成，也未清理或提交其账号资料/草稿。保留旧现场并不代表后续无需整理；应逐模块提取有效改动并验证。

## 上游更新了什么

截至上述固定SHA，2026-11-12最新提交只更新微信群二维码资源；最近实质代码更新在2026-11-09。官方源码版本仍标0.3.0，我方为0.50.2，不能靠版本数字大小判断代码新旧。

上游相对共同基线改变271个文件（175新增、96修改）。直接整仓merge的无写入预览退出1，产生39条文件冲突消息，覆盖模型/setup、Skill、登录发布、聊天/账号/分析前端、web/app及测试。因此本次不执行整仓同步。

| 优先级 | 上游提交与变化 | 本地核对 | 后续吸收方式 |
| --- | --- | --- | --- |
| P0 | `1e2af25b` 防后台完成通知再次执行、按用户意图决定技能/制作；模型引用校验、missing-only默认及setup/doctor对齐 | `model_config.py`、`openclaw_defaults.py`、默认值测试与上游最新文件完全一致；persona/doctor仍有定制差异 | 补后台通知只读、不自启新轮回归；保留我方执行账本、取消恢复及显式发布授权 |
| P0 | `fb55f2fa` / `547c15c2` / `d1321288` 修Skill修改不生效、workspace定位、同步异常及profile加载竞态 | `agents/sync.sh` 与上游一致；web/app及本地编辑/自定义基底仍有差异 | 按源文件→有效workspace→自定义基底→会话加载四层验证，不能静默覆盖用户正文 |
| P0 | `283abb54` 实际目标venv依赖/浏览器启动、Whisper与PyAV解码、Remotion缓存检查 | 本地install_tool不同，新增runtime测试缺失 | 拆运行能力探测专项，防“目录存在即就绪”，验证Windows与138环境 |
| P1 | `aa56fb49` / `b4dd8cb7` / `2b8178a4` 头条登录完成证据、扫码后绑手机、profile保留及发布 | 当前头条发布脚本与上游最新完全一致，新增边界测试不全，ProfilePage有定制差异 | 补真实登录边界及多账号generation/identity隔离，不以脚本相同冒充平台验收 |
| P1 | `da3be42c` / `a815a6d2` Node最低patch、DeepSeek说明、安装器递归解释器/不支持shell保护 | Node floor与process safety测试文件一致，setup脚本仍不同 | 按本地/portable/Linux分别核对，不整抄setup覆盖便携配置 |
| P1 | `2817a81d` / `462ae312` / `7f0809e0` / `3f1d4fb8` 运行预算、deadline账本、认证gateway及默认预算语义 | 与本地运行限制、续跑和取消机制重合，未作完整等价验收 | 确保取消作用域、账本、鉴权与不重放约束一致再迁入 |
| P1 | `afa87bd7` / `3805342e` 本地产物checkpoint及已验视频镜头恢复 | 本地有自己的成果/恢复契约，未整合这条旧链 | 先验证可解码成果、原轮归属与失败恢复，不将进程成功当交付 |
| P2 | `9cf3a865` / `4048b421` / `b990c0cc` 自定义热点协议、Windows子进程代理、macOS退出竞态 | 需按平台测试，静态对照不足 | 不修改已验账号/发布数据语义；单独增加平台复现 |
| P2 | `aebe2f05` / `42fdb454` context声明诊断及BOM处理；`d1b923f9`、`e72b2950`、`e8d32ba5` 技能/热点布局 | 与本地多次UI迭代有差异 | 按实际问题选择，避免旧页面覆盖当前多账号流程 |
| P2 | `52806b36` CI使用runner ShellCheck，paper/record-card等技能及许可更新 | 属于CI/技能能力扩展 | 单独审许可/运行依赖，验证后引入 |

海外账号必须特别区分：上游 `39fa0fdd` 的海外浏览器登录实现后来由 `28ef1d4f` 撤回未验部分；`a89754f1` 的X/掘金发布或采集脚本不等于当前已稳定支持全部海外浏览器账号。不能据“曾提交过”宣传现行支持。

上游原始提交证据（固定SHA）：[最新二维码资源更新 / 9eaec64a](https://github.com/ZJU-REAL/Easel/commit/9eaec64a35858405dedacf8ab2627b53fe65b467) · [后台通知与模型配置 / 1e2af25b](https://github.com/ZJU-REAL/Easel/commit/1e2af25b63d282079c22b0cd4989f6f542c654df) · [真实运行依赖探测 / 283abb54](https://github.com/ZJU-REAL/Easel/commit/283abb544972ef097fde2dcf1e7224ca17cfb47e) · [头条登录边界 / aa56fb49](https://github.com/ZJU-REAL/Easel/commit/aa56fb49fceb94ed871241e708dc2c18ef556700) · [撤回未验海外登录 / 28ef1d4f](https://github.com/ZJU-REAL/Easel/commit/28ef1d4f4455d6a493bbf2a16f2af0d357115204) · [CI ShellCheck来源 / 52806b36](https://github.com/ZJU-REAL/Easel/commit/52806b36f5785e8f585c86ff8cf3021ac8dad34b)。

本次调查基于Git对象、固定提交diff及文件内容对比，没有进行真实平台投稿、付费模型调用或上游全平台运行验收。文件“完全一致”仅指Git blob字节一致，不能扩展成所属模块端到端验收。

## 本轮验证

- 后端15套必要专项：346 passed，2条依赖弃用warning（69.19秒）。覆盖账号巡检、社交账号、账号分析快照、存储、Linux发布、运行版本、Qizhi交付、恢复、运行限制、任务阶段、模型配置和portable launcher。
- 前端TypeScript + Vite生产构建通过；lint退出0，现有Fast Refresh/正则warning及chunk大小warning保留，不宣称零告警。
- 前端首轮全量npm test：运行中，已发现内容分析演示测试替身缺导出导致8项模块加载失败；相关业务源码/测试与整合前基线相同。仅补齐accountHealth/socialAccounts的两处导出替身后，该文件15项专项通过，断言未删除；首轮全量作为独立长跑继续，最终结果另以交付回执补齐，不将专项拼成全量通过。
- 已检查11份变更文档的707个相对链接，无断链；最终提交前再检查无冲突索引/冲突标记、git diff --check、业务源码零差异以及旧dirty工作区指纹。19个旧dirty工作区/1438个tracked dirty文件前后指纹一致。
- 本轮为主线/文档整合，没有界面或服务行为变更，因此没有重新做浏览器/真实账号/138部署验收；旧回执继续保留其原始时间和证据边界。

## 后续工作

1. 当前交付统一main之后，按P0逐项补后台通知不重跑、Skill实际加载与依赖能力探测；涉及代码时另开功能分支、补版本/测试再合回main。
2. 80条历史非等价提交及19个dirty工作区仍按下方清单保留，后续逐模块确认已移植、应放弃或需要提取，未宣称全部清零。
3. 稳定生成/发布A–E、通知历史、长期容量、真实同平台A/B及真实投稿验收仍见[既有规划](stable-generation-publishing-plan-2026-11-12.md)和[用户清单](user-requirements-2026-10-08.md)，本轮不关闭这些事项。

## 附录：80条去重非等价历史提交

以下清单是历史保留项，不是本次待cherry-pick队列。原分支/补丁语义与当前实现可能重叠；没有足够证据时保持“待行为核对”，不采用ours策略伪装全部已吸收。所有SHA仍可通过历史引用定位。

| 旧提交 | 原主题 | 本轮核对与处置 |
| --- | --- | --- |
| `0d2b16500d17` | feat: add content-pipeline workflow for 0.16.0 candidate | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `154c7bc0962a` | docs: record content-pipeline delivery receipt | 历史文档/回执保留；未当作当前状态覆盖main |
| `b3d88669b23b` | docs: record homepage sync SHA for content-pipeline batch | 历史文档/回执保留；未当作当前状态覆盖main |
| `697399473a6d` | fix: task workspace per-entry acceptance fixes for 0.16.0 | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `cadaa896fbcb` | docs: record third-batch acceptance and homepage SHAs | 历史文档/回执保留；未当作当前状态覆盖main |
| `587e39d25cdb` | Fix portable image runtime, model onboarding, pairing and proxy routing | 当前实现已有演进，待行为核对；未重复导入旧补丁（4个旧路径在当前不存在，不据此判定功能缺失） |
| `93236ab368e1` | Document local credential privacy verification requirement | 历史文档/回执保留；未当作当前状态覆盖main |
| `339bcca93c02` | Show portable startup phases and reopen workspace when ready | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `47915c779ebd` | Use isolated portable home for embedded export smoke checks | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `f8232d28a888` | Allow bounded Windows cold gateway startup with progress | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `42c2b9c279ef` | Initialize canonical portable device identity before gateway writer starts | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `f9ab42dd64bf` | docs: record validated portable directory and empty image settings | 历史文档/回执保留；未当作当前状态覆盖main |
| `125831740ce7` | docs: add private ZIP request and connection reset result | 历史文档/回执保留；未当作当前状态覆盖main |
| `e5e5d2d87504` | fix: preserve and configure exact model reasoning declarations | 当前实现已有演进，待行为核对；未重复导入旧补丁（4个旧路径在当前不存在，不据此判定功能缺失） |
| `52cfd4deddde` | feat: retain per-turn elapsed time across streaming and recovery | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `7e3de0885574` | feat: default reasoning to the highest supported effort in composer | 当前实现已有演进，待行为核对；未重复导入旧补丁（3个旧路径在当前不存在，不据此判定功能缺失） |
| `be46e1e815f6` | feat: add live browser pane view and fix silent popups | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `e4a0e9789ed8` | fix: re-observe after any failed browser action | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `c9af58d66da7` | fix: report a failed action that actually navigated as moved | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `47161e46b204` | docs: plan Codex runtime integration and visible reasoning | 历史文档/回执保留；未当作当前状态覆盖main |
| `356b80ab72a4` | fix: ship compact continuation controls independently of candidate features | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `47707d3573a1` | fix: deliver ask-user question cards reliably | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `733621dc3dbc` | docs: record 0.44 cross-device sync scope | 历史文档/回执保留；未当作当前状态覆盖main |
| `c510281dbf8e` | docs: record 138 question-card feedback | 历史文档/回执保留；未当作当前状态覆盖main |
| `80d88b793729` | fix: make 138 release builds resilient to protected receipts | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `2928ab7a75d8` | fix: preserve 138 release baseline across disk migration | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `fcc39a344308` | fix: reconcile native question waits and protected release backups (0.43.9) | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `759bf276531f` | docs: re-measure the upstream gap and revise the merge plan | 历史文档/回执保留；未当作当前状态覆盖main |
| `80a2025f2192` | docs: add inference-framework and agent-memory research notes | 历史文档/回执保留；未当作当前状态覆盖main |
| `bbe1890aeba3` | docs: diagnose 138 chat crash and outbound network errors | 历史文档/回执保留；未当作当前状态覆盖main |
| `6bfc7b77b3a1` | feat: add deterministic repair agent and XHS workflow routing | 当前实现已有演进，待行为核对；未重复导入旧补丁（10个旧路径在当前不存在，不据此判定功能缺失） |
| `c23f6c916c81` | feat: harden super agent lifecycle and repair budgets | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `970f94718fc7` | docs: record super agent hardening delivery | 历史文档/回执保留；未当作当前状态覆盖main |
| `27cec0f17a0e` | feat: surface tool lifecycle in execution panel | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `a3390ae66af6` | feat: enforce repair stop fences and lifecycle evidence | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `46797b6508ee` | feat: add server-held same-account multi-platform publish batches (0.11.0) | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `f27a59f23c58` | feat(accounts): add seven-platform account distribution and clear selection UI | 当前实现已有演进，待行为核对；未重复导入旧补丁（2个旧路径在当前不存在，不据此判定功能缺失） |
| `7eac40684ace` | docs: record verified account distribution delivery and preview repair | 历史文档/回执保留；未当作当前状态覆盖main |
| `3f003b211306` | feat: guide publishing with numbered steps and linked image cards | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `72a15e2d5097` | docs: record publishing workflow verification and delivery | 历史文档/回执保留；未当作当前状态覆盖main |
| `62beb42657fc` | docs: require account workflow integration into latest source | 历史文档/回执保留；未当作当前状态覆盖main |
| `556528fd72b9` | feat: integrate Qizhi remote agent with verified session and file transport | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `653d8cf2a5f0` | fix: settle Qizhi web turns with identity-bound completion receipts | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `d8fc86e49984` | docs: record host 138 deployment of 0.13.3 | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `3a951816f8cf` | fix: make account growth snapshots real and concurrency-safe | 已明确移植至83e89ff2；原提交保留溯源 |
| `efd46138e30f` | docs: compare agent products and prioritize task recovery | 历史文档/回执保留；未当作当前状态覆盖main |
| `70991cc575e0` | fix: adopt upstream reliability updates for 0.2.9 | 当前实现已有演进，待行为核对；未重复导入旧补丁（3个旧路径在当前不存在，不据此判定功能缺失） |
| `b54780822bc2` | docs: record 0.2.9 adoption and preserve concurrent release receipts | 历史文档/回执保留；未当作当前状态覆盖main |
| `196015f6bb38` | fix: explain unavailable search in generic tool receipts | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `e824e11c0606` | docs: record verified local search diagnosis delivery | 历史文档/回执保留；未当作当前状态覆盖main |
| `a2a4577e43e2` | docs: plan chat context capacity and global notifications | 历史文档/回执保留；未当作当前状态覆盖main |
| `56d294ff02d2` | docs: follow Chinese-only delivery preference | 历史文档/回执保留；未当作当前状态覆盖main |
| `54efd7ef26dc` | 文档：记录中文方案与远端核验回执 | 历史文档/回执保留；未当作当前状态覆盖main |
| `cfddde6cfaeb` | 文档：调研爆款拆解并设计素材与结果流程 | 历史文档/回执保留；未当作当前状态覆盖main |
| `976992f2d379` | 文档：补齐拆解工作台交互调研与可靠性评测方案 | 历史文档/回执保留；未当作当前状态覆盖main |
| `d669eabd67bd` | 文档：记录爆款拆解方案Git与在线核查回执 | 历史文档/回执保留；未当作当前状态覆盖main |
| `f972e8fcff03` | 文档：收敛爆款拆解新手流程 | 历史文档/回执保留；未当作当前状态覆盖main |
| `7d8724e07f83` | 文档：补充爆款拆解报告研究与样稿 | 历史文档/回执保留；未当作当前状态覆盖main |
| `b8b123e0e554` | feat: 爆款拆解默认结果改造为内容拆解报告契约 | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `76209f74d79e` | docs: 记录爆款拆解报告改造推送回执 | 历史文档/回执保留；未当作当前状态覆盖main |
| `f2c850ed3231` | docs: 记录爆款拆解报告本地项目同步回执 | 历史文档/回执保留；未当作当前状态覆盖main |
| `3a64719460fa` | docs: 记录本地7880启动与浏览器核对回执 | 历史文档/回执保留；未当作当前状态覆盖main |
| `68ca67280b20` | docs: 记录思考档位与模型能力冲突的处理回执 | 历史文档/回执保留；未当作当前状态覆盖main |
| `5d97e38b3988` | feat: 爆款拆解输入区重构为材料面板 | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `1bfdf7799a0b` | docs: 记录输入区重构交付与验证回执 | 历史文档/回执保留；未当作当前状态覆盖main |
| `0367775a88ad` | docs: 记录新手一屏收敛的纠正与复核回执 | 历史文档/回执保留；未当作当前状态覆盖main |
| `7806e4185c03` | docs: 记录输入区最终对齐首页创作框的回执 | 历史文档/回执保留；未当作当前状态覆盖main |
| `34a700673b62` | docs: 记录拆解输入区功能对齐的回执 | 历史文档/回执保留；未当作当前状态覆盖main |
| `cc547e0e7671` | docs: 记录渠道侧 410 故障的环境事件与证据 | 历史文档/回执保留；未当作当前状态覆盖main |
| `874732799fef` | docs: 记录切模型到 glm-5.3 的执行回执 | 历史文档/回执保留；未当作当前状态覆盖main |
| `74c8ec4cfc8f` | feat: 拆解草稿与历史持久化＋引用逐字校验 | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `f88d701b8423` | docs: 记录持久化与引用校验的推送回执 | 历史文档/回执保留；未当作当前状态覆盖main |
| `07f2460b9c6a` | feat: 报告结构程序检查（章节＋发现四要素） | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `d48ee57d7e5e` | docs: 记录结构检查的推送回执 | 历史文档/回执保留；未当作当前状态覆盖main |
| `e79273bfb832` | docs: 首页与总方案同步当前实现，补实施进度映射 | 历史文档/回执保留；未当作当前状态覆盖main |
| `777e2a98079a` | docs: 记录上游 main 核对（无新更新，C–F 待办） | 历史文档/回执保留；未当作当前状态覆盖main |
| `548c49d59f00` | fix: 排期摘要离事件循环、Job 事件坏行不丢整段（上游 #125 同病） | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `0b43af78e12e` | feat: 拆解生成中任务找回（离开页面不丢报告） | 当前实现已有演进，待行为核对；未重复导入旧补丁 |
| `4b5ef3440081` | docs: 记录任务找回的验证与推送回执 | 历史文档/回执保留；未当作当前状态覆盖main |
| `0c38977479e4` | docs: 需求清单登记任务找回与回执 | 历史文档/回执保留；未当作当前状态覆盖main |
