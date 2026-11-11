# 上游 Git 冲突处理评估 · 2026-11-11

## 结论与推荐路线

保留旧合并工作区，以当前0.49.7候选为本项目基线，在新的隔离整合分支合入固定上游提交，再逐项复用旧现场的有效修改。**本轮完成评估，没有修改原冲突文件、标记解决、完成合并或部署138。**

原因不是冲突标记难以删除，而是旧合并基线落后、已有人工成果尚未入索引，且最新候选已经包含一次正式上游合并。继续在旧0.11.0上把62项一并`git add`，会把“索引已解决”和“最新产品功能已保留”混为一谈。

## 本轮实测引用

| 对象 | 固定引用 | 说明 |
| --- | --- | --- |
| 旧合并工作区 | `C:/Users/l/.codex/worktrees/upstream-merge-0120/Easel` | 分支`codex/upstream-merge-0.12.0`，仍处于合并中。 |
| 旧HEAD | `46797b6508ee5d3535f039c6e116c2846153022a` | 2026-11-08，0.11.0服务端批次发布。 |
| 旧MERGE_HEAD | `5c12e42e9019d276368130b52385b770749ffa6f` | 2026-11-02的上游快照。 |
| 当前候选 | `754fd0de4c2554e8ff2a813867a4a7e0679acd7e` | 0.49.7；正文保护源码为其父提交`28bdfccb`。候选仍待放行。 |
| 最新上游main | `52806b36f5785e8f585c86ff8cf3021ac8dad34b` | 本轮fetch/远端核对；比旧MERGE_HEAD新增27个提交。 |
| 当前候选与最新上游共同祖先 | `8d08b216105bd7c7057c84c97cd637cec44db609` | 该上游版本已由`dd0863772021a35832e988f8be9fd47312043920`正式合入当前候选历史。 |

因此，旧文档中的“自v0.2.1后从未合并上游”只适用于当时的分支，不能用于当前候选。旧HEAD和当前候选的历史左右分别有9/423个独有提交；这是提交可达性差异，不等于9项业务功能缺失或423项需要重放。

## 62项旧现场的实际状态

- 索引中仍有62个未合并路径，但62个文件中都没有`<<<<<<<`起始标记。
- 其中24个Python文件静态AST解析通过；这只证明语法可解析，不证明行为或测试通过。
- 归一CRLF/LF后，49个文件既不等于旧我方整文件也不等于旧上游整文件；另有6个等于旧我方、4个等于旧上游、3个只等于当前候选。与当前候选相同的文件合计7个。这些比较只是内容盘点，不能把49项都当成正确的人工合并。
- 额外有10项工作区修改：`easel/skills_sync.py`及9份测试；另有未跟踪`failed_by_file.txt`、`test-profile-root/`。不能被批量覆盖或无差别加入提交。
- 原冲突分布：根目录8、agents 2、assets 1、docs 2、easel 9、scripts 2、skills 10、tests 5、web 23。

旧现场已经有大量编辑成果，后续需要作为比较来源保留。不要直接`checkout --ours/--theirs .`、`git add .`、`reset --hard`或`merge --abort`；也不把未合并索引交给普通stash当作可靠备份。

旧分支9个独有提交需逐项核对，而非整体丢弃或重放：

```text
46797b65 feat: add server-held same-account multi-platform publish batches (0.11.0)
a3390ae6 feat: enforce repair stop fences and lifecycle evidence
27cec0f1 feat: surface tool lifecycle in execution panel
970f9471 docs: record super agent hardening delivery
c23f6c91 feat: harden super agent lifecycle and repair budgets
6bfc7b77 feat: add deterministic repair agent and XHS workflow routing
bbe1890a docs: diagnose 138 chat crash and outbound network errors
80a2025f docs: add inference-framework and agent-memory research notes
759bf276 docs: re-measure the upstream gap and revise the merge plan
```

其中旧批次发布与最新多账号分发存在演进关系，Super Agent也已有后续实现；要以功能和测试比对，避免重复挂接、丢失停止语义或引入旧接口。

## 最新基线只读预演

使用`git merge-tree --write-tree --name-only --no-messages`。它写Git对象以生成预演树，不修改工作区、索引或创建合并提交。

| 我方基线 | 上游目标 | 冲突文件数 |
| --- | --- | ---: |
| 当前候选`754fd0de` | 旧目标`5c12e42e` | 30 |
| 当前候选`754fd0de` | 最新目标`52806b36` | **39** |

最新预演共有217个文本冲突块，不能把39个文件理解为39次简单选边。原始输出和块位置保存在本机忽略目录`.artifacts/upstream-conflict-audit-20261111/`，不提交预演源码或临时产物。

