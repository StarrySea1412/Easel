# Orca 同名项目调研与 Easel 可借鉴机制

- 调研日期：2026-10-08。
- 方法：GitHub 仓库搜索 API、GitHub Raw HTTP 读取及内存读取源码压缩包；搜索 API 后续出现限流，改用公开原始文件。
- 核查边界：读取公开 README、许可证和下列指定源码；未安装或运行这些项目，未调用 LinkedIn 或真实模型服务，未做浏览器交互验收。来源链接指向调研时的 `main`，后续可能变化。
- 用户未提供作者或链接，因此不能认定某一个同名仓库就是用户所指。以下按与 Easel 的相关性分别评估。

## 1. 候选与结论

| 项目 | 已核实定位 | 与 Easel 的关系 | 许可证 |
|---|---|---|---|
| [DimiMikadze/orca](https://github.com/DimiMikadze/orca) | LinkedIn 画像深度分析；固定采集后由 Agent 按目标分析，必要时补采 | 对账号内容分析最直接：目标定义、按问题补料、结构化报告 | [MIT，Dimi Mikadze](https://github.com/DimiMikadze/orca/blob/main/LICENSE) |
| [stablyai/orca](https://github.com/stablyai/orca) | 并行编程 Agent 工作台；独立 Git worktree、进度与产出管理 | 对 Agent 办公室的任务生命周期、隔离及可追踪产出有参考价值；不提供国内平台运营方法论 | [MIT，Lovecast Inc.](https://github.com/stablyai/orca/blob/main/LICENSE) |
| [Continuum-AI-Corp/OrcaReplay](https://github.com/Continuum-AI-Corp/OrcaReplay) | Agent 运行录制、回放、分叉和模型比较 | 对分析复现与模型评估有参考价值；不是账号分析引擎 | [Apache-2.0 代码](https://github.com/Continuum-AI-Corp/OrcaReplay/blob/main/LICENSE)；README 标注 trace 规范为 CC BY 4.0 |

本轮建议借鉴设计并在 Easel 现有 Python/React 结构中实现，不新增上述项目作为运行依赖，不引入其采集服务，也不直接复制代码。

## 2. LinkedIn Orca：最值得迁移的是“问题驱动分析”

读取依据：[README](https://github.com/DimiMikadze/orca/blob/main/README.md)、[types.ts](https://github.com/DimiMikadze/orca/blob/main/orca-ai/types.ts)、[orchestrator.ts](https://github.com/DimiMikadze/orca/blob/main/orca-ai/orchestrator.ts)、[collect-linkedin-data.ts](https://github.com/DimiMikadze/orca/blob/main/orca-ai/services/collect-linkedin-data.ts)、[analysis-agent.ts](https://github.com/DimiMikadze/orca/blob/main/orca-ai/analysis-agent.ts)、[package.json](https://github.com/DimiMikadze/orca/blob/main/package.json)。

### 已核实的机制

1. `InsightDefinition` 用 `name` 与 `description` 定义用户想知道什么，而不是只有一条固定“分析账号”指令。
2. `collectLinkedInData()` 不依赖模型，先并行读取资料、作品、评论活动和互动活动，再挑选互动较高作品补充评论与反应。
3. `runAnalysis()` 将材料整理后交给分析 Agent；工具允许按需要读取某篇评论、反应或更多活动，并缓存已读取的作品互动。
4. `outputSchema` 将结果约束为分类洞察；`onProgress` 及 `AnalysisStats` 提供采集/分析耗时、工具调用数和进度消息。
5. 库与 Web 界面分离。README 说明测试可以使用固定样本或真实数据；本轮没有执行其测试。

### Easel 应如何吸收

| Orca 机制 | Easel 的适配方式 | 与 10 月 6 日计划的关系 |
|---|---|---|
| 先定义洞察目标 | 给每个平台配置明确的问题与材料要求；把平台上下文显式传入 AI | 补足原计划对平台差异描述不足的部分 |
| 固定基础采集与推理解耦 | 继续使用现有账号快照、作品材料和确定性指标 | 与现有四层架构一致，无需更换后端 |
| 材料不足时补采 | 先生成可解释的缺口清单，说明缺什么、能验证哪个问题；后续再接有预算的补采任务 | 对应 Phase 2 评论、逐字稿补料 |
| 同一批作品共同分析 | 同平台、同账号、可比周期内进行跨作品解读，每条观察关联具体原文 | 对应 Phase 2 跨作品 AI 解读 |
| 进度与统计 | 记录采集/分析阶段、失败原因、材料范围和产出，支撑办公室任务状态 | 对应 Phase 3 Agent 周报，但不等于周报已实现 |

平台差异应体现为问题与证据的差异。例如，小红书检查是否能满足明确检索与保存需求；B站检查标题承诺与逐字稿段落是否呼应；知乎检查是否回答原问题并提供论据；公众号检查正文服务对象和转发场景；短视频检查开场价值是否清楚。没有真实留存曲线时，不能把逐字稿观察写成“观众在这里流失”；没有图片时，不能声称检查了实际封面视觉。

### 不应照搬的部分

- **预算需要程序硬约束。** 所读 `analysis-agent.ts` 将 `maxToolCalls` 写进提示词，并在工具内递增 `toolCallCount`，但没有看到执行前的次数上限拦截；`maxPages` 也只是 `z.number()`。Easel 后续补采必须限制调用数、页数、超时与账号范围，不能仅依靠模型遵守文字要求。
- **保留 Easel 更严格的证据校验。** Orca 要求模型引用已有 URL，但其输出 schema 只是字符串，没有看到对 URL 或逐字原文的机械匹配。Easel 已有 `evidenceId + quote` 匹配、无依据结果拒收及数字/因果断言过滤，不应为迁移而降低要求。
- **不能只看高互动作品。** Orca 基础采集按反应数挑高互动作品深挖，适合其场景但会偏向成功样本。Easel 跨作品分析需说明样本范围，并关注普通作品、材料缺失与周期差异。
- **不移植 LinkedIn 画像维度。** 销售、招聘、投资的画像问题不能直接当作创作者账号诊断；应集中分析作品、受众公开反馈和可验证实验，不从少量文字推断人的心理或身份属性。
- **不依赖“接入就更聪明”。** 该实现使用 Next.js、LangChain、ChatOpenAI 和 RapidAPI LinkedIn 数据服务；这些依赖不提供国内七个平台的指标口径与运营证据。

## 3. stablyai/orca：让办公室成为可管理的协作系统

用户进一步强调了该项目对多 Agent 办公室的价值，因此本节从 README 扩展到实际编排源码。树查询取得的参考提交为 `b0fbcfd6a7e919743856dcd96198897baa92593e`；下面源码读取发生于同次调研，链接保留文件路径方便持续跟踪。仍未运行 Orca 或实测其完整端到端行为。

### 3.1 已读源码显示的核心设计

| 机制 | 源码证据 | 对 Easel 的启示 |
|---|---|---|
| 任务与执行尝试分离 | [lifecycle-transition.ts](https://github.com/stablyai/orca/blob/main/src/main/runtime/orchestration/db/lifecycle-transition.ts) 对 `task / dispatch / worker` 分别定义合法状态转换，事务写入并校验前置状态；worker 包含 `start_unknown / stop_unknown` | 一个任务可以有多次尝试；没收到停止回执不能直接显示已停止；任务失败、进程结束、交付通过应是不同事实 |
| 结果有精确归属 | [worker-report-settlement.ts](https://github.com/stablyai/orca/blob/main/src/main/runtime/orchestration/db/dispatch-context/worker-report-settlement.ts) 检查 task/dispatch 匹配、当前执行尝试、冲突中的其他 worker，并处理重复报告 | 旧 Agent 的迟到结果不能覆盖新一轮任务；重复回执要幂等；结果应与尝试 ID 绑定 |
| 人工等待是结构化事实 | [orchestration-fleet-attention.ts](https://github.com/stablyai/orca/blob/main/src/shared/orchestration-fleet-attention.ts) 区分 guidance、input、approval、failure、interruption、stale、unverifiable、root_completion | “等待”不能混为一类；用户应知道需要答问题、检查失败，还是只需等另一个成员 |
| 问答线程与运行绑定 | [question-threads.ts](https://github.com/stablyai/orca/blob/main/src/main/runtime/orchestration/db/questions/question-threads.ts) 检查 run/dispatch 活跃性；相同回答幂等，不同重复回答冲突；dispatch 停用时关闭未答问题 | 可将真正的待答问题放进办公室处理，而不是从自然语言猜测需要批准；旧任务的问题不能继续操控新任务 |
| 主 Agent 结束不代表团队结束 | [structured-agent-session-agent-status.ts](https://github.com/stablyai/orca/blob/main/src/shared/structured-agent-session-agent-status.ts) 合并子任务存活信息；[main-agent-status.ts](https://github.com/stablyai/orca/blob/main/src/shared/main-agent-status.ts) 单独保留主 Agent 自身状态、结果与停止中标识 | 办公室总状态应考虑仍在执行的子任务，不要因为主对话返回就报告整个项目完成 |
| 观测身份与时效独立 | [orchestration-fleet-agent-status-evidence.ts](https://github.com/stablyai/orca/blob/main/src/shared/orchestration-fleet-agent-status-evidence.ts)、[orchestration-fleet-status-index.ts](https://github.com/stablyai/orca/blob/main/src/shared/orchestration-fleet-status-index.ts) 区分观测时间和投递时间，以 dispatch、terminal、进程实例匹配并拒绝错误归属 | 断线后收到旧事件不能让旧任务“复活”；未知身份与状态过期要明确呈现 |
| 过程输出说明覆盖范围 | [orchestration-worker-output.ts](https://github.com/stablyai/orca/blob/main/src/shared/orchestration-worker-output.ts) 返回 dispatch、sourceIdentity、cursor、sourceExact、contentComplete、clipping、fallbackReason 与 archived | 过程预览不能让用户误以为看到了完整记录；回退为终端、截断、归档读取都应有说明 |
| 隔离资源可追踪 | [worker-worktree-creation.ts](https://github.com/stablyai/orca/blob/main/src/main/runtime/rpc/methods/orchestration/worker/worker-worktree-creation.ts) 记录工作区创建阶段、setup 回执、工作区/终端 effects 与 residualResources；[ownership.ts](https://github.com/stablyai/orca/blob/main/src/shared/worktree/ownership.ts) 用元数据区分托管、外部和临时工作区 | 借鉴资源归属与清理账本；内容任务改用独立输入快照、输出目录与产物清单，无需照搬代码 worktree |

这里最有价值的是协作的事实模型和处理入口，不是简单再加一组角色动画。它可以帮助 Easel 回答：“谁在做哪件事、卡在哪里、交出了什么、是否需要我处理、这次结果属于哪轮任务？”

### 3.2 与 Easel 当前实现的具体对照

核查文件：[agent_office.py](../web/agent_office.py)、[office_controls.py](../web/office_controls.py)、[office_outputs.py](../web/office_outputs.py)、[agentOffice.ts](../web/frontend/src/lib/agentOffice.ts)、[officeWorkflow.ts](../web/frontend/src/lib/officeWorkflow.ts)、[OfficeWorkflowPanel.tsx](../web/frontend/src/components/agent-office/OfficeWorkflowPanel.tsx)。

| 能力 | Easel 已有基础 | 最有价值的缺口 |
|---|---|---|
| 身份与状态 | 只接受结构化 Agent 身份和工具回执；区分 live/demo；未知状态不推测完成 | 主要是当前会话观测，还不是持久化的任务/尝试账本 |
| 控制 | 精确匹配当前会话、轮次、run；停止以网关匹配回执为准；独立模型配置只作用于后续调用 | 缺少统一待处理摘要与任务级恢复流程；不应削弱已有精确控制保护 |
| 协作关系 | live 关系来自显式 `parentId`；演示模式才构造研究→设计/文案→审阅的交接 | 真实依赖、输入交付、消费回执尚未形成工作流契约，不能把父子关系显示成“材料已送达” |
| 等待与关注 | `waiting` 通用状态；工作流已有 active/waiting/attention/finished 分栏 | 等待协作、待用户输入、审批、失败、观测不足没有独立、可操作的原因模型 |
| 产出 | 可扫描并预览工作区近期公开文件；有扫描上限与安全过滤 | `office_outputs.py` 明确无法证明文件属于当前会话或某 Agent；应新增可信运行产物清单，不能按文件时间猜作者 |
| 过程记录 | 调用/返回事件、过程面板已有入口 | 可继续增强覆盖范围、已读/待处理状态、精确任务产物关联 |

### 3.3 可立即实现的一项：办公室待处理摘要

优先在现有工作流面板加入“需要查看”的事实摘要和定位按钮，使用已有状态/证据，不需要先引入新的调度引擎：

- `error`：明确显示“报告失败”，定位对应 Agent 过程；`stopped`：显示“已停止”，不自动重启。
- `unknown`：显示“执行状态尚未确认”，定位状态证据；不当作失败或成功。
- `waiting`：作为“等待协作/原因未细分”单独呈现，不自动标记“需要用户批准”。
- 当前快照过期时注明这是上次观测，避免显示成实时结果；计数只包含当前模式、当前成员。
- 点击项进入已有过程面板，控制继续复用 `office_controls.py` 的精确回执逻辑；不自动发送消息、创建 Agent 或恢复任务。

验收重点：live/demo 不串数据；状态未知不算失败；等待不等于审批；已停止不算完成；点击定位正确 Agent；切换会话清除旧列表；真实浏览器验证入口。该项改善“我现在该看哪里”，本节提出建议时尚未实现，最终实现状态以交付更新记录为准。

之后再分三项推进：持久化 `taskId + attemptId + runId` 与任务依赖；结构化待答问题/回答回执；有可信来源的产物清单与交接回执。内容分析场景继续带上 `platform + accountId`，把账号材料限定在授权任务内。独立内容输出目录比每篇作品的 Git worktree 更贴切。

## 4. OrcaReplay：借鉴可复现，不立即引入代理

依据：[README](https://github.com/Continuum-AI-Corp/OrcaReplay/blob/main/README.md)。其设计在模型请求代理、工具/进程事件与文件快照层记录运行，并支持从记录重放或切换模型继续。README 同时明确：回放会真实执行工具，模型代理不转发请求并不意味着所有外部工具网络都被阻断，回放不是沙箱。

对 Easel 更轻量的落点是记录一次分析使用的材料版本、平台规则版本、模型、时间、校验结果及失败原因；在脱敏固定样本上比较两版提示词，而不是反复采集真实账号。这样才能判断“平台提示词优化”究竟提高了引用有效率、针对性与可行动性。

本轮不安装录制代理、不改变用户现有模型地址、不上传账号材料；上述记录与回归评估仍是后续建议，并非已实现功能。

## 5. 对深度化计划的调整建议

[content-analysis-deepening-plan-2026-10-06.md](content-analysis-deepening-plan-2026-10-06.md) 有用：它正确区分数据采集、规则、统计与 AI，也列出了缺模型配置、缺真实材料和跨篇分析能力不足的问题。其 10 月 6 日环境结论属于历史记录，不能替代当前验收。

建议近期顺序：

1. 增加平台分析目标、材料缺口说明，并将平台上下文传入现有单篇解释；先建立针对性的基础。
2. 在同平台/账号隔离、原文引用校验和明确样本范围下实现跨作品解读。
3. 补齐评论/逐字稿的真实输入链路，再做有硬预算的按需补料。
4. 让解释生成可执行实验，记录回收证据，再汇总成周报与办公室任务产出。

判断提升不能只看模型输出是否更长：应检查建议是否引用正确材料、不同平台的问题是否有差异、缺材料时是否承认不足、是否跨账号混入数据，以及实验是否能由用户执行和回收。真实模型、真实账号端到端效果需另行验证。

## 6. 归属与复用

本文件为基于公开源码和文档的评估，不含第三方实现代码。以后如复制或改写实质性代码，应保留各项目的许可证及版权声明；OrcaReplay 的代码许可和 trace 规范许可应分别处理。当前建议不改变 Easel 的上游来源、许可证与第三方归属。
