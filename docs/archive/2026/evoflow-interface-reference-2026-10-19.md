# EvoFlow 界面与交互研究：Easel 值得借鉴的部分

研究日期：2026-10-19。结论面向 Easel 创作、技能导入、账号及发布工作流。

## 结论

**值得借鉴，但应优先学习状态、操作和结果如何连在一起，而不是复制整套外观或迁移运行器。** EvoFlow 最有价值的是：集中处理任务、固定位置呈现执行决策、在任务详情中完成验收或修订，以及把异常整理成可查看和复制的时间线。

Easel 已有右侧浏览器/文件/执行面板、目标暂停与人工验收、定时任务、Agent 办公室、持久事件通知、发布回执和模型测活。差距主要是这些能力分散，以及用户遇到失败后缺少统一的定位和处理入口，不能把它们写成“我们完全没有”。

建议顺序：**异常复盘入口 → 跨来源任务列表 → 计划与验收操作 → 技能管理状态 → 右侧多文件与子任务详情 → 可复用工作流。** 登录状态刷新继续按我们自己的平台核验实现治理；没有证据证明 EvoFlow 解决了同样的多平台登录问题。

## 研究基线与证据范围

| 项目 | 固定基线 | 本轮证据 |
|---|---|---|
| EvoFlow | [`70722435b7890c828e015d702ffa1697a2534d5a`](https://github.com/EvovexAI/EvoFlow/commit/70722435b7890c828e015d702ffa1697a2534d5a)，前端 package/VERSION 1.1.1 | 仓库树、重点页面/组件/状态库、任务后端、部分测试源码、许可证、仓库指南，以及官网说明与官方演示截图 |
| Easel | [`b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e`](https://github.com/StarrySea1412/Easel/commit/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e)，源码 0.3.6 | 当前实际前端、目标与任务契约、失败事件后端及上一轮缺陷修复记录 |

- 对照读取了 EvoFlow 51 份文件：首批 38 份，补充成功 13 份；另一个补充路径未取得，未据此作结论。范围包括任务中心/详情、技能、日志、模型、工作流、计划确认、Goal、子任务、Stage、文件预览及相关契约，不是全仓库逐文件审计。
- 真实浏览器只读访问了 GitHub、官网快速开始、任务中心说明、产品演示；查看了“开始执行确认”和“子任务工作流”官方原图。它们证明官方展示的布局，**不证明当前提交实际运行成功**。
- 官网任务中心说明比本次源码简略，示例文字也不完全一致；交互实现以固定源码为主，官网材料只作视觉参考。官网可能继续变化。
- 未安装或运行 EvoFlow，没有执行外部技能、模型推理或它的测试套件；测试文件只用作设计意图的辅助证据，没有报告其测试通过。
- 文档核对：44个固定提交源码链接的文件与行号在本机源码/Git对象中存在，1个关联文档链接存在；这不等于逐个浏览器HTTP验收。纯文档变更仅做链接/行号及Git差异检查，不重复运行产品测试。
- 本轮仅研究与文档交付，不改现有 UI、不升版本、不部署138或发布安装器。上一轮真实平台登录及多平台发布恢复仍未验收。

## 可以直接借鉴的交互清单

成本说明：“低”为已有接口之上的展示与导航；“中”为多来源聚合、持久状态与前后端联动；“高”为新增任务契约、执行或版本能力。以下均为工作量判断，不是已实现承诺。

| 优先级 | EvoFlow 更清楚的做法 | Easel 当前实际情况 | 建议落地 | 成本 |
|---|---|---|---|---|
| P0 | 系统日志集中按时间、来源、级别查看并复制异常时间线 [E1] | 0.3.6已有持久失败事件和错误编号；通知中心、运行记录、发布回执分别存在，缺少统一失败诊断界面 [A1][A2] | 用现有失败事件建“问题记录”入口，编号可打开对应详情，显示失败阶段、版本、来源和可用下一步 | 低到中 |
| P1 | 任务中心常驻状态标签、来源筛选、高级条件折叠、筛选写URL [E2] | 定时任务、对话目标、办公室和发布回执分散；运行记录主要按会话查看 [A3][A4] | 先做跨来源只读任务列表，显式区分“需要我处理/运行中/异常/已完成”，点击回到原有操作页 | 中 |
| P1 | 计划确认条固定在输入框附近；详情有目标、步骤、依赖、验收 [E3] | 已有目标编辑、执行上限、步骤、暂停/继续和人工验收；普通目标创建默认保存后启动 [A5] | 对用户选择“先规划”的复杂任务增加计划预览与明确启动入口；把等待输入、等待验收提升为可见操作条 | 中；完整步骤图授权需高成本 |
| P1 | 交工后“确认完成/要求修改”；失败时区分“重试失败步骤/重新执行” [E4][E5] | 已有目标“验收并完成”和重新核验；尚无通用DAG节点恢复契约，发布结果还有不确定态 [A5][A6] | 增加带说明的“要求修改”闭环；先支持查看失败、恢复登录、重新核验，具备后端恢复条件后再开放局部重跑 | 中到高 |
| P1/P2 | 技能已安装/市场分开，按钮随安装/更新/不兼容状态变化，安装后给下一步 [E6] | ClawHub已能详情、按作者导入、目录回读、导入并选中和失败编号；已有技能依赖展示 [A7] | 技能管理页补来源/版本及可核实的更新状态，导入后给“本轮使用/查看技能”；保留创作框的一步导入并选择 | 中 |
| P2 | Stage 多标签、关一个不清其它、收起保留、关闭后可重开、会话间恢复 [E7] | 已有可调宽侧面板、工具标签、辅助对话重开、HTML/图片/视频预览；文件选择仍主要在一个文件面板内 [A8] | 增加按文件身份打开的多文件标签、原文/预览切换和返回来源；不重做整个侧栏 | 中 |
| P2 | 依赖图与节点详情、子任务实时卡片/抽屉分离，主对话保留摘要 [E8] | 办公室已有成员、任务和执行过程；目标步骤以线性列表展示，尚不能据此宣称已有完整可恢复DAG [A4][A5] | 先用真实成员/轮次/节点ID做“摘要→子任务详情”，再考虑图；先清掉既有Subagent P0待办 | 高 |
| P3 | 计划另存工作流；草稿保存、发布、版本与运行历史分开 [E3][E9] | 定时计划可复用目标与触发条件，技能可复用能力；不是同样的版本化节点工作流 [A3] | 从“选题→资料→脚本→素材→发布前检查”的固定创作模板入手，等节点输入/输出与恢复规则稳定后再做画布 | 高 |

## 1. 最先学：失败应当有可打开的处理入口

EvoFlow 的系统日志页提供时间窗、来源和级别筛选，以及“复制异常时间线”；页面还区分 Gateway 与桌面本地兜底来源。这比只在报错瞬间弹出提示更适合事后排查。[E1]

对我们最有用的改造是把刚补的失败事件数据真正交到用户手里：

1. ClawHub 或发布失败提示中的错误编号可点击，打开“问题记录”详情。
2. 详情先给用户可理解的摘要，再展示时间、操作、阶段、公开平台/技能标识、HTTP状态、事件来源、运行版本和SHA；缺失字段显示未上报。
3. 用已经持久记录的字段生成可复制诊断摘要。服务端与浏览器有同一编号时关联展示；没有关联字段的事件不靠时间相近强行拼成因果链。
4. 允许的动作取决于事实：登录失效→账号页；目录回读失败→重新读取；结果未确认→查询已有回执。服务端未登记成功时不能显示“已记录”。

例：这次PPT导入应能看到“下载阶段 / 上游409 / 作者与slug / 构建版本 / 错误编号”，进而定位作者歧义。当前白名单不保存上游错误原文，不能凭空生成更详细的解释。发布前拦截应标明“浏览器校验阶段”，避免误认为平台已收到请求。[A1]

**验收重点**：刷新后仍能按编号找到事件；API不可读与没有记录分开；编号/平台/阶段筛选准确；复制内容无标题正文、Cookie、密钥、素材路径或异常原文；查询权限与日志轮转保持现有约束。现有有界接口不足以覆盖全部历史筛选时，必须标明加载范围或补服务端分页，不能把最近50条当作全部失败。

## 2. 学任务中心的聚合方式，保留我们的状态依据

EvoFlow 的任务中心把主要状态、来源筛选和低频高级条件分层；筛选条件写入hash，返回列表可恢复。列表静默轮询，避免每次更新覆盖搜索输入；有独立待审批聚合。这些细节能显著降低“任务去哪了”的成本。[E2]

Easel 第一版适合做**跨来源读取与导航**，而不是立即重写全部任务后端：

- 对话目标继续以 `TaskGoal/TaskRun` 为准；定时任务保留“计划是否启用”和“最近一次运行结果”两种状态。
- 发布继续用现有receipt状态，保留验证码等待、平台处理、待核实等差别。
- 办公室只展示实际观测到的任务和成员；没有任务归属的工作区文件不能自动记成某个成员的交付物。
- 聚合行保留来源和原对象ID。服务读取中断保留旧快照并显示过期，不把读取失败变成0条任务。
- “需要我处理”包括等待输入、验证码、验收和登录处理；异常可以单独查看。已读通知不等于任务已完成，不能用通知已读状态结案。

**不照搬它的分裂**：聊天Goal与协作任务采用不同模型/入口；Goal指南同时存在“可在任务中心查看运行记录”和“不属于任务中心”的表述，不能据此宣称它已经统一覆盖所有任务。Easel可以直接统一我们现有来源的读取。其页面本地状态分组还把 `reviewed` 列入完成组，而任务详情对该状态仍提供确认/打回，应在我们自己的投影中始终区分“执行结束”和“验收完成”。[E2][E4][E10]

**验收重点**：切来源/状态不会串对象；后退与刷新还原筛选；动态刷新保留输入和选中项；入口回到准确对话/目标/回执；失败/过期/空列表三者可分辨；同一对象多次通知不重复算任务。

## 3. 学计划预览、明确启动、可修订的闭环

官方示例把执行确认条放在输入框上方：目标摘要、步骤数、“查看计划”和“开始执行”同时可见。源码中的“查看计划”独立于启动忙碌态；计划详情包含目标、执行步骤、整体验收和待确认事项。用户不必相信聊天气泡里一句“现在开始了”。[E3]

Easel已有目标人工验收与执行上限，应该在这个基础上补足交互，而不是新增一个只有名字不同的Goal系统：[A5]

- 对用户选择的先规划流程，展示可核对的步骤/交付/验收摘要，再允许启动。仅画前端按钮不能构成执行保护；需要服务端验证当前计划版本与状态。
- 等待用户输入或验收时，在当前工作区露出明确动作；用户收起详情后仍能知道为什么停住。
- 保留“验收并完成”，增加“要求修改”及必填说明，说明进入下一轮上下文并关联本次交付。已有“修改目标”不能直接当作对本次结果的返工记录。
- 重复点击、过期页面或另一标签页改过计划时，服务端应返回当前状态，避免重复启动或批准旧计划。

只对需要先规划的复杂任务增加这一阶段；日常对话和已授权的普通工作保持直接操作。不要给每个步骤都加确认，也不照搬“Ask/Agent/Plan/Goal/托管”等大量入口；它自己的指南已经需要反复解释这些模式的区别。[E10]

## 4. 学恢复操作的区分，不把“重试”当成一个万能按钮

EvoFlow 任务详情明确分开“重试失败步骤”和“重新执行”；后端的批量失败重试仅挑 `failed/error/timed_out` 子任务，重置状态并增加尝试计数；整个任务重启则创建新任务并归档原任务。这是有后端语义支撑的交互，不是按钮文案变化。[E4][E5]

Easel当前应先完善操作选择：

| 当前事实 | 适合提供的操作 |
|---|---|
| 账号已确认失效 | 前往账号页重新连接，保留发布草稿 |
| 登录状态过期或核验失败 | 重新核验；展示检查时间，不直接当作在线或已退出 |
| 导入成功但目录不可读 | 重新读取/核实目录，先确认是否已落盘 |
| 明确没有提交内容 | 用户修正条件后重新提交 |
| 平台提交结果不确定 | 查询既有回执/内容，确认结果后再决定是否重发 |
| 无副作用、已有持久节点与输入的失败步骤 | 用户选择后恢复该步骤，并显示新尝试记录 |

我们已有回执核验、结果未确认和“不因工具返回就当完成”的约束，应继续保留。只有任务节点、依赖、输入快照和重复操作语义稳定后，才能推出通用“从失败步骤继续”。不能用一次新模型调用冒充旧任务断点恢复。[A6]

## 5. 技能市场值得学状态呈现，不值得照搬默认结论

EvoFlow 的已安装/市场视图、安装/已安装/更新/不兼容按钮，以及成功后的下一步很直观。我们可以把同类状态补到技能管理页，统一展示来源作者、版本、本轮选择情况和错误编号。[E6]

但我们创作框已经有“导入并选择”，而且按作者+slug核对本机登记后再选择，不应改成更多确认弹窗或安装后让用户手动找技能。[A7]

必须避免几处源码中的做法：

- 风险缺失时默认 `常规`、权限字段退而展示许可证，会让未知信息显得已经核查。我们应分别显示风险未评估、权限未提供、许可证声明。
- 安装后按钮切到成功，不等于依赖就绪、可被当前模型成功调用。我们保留实际目录回读及依赖状态。
- 其已安装集合按slug/名称判断；本次PPT故障已经证明作者维度有实际意义。我们继续使用公开来源+作者+slug+版本，避免同名技能混淆。
- 其“添加到智能体”当前只提示用户去编辑页勾选，并没有在该按钮里完成绑定；不能把它推荐成已经闭环的一键分配。
- 更新与不兼容标签依赖真实返回字段；没有版本清单或兼容规则时，先做来源与版本展示，不能伪造可更新/可运行结论。

## 6. 右侧工作区应增量补齐，不重做

EvoFlow Stage 的可参考细节包括：按kind+id识别标签、单独关闭、收起保留、关闭后重开、拖动排序与会话切换记忆；特定面板切签仍挂载，浏览器标签的URL按各自surface存储，避免后台标签串页。写文件流默认不强行展开侧栏，必须显式要求自动打开。[E7]

Easel已有面板标签、保活的工具内容、可调宽度、文件选择、辅助对话关闭/重开和多种产物预览。因此后续只补明显差距：[A8]

1. 同时比较两个产物时，按产物ID打开两个文件标签，而不是反复在单个文件列表里切换。
2. 文本/Markdown增加原文与预览；记录来自哪个会话和轮次；更新文件保留用户阅读位置。
3. 工具输出或新文件到达时只更新后台内容/提示，不抢用户正在看的面板。窄屏用抽屉或单面板，不能硬挤桌面并排结构。
4. 子任务只在主对话显示摘要；按真实task/agent/turn身份打开过程详情，关闭详情不停止执行。[E8]

不要照搬它的所有实现：多个FORCE_MOUNT面板会增加资源占用；Stage测试明确拒绝旧 `artifacts` kind，不能照旧说明再造一个已退役的“Artifacts tab”。没有浏览器实测，不宣称其全部面板保活、焦点和窄屏均正确。[E7]

## 登录失效问题与这次研究的关系

EvoFlow有按业务域发事件并触发页面局部重读的刷新总线；任务页每45秒静默拉取。这可以参考为“操作成功后，相关页立即失效并重读”的模式，**不能据此声称它有更好的平台登录续期**。[E11]

我们的0.3.6已实现账号/发布页可见时每60秒检查、在线结论120秒有效、焦点/网络恢复唤醒、提交前强制核验和失效回写。已知范围仍是这两个页面，Dashboard/侧栏等入口不等于全局常驻平台巡检。后续应从现有 `whoami` 数据源统一读“状态+检查时间+过期原因”，核查所有入口，不另建第二套登录缓存；不把访问令牌能否静默续期与浏览器平台登录重新验证混为一谈。[A9]

## 不建议整体引入的部分

- 不迁移整套Supervisor/LangGraph/员工职责/组织及IM运行链路。Easel已有OpenClaw/Codex桥接、发布回执和目标调度；这是运行契约重构，不能当作UI移植。
- 不为了界面相似引入完整节点画布、原生终端或全磁盘浏览。我们的终端面板当前明确是只读回执，远程138环境也不能直接沿用桌面“在文件夹中显示”的假设。[A8]
- 不先重做模型设置：我们已有文本/视觉测活、检查时间、自动测活与明确上限。未证明其模型页比我们当前实现更合适，应排在故障定位和任务闭环之后。[A10]
- 不复制原生select和整套侧栏展开策略，继续使用Easel共享选择器与用户约定的初始双栏折叠行为。
- 不把审批请求失败静默置空。EvoFlow `loadApprovals`确有该降级，我们应显示暂不可读并保留已有待处理记录。[E2]

## 复用边界

根LICENSE为 **PolyForm Noncommercial 1.0.0**；README明确商业使用须书面授权。这不是可以按MIT任意整段搬入商用产品的仓库。本轮没有复制其实现、样式或品牌素材到Easel产品中。[E12]

可借鉴通用任务/筛选/预览/验收等交互模式，并用Easel自己的代码、文案与样式实现。实际要复用具体代码时逐文件核对权利来源；如果涉及EvoFlow自研部分的商业使用，先解决其授权。NOTICE列有DeerFlow MIT和ZCode Apache-2.0部分，不能因为存在这些依赖就推定整个React组件目录可按宽松许可证复用。若选用ZCode上游组件，直接回到对应上游文件与版本核对许可和归属义务。[E12]

## 建议实施批次与验收

| 批次 | 可评审交付 | 关键验收条件 |
|---|---|---|
| 第一批 | 失败记录列表/详情、错误编号跳转、复制诊断摘要；核对账号状态在所有入口的投影 | 模拟409与登录失效均能定位；读取失败与无记录分开；旧状态不覆盖新结果；关联及复制遵循字段白名单；平台核验保留授权边界 |
| 第二批 | 跨来源任务只读聚合、状态/来源筛选、回到原对象；计划/验收操作条和修改说明 | 列表及计数来自真实对象；前进后退恢复；刷新不丢输入；待验收不计已完成；跨标签页过期操作受服务端约束 |
| 第三批 | 技能管理状态、多文件标签/原文预览、真实子任务详情 | 作者同slug不混淆；导入与目录就绪分开；关一个面板不影响其它；切会话不串文件/输出；键盘、焦点返回与真正390px分别验收 |
| 后续 | 节点输入/输出契约、局部恢复、版本化创作模板，再考虑画布 | 保留尝试历史和已完成节点；外部副作用有去重/核验；草稿保存不替换已发布模板；无虚构百分比或无证据的续跑 |

这是研究建议，不表示上述改造已完成或已开始实施。本轮纯文档无需改0.3.6版本号；没有功能变化，因此不重复改中英文产品首页。前序修复已推送，138仍按用户指令暂停部署，真实发布闭环另行验收。

## 可复核的源码与官方材料

以下源码均固定到研究提交；Easel代码链接固定到研究时的0.3.6基线。官网链接为可变内容。

- **[E1]** [系统日志页：数据来源、筛选与复制时间线](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/pages/system-logs.js#L59-L80)，[复制与页面入口](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/pages/system-logs.js#L289-L354)。
- **[E2]** [任务状态与URL筛选](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/pages/tasks.js#L50-L224)，[静默刷新](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/pages/tasks.js#L830-L865)，[审批失败置空](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/pages/tasks.js#L2036-L2045)。
- **[E3]** [计划执行确认条](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/react/components/PlanExecConfirmDock.tsx#L248-L335)，[计划详情](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/react/components/PlanDetailView.tsx#L329-L396)，[仓库Plan指南](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/docs/user/guides/chat/plan-mode.md)。
- **[E4]** [任务详情验收、修改、失败操作](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/pages/task-detail.js#L892-L982)。
- **[E5]** [失败步骤重试后端](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/backend/app/gateway/routers/tasks.py#L2404-L2544)，[整任务重启](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/backend/app/gateway/routers/tasks.py#L1744-L1750)。
- **[E6]** [技能市场状态、默认字段、安装后动作](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/pages/skills.js#L632-L748)。
- **[E7]** [Stage标签渲染与保活](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/react/components/RightStagePanel.tsx#L40-L53)，[Store](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/lib/right-stage/right-stage-store.ts)，[文件流默认不抢面板](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/react/hooks/useRightStageChatBridge.ts#L49-L79)，[按标签存浏览器URL](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/react/right-stage/register-kinds.tsx#L41-L58)，[多标签及会话记忆测试源码，未运行](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/tests/right-stage-store-tabs.test.ts)。
- **[E8]** [子任务卡片与实时详情](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/react/components/SubagentLiveDock.tsx#L24-L149)，[Plan依赖图组件](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/react/components/PlanFlowchart.tsx)。
- **[E9]** [工作流草稿、发布、运行入口](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/react/components/app-workflow/WorkflowToolbar.tsx#L247-L285)，[节点输入输出契约](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/react/components/app-workflow/WorkflowNodeInspector.tsx#L463-L515)。
- **[E10]** [Goal与Plan等能力分工](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/docs/user/guides/chat/goal-agent.md)，[仓库任务中心说明](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/docs/user/guides/tasks/task-center.md)。
- **[E11]** [页面局部刷新事件总线](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/evopanel/src/lib/page-live-refresh.js)。
- **[E12]** [LICENSE](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/LICENSE)，[README授权声明](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/README.md#L125-L133)，[NOTICE及第三方范围](https://github.com/EvovexAI/EvoFlow/blob/70722435b7890c828e015d702ffa1697a2534d5a/NOTICE)。
- **[A1]** [Easel失败事件](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/failure_events.py)，[本轮缺陷、验证及运行边界](clawhub-failure-events-2026-10-19.md)。
- **[A2]** [已有持久通知界面](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/components/EventNotificationCenter.tsx)。
- **[A3]** [已有定时任务页](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/components/AutomationPage.tsx)，[目标、运行、计划契约](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/lib/tasks.ts)。
- **[A4]** [运行记录](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/components/ActivityPage.tsx)，[办公室任务焦点](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/components/agent-office/OfficeTaskFocus.tsx)。
- **[A5]** [目标面板已有人工验收/执行控制](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/components/ChatGoalPanel.tsx)，[目标创建/保存/启动](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/hooks/useChatGoalComposer.ts)。
- **[A6]** [发布回执及核验](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/components/PublishReceiptCenter.tsx)，[执行回执与真实完成区分](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/components/ExecutionOperation.tsx)。
- **[A7]** [ClawHub导入及选择](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/components/BrushEntry.tsx#L133-L178)，[技能管理](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/components/SkillPage.tsx)。
- **[A8]** [现有侧面板](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/components/ChatPage.tsx#L179-L232)，[文件/终端/变更面板](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/components/ChatPanelTools.tsx)，[已有产物预览](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/components/ChatArtifacts.tsx)。
- **[A9]** [统一whoami缓存与刷新触发](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/lib/whoami.ts)。
- **[A10]** [已有模型测活](https://github.com/StarrySea1412/Easel/blob/b32ecbcac4b7fc5fb7fb47ddf6a815543e1ce71e/web/frontend/src/components/settings/ModelHealthPanel.tsx)。
- 官方可变页面：[任务中心说明](https://www.evovexai.com/docs/tasks/center/)、[产品演示](https://www.evovexai.com/showcase/)、[执行确认原图](https://www.evovexai.com/media/plan-supervisor/plan-04-exec-confirm-dock.png)、[右侧工作流原图](https://www.evovexai.com/media/plan-supervisor/plan-05-supervisor-workflow-panel.png)。官方素材仅作研究观察，未复制进产品。