## 关键冲突如何处理

### 聊天启动、锁与恢复

`web/app.py`有29个冲突块，涉及模型配置、`start_chat_run`、问题答复/状态、登录、统计、发布预检及会话删除等。保留本项目运行账本、turn/session归属、持久任务与取消语义；逐段吸收上游锁、错误分类和收尾修复，不能整文件覆盖。现有Gateway取消归属专项已有失败，必须先复现并区分合并前后行为。

`easel/gateway_questions.py`同时存在本项目的accepted/final等待、回调与RPC错误元数据，以及上游的closed状态与更精确的不支持方法分类。应组合两套语义，验证accepted不是最终成功、关闭/过期不重试、终态只处理一次。

### 按账号发布与回执

`skills/shared/scripts/web_publisher.py`有5个冲突块。保留`expected_account_id`、当前身份二次校验及规范化回执；上游新增的summary和平台响应回执作为补充。上游平台响应对象与本项目统一回执即便都名为receipt，也不能当成同一结构使用。已提交、待审核、私密、未知结果都不能提升为已公开发布；未知结果不得自动重发。

发布前端和`web/app.py`必须继续走服务端按账号受理、独立确认稿/素材封存、requestKey幂等及0.49.7正文保护。不能因为上游入口更短就退回逐平台直接发请求。

### 问题卡片的行为冲突

`QuestionCards.tsx`有12个冲突块。当前候选引入30秒推荐项自动提交；另一侧包含状态查询、关闭/到期锁定等逻辑。这是行为契约冲突，不能仅保留计时器或仅删除失败测试。应先明确兼容目标，把人工答复、自动选择来源、到期/关闭、后台恢复和重复提交纳入同一组前后端测试。正式0.49.6的显式回复与候选自动选择差异继续单列为放行门槛。

### 前端布局和共享组件

`App.tsx`有35个冲突块，样式聚合文件有18个；保持本项目现有布局、任务/草稿状态和拆分样式结构，补入上游实际修复。侧栏双列默认折叠、点击“对话”打开聊天与会话列、重复点击保留草稿等要求不得回退。

`SkillDrawer.tsx`两侧分别使用本地共享Select封装和上游SettingsSelect。沿用本项目共享组件并吸收需要的键盘/可达性修复，避免增加并行选择控件体系。账号页保留accountId、独立登录历史与身份归属。

### 依赖与安装脚本

`pyproject.toml`的具体冲突可以保留本项目`biliup==1.2.9`锁定，同时加入上游`av>=11,<19`；还需验证目标环境可安装及与发行锁一致，不能直接恢复宽泛biliup版本。保留本项目版本来源，不能采用上游较低版本号。

`setup.*`与`install_tool.py`按功能段合并：保留当前渠道/协议和部署配置，接入上游Node兼容、实际venv包检测、媒体依赖及防递归启动修复。只做静态评估时不执行安装脚本。正式整合若引入大模块按项目约定递增minor；本轮文档评估不改版本。

## 最新39个文件的处理清单

下列顺序是实施分组，不是已经解决的状态；双方测试都保留。

| 文件 | 处理策略 |
| --- | --- |
| `easel/cli.py` | 合并代理/运行环境处理，保留本项目命令入口。 |
| `easel/commands/doctor.py` | 合并配置、Node能力和默认值诊断，保留当前路径及渠道诊断。 |
| `easel/commands/ping.py` | 统一代理处理与回环探测，验证显式坏代理不会误判本机。 |
| `easel/commands/skill.py` | 保留技能管理契约，合并代理与运行环境修复。 |
| `easel/gateway_questions.py` | 合并accepted/final、错误元数据和closed状态处理。 |
| `easel/openclaw_workspace.py` | 合并原生模型/工作区初始化，保留用户已有显式设置。 |
| `easel/persona.py` | 合并画像提示及工作区语义，保留隔离和现有任务约束。 |
| `web/app.py` | 按模型配置、聊天生命周期、账号、统计和发布逐段合并。 |
| `skills/shared/scripts/web_publisher.py` | 保留账号身份与统一回执，补summary及平台响应证据。 |
| `pyproject.toml` | 合并依赖，保留本项目版本与biliup锁定。 |
| `setup.ps1` | 按安装/认证/模型配置段合并，保留Windows和部署契约。 |
| `setup.sh` | 合并原生配置、Node及安装防护，不覆盖生产配置。 |
| `skills/shared/scripts/install_tool.py` | 合并媒体运行时及解释器探测，静态与隔离环境验证。 |
| `web/frontend/src/lib/api.ts` | 保留本项目账本/恢复/账号API，补端点和错误协议，不重复定义。 |
| `web/frontend/src/lib/store.ts` | 合并状态字段与清理逻辑，保留会话、草稿及持久化兼容。 |
| `web/frontend/src/lib/skillDisplayNames.ts` | 合并展示名与映射函数，保持稳定标识。 |
| `web/frontend/src/App.tsx` | 保留现有状态与路由，逐功能挂接上游修复。 |
| `web/frontend/src/components/AccountsPage.tsx` | 保留多账号及登录记录，补上游状态与可达性修复。 |
| `web/frontend/src/components/ChatPage.tsx` | 保留执行面板、子任务、浏览器与问答接线。 |
| `web/frontend/src/components/DashboardPage.tsx` | 保留真实快照与增长口径，合入布局/入口修复。 |
| `web/frontend/src/components/OutputsPage.tsx` | 保留真实文件和产物操作语义，合并标题/布局修复。 |
| `web/frontend/src/components/ProfilePage.tsx` | 保留画像隔离、编辑与切换能力，核对新增画像库接线。 |
| `web/frontend/src/components/PublishPage.tsx` | 保留服务端批次和独立确认稿，合并预检与状态处理。 |
| `web/frontend/src/components/QuestionCards.tsx` | 先统一答复/自动选择/过期/关闭协议，再实现与测试。 |
| `web/frontend/src/components/SettingsPanel.tsx` | 保留供应商与模型渠道流程，合入原生能力配置修复。 |
| `web/frontend/src/components/Sidebar.tsx` | 保留双列及默认折叠契约，补键盘与触屏行为。 |
| `web/frontend/src/components/SkillDrawer.tsx` | 复用本项目共享选择组件，合入键盘及配置项修复。 |
| `web/frontend/src/components/SkillPage.tsx` | 保留技能编辑/依赖功能，合入卡片键盘与交互修复。 |
| `web/frontend/src/components/TrendsPage.tsx` | 合并来源管理、标题空间和操作入口，保留当前风格。 |
| `web/frontend/src/styles/index.css` | 按组件分区处理18个样式冲突块，不整段覆盖或重复追加。 |
| `tests/frontend/streamChat404.test.mjs` | 合并请求失败与恢复断言，保持不重复POST等契约。 |
| `tests/test_bugfix_regressions.py` | 保留双方用例，适配实际入口而非删除断言。 |
| `tests/test_persona_security.py` | 合并画像隔离/输入安全用例，不减少防护。 |
| `tests/test_trends.py` | 合并双方夹具与用例，核对来源/任务接口。 |
| `README.md` | 以本项目真实功能及部署状态为主体，补上游归属和兼容信息。 |
| `README_EN.md` | 与中文首页保持相同事实边界。 |
| `agents/workspace/AGENTS.md` | 合并执行边界与运行时约束，保留用户的实际生图要求。 |
| `docs/known-issues.md` | 合并问题列表，按当前复现结果标注，不能覆盖成上游状态。 |
| `docs/skill-function-mapping.md` | 核对本项目实际技能和入口后更新映射。 |

## 建议实施顺序与完成条件

1. 保留原合并工作区及未合并索引；保存tracked文件差异和索引元数据，个人登录目录/QA数据只在本地保留，不进入Git。
2. 以固定候选为起点，在新的隔离整合分支执行真正的上游合并，保留两个父提交的祖先关系。此次建议目标固定`52806b36`，不边解冲突边追逐浮动main。
3. 先处理依赖/安装/网关基础，再处理`web/app.py`与发布回执，然后API/store、App/页面及样式；逐组跑双方相关测试。旧现场的编辑仅按差异移植，不整文件覆盖新基线。
4. 对旧分支9个独有提交和10项额外工作区修改逐条登记：已被后续实现替代、需要移植、仅文档或临时产物；全部有去向后才考虑关闭旧现场。
5. 比较相同环境下合并前后的失败清单。现候选后端5526通过/9失败/5错误/110跳过、前端1569通过/7失败，是已知不绿的长跑记录；交接夹具后来定向修复，不把这些记录当作最终基线全绿。需要核对合并是否新增失败，并清理正式放行所需的剩余红灯。
6. 验证聊天锁/恢复/停止、问答关闭与答复、账号登录历史、八账号分发/回执/重放、配置旧数据兼容；前端build/lint及1440/390px实际浏览器逐项验证菜单和跳转。离线或模拟通过不代替真实平台验收。
7. `git ls-files -u`为空、冲突标记扫描干净、双方回归与版本/文档同步完成后，创建合并提交，推送独立分支并核对远端SHA；main功能合并与138上线仍分别处理。

本轮仅提交本评估和任务/进度记录。138保持0.49.6，原候选包、生产镜像、当前软链接及存储门槛均未改变。
