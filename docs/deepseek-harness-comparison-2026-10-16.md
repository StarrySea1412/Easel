# DeepSeek Harness 与 Easel 对照调研（2026-10-16）

## 结论

DeepSeek Harness（DSH）和 Easel 在产品层面相似：都把模型、工具、技能、会话、后台任务、子 Agent 和 Web/桌面界面放在一个本地工作台里。它们都需要处理长任务、流式输出、停止、重连、上下文、模型选择和外部能力的安全边界。

两者的运行时内核并不相同。DSH 是 DeepSeek 自己的 TypeScript/Node Harness，建立在 Cordis 上，采用“Everything is a Plugin”：模型适配器、工具注册、Agent loop、会话日志、技能、后台任务和界面都是插件服务。Easel 是 Python/FastAPI + React 工作台，执行主路径交给 OpenClaw Gateway；Web supervisor、共享 raw stream、OpenClaw SQLite 和本地文件标记各自保存一部分事实。

因此，DSH **值得作为可靠性设计参考，但不是可直接替换的同类内核**。当前最有价值的借鉴不是把 Cordis 整套搬进 Easel，而是把一次对话执行建立成可恢复、可审计的事件账本，让 Web 连接丢失不再等同于任务状态丢失。

## 证据范围

- 官方仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，调查时 `master` 为 `86a402200d95fecef4529d969836f1fe13c6cb0d`（2026-10-16）。
- 官方入口文档：[README](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/README.md)、[Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/docs/architecture.md)、[AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/AGENTS.md)。官方 README 明确称其为 developer preview，兼容性会破坏性变化；本报告不把它当作稳定协议。
- 重点对照：[Session Persistence](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/docs/subsystems/persistence.md)、[Core/Agent loop](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/docs/subsystems/core.md)、[Jobs](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/docs/subsystems/jobs.md)、[Subagents](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/docs/subsystems/subagent.md)、[Skills](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/docs/subsystems/skills.md)、[Conversation](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/docs/subsystems/conversation.md) 和 [Compaction](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/docs/subsystems/compaction.md)。
- Easel 证据来自本分支源码和已有记录：[`web/app.py`](../web/app.py)、[`web/chat_recovery.py`](../web/chat_recovery.py)、[`web/agent_office.py`](../web/agent_office.py)、[`web/context_usage.py`](../web/context_usage.py)、[`docs/agent-runtime-safety-2026-10-16.md`](agent-runtime-safety-2026-10-16.md)、[`docs/agent-office-2026-09-30.md`](agent-office-2026-09-30.md) 及本轮 `chat_supervisor_lost` 取证。没有安装 DSH、没有调用模型、没有安装外部插件。

## 逐项对照

| 主题 | DeepSeek Harness | Easel 当前实现 | 判断 |
| --- | --- | --- | --- |
| 运行时组合 | Cordis 上的插件树；profile 由有序 bundle、patch 和可选外部插件组成，模型、工具、会话和 Agent loop 都是可替换服务。 | FastAPI/React 负责工作台，OpenClaw Gateway 负责 Agent 执行；本项目安全插件通过 OpenClaw 配置加载。 | 产品目标相似，内核组合方式不同。 |
| 会话事实 | append-only `SessionEvent` 是上下文和恢复的唯一来源；模型可见事实必须先记录，`deriveMessages()` 从日志重建请求。 | Web turn JSON、job JSONL、共享 raw stream、OpenClaw SQLite 和 skill audit 分开保存；Web marker 不是运行器唯一事实源。 | 这是最大差异，也是当前故障的根因方向。 |
| Turn/Step | DSH 明确区分 turn（连续输入生命周期）和 step（一次模型请求及其工具调用），并记录 `turn/start`、`step/start/end`、`turn/end`。 | Easel 以 `turnId`、`gateway_run_id`、SSE/job 事件和 OpenClaw 事件拼接一次执行，未形成统一的 durable turn/step 事件模型。 | DSH 的边界更适合恢复和审计。 |
| 流式与重连 | Web follow 以序号、baseline 和 gap repair 恢复；只有物理 carrier loss 选择自动续接，业务/持久化错误会明确终止。 | 浏览器订阅 `/api/chat/jobs/{turn}/stream`，后端 tail 单个共享 raw JSONL；原 Web supervisor 丢失后由 `stop_orphan` 收尾，恢复 run 的新 ID 不会自动并入旧 turn。 | 我们当前的 `chat_supervisor_lost` 正是这一层缺口。 |
| 停止/取消 | `Agent.cancel(cause)` 携带稳定原因和 `AbortSignal`；取消会清理 inbox，持久化 `turn/end` 的 aborted reason，并等待 Agent quiescence。 | `/api/chat/stop` 或 `chat.abort` 针对网关 run；跨进程锁防止同会话并发。旧 Web 监督丢失时只能按保存的旧 `gateway_run_id` 对账。 | Easel 有控制入口，但缺统一取消因果链。 |
| 后台任务 | `ctx.jobs` 是 owner-fenced registry；任务有 registered/settled 事件、输出 ring、进度、取消原因和资源释放语义，完成通知回到所属 Session。 | `_BG_TASKS`、`_CHAT_JOBS` 和 skill audit 是 Web 进程内存/文件层面的任务集合；通知已持久化，但不是所有后台任务的统一 registry。 | DSH 的 job 语义更完整，尤其是“已结束”与“资源已释放”的区分。 |
| 子 Agent | `ctx.subagents` 是 provider seam；支持本进程 child、fork/continuable child，以及 ACP、Codex、Claude Code、另一个 DSH 等外部 provider，子会话有持久身份。 | 实际委派由 OpenClaw `sessions_spawn` 完成；Easel Agent Office 只读取当前会话中的结构化创建/回执证据，不负责创建执行。 | 都支持多 Agent，但 DSH 把子 Agent 作为正式运行时能力，Easel 目前主要是 OpenClaw 适配和观测。 |
| 技能 | 分层 `ctx.skills` registry；先列摘要，按需 `get()` 加载正文，按 cwd、scope 和 provider 合并，支持变化失效。 | 本地 `SKILL.md` 目录扫描/选择后，把技能说明拼入请求；ClawHub 目前只读检索和详情，不自动安装/执行。 | “目录与正文分离、按需加载”可直接借鉴；ClawHub 安全边界应保留。 |
| 模型与上下文 | `ctx.llm` 是模型适配 seam；provider/model、reasoning、`maxTokens` 显式进入请求；上下文压缩是可选且可记录的 capability。 | OpenClaw provider/relay 执行实际请求；上下文面板综合运行时报告、会话快照和模型参考，分类 Token 仍是字符估算，未接入供应商精确分词。 | DSH 证明应把模型路由、输出上限、压缩和请求事件绑定到同一会话记录；不证明任何渠道额度。 |
| 压缩 | `compaction/start/summary/end` 是持久事件，摘要替换范围、Token 估算、provider/model 和失败阶段都可恢复。 | 有上下文统计和部分报告处理，但没有同等的 durable compaction transaction。 | 这是长任务稳定性和“20万上下文”解释的可借鉴方向。 |
| 对话 UI | Conversation assembler 根据事件 `(kind,id)` 建立节点，Chat/Trajectory 是不同 view；同一事件可在不同目标重放。 | 拆解报告、普通对话和 Agent Office 由不同页面/适配器拼接；报告已并入最近对话，但执行进度不是统一事件节点。 | DSH 的事件到 UI 节点模型更适合把报告、进度和工具记录放进同一对话。 |
| 插件市场 | plugin manager 可查看、安装、移除和启用 bundle，有版本/兼容性/审批/HMR 语义；安装的 Host 代码会进程内执行。 | ClawHub 仅公开只读检索、作者/版本/详情；外部结果不能直接选入、安装或执行。 | DSH 的市场能力更大，也带来更高供应链风险；不能直接照搬。 |
| 错误模型 | typed errors、明确 ownership/containment，未知状态不伪造；会话和任务的未结尾状态保留为 incomplete。 | 已有结构化错误码、`unknown` Agent 状态和“不自动重试”规则；但 `chat_supervisor_lost` 文案是固定 Web 收尾模板，不是供应商原始错误，且不知道 OpenClaw 自动恢复 run。 | Easel 应先修复错误来源和 run 关联，再谈自动恢复。 |

## 对当前 `chat_supervisor_lost` 的直接启发

本次调查的重点不是让 DSH 替换 OpenClaw，而是看它如何避免“连接状态”和“执行状态”混成一个状态。DSH 的做法可压缩成四条：

1. **每次请求有 durable attempt/step 身份。** 流断开只影响观察者；只要模型请求已提交，尝试及其最终结局要能从 Session log 重建。
2. **恢复是同一逻辑 Session 的新 activation，而不是无关联重发。** 新 run 必须记录 `recoveryOf`/attempt 关系、开始原因和是否已产生模型请求；UI 订阅的是 Session 事件，不是某一个浏览器连接。
3. **完成、失败、取消、资源释放分开。** 一个 producer 返回结果，不等于它的子进程、工具或后台任务都已释放；未收到 `settled` 就保持 incomplete。
4. **客户端只接受有序、可对账的事件。** baseline、序号和 gap repair 可以恢复页面；发现业务或持久化错误时明确报错，不把迟到事件拼到另一轮。

对 Easel 来说，最小可行改造应先在现有 OpenClaw 外加一个项目级 run ledger：保存逻辑 `turnId`、每个 provider run、父/恢复关系、首次提交时间、首字时间、最后事件序号、终态、取消原因、原始错误来源和 `resourceSettled`。这样即使 Web 重启，后台恢复任务也能回填同一个对话，而不是让 `stop_orphan` 只看到旧 `gateway_run_id`。这项建议尚未实现，本报告不把它描述成已完成。

## 建议采用的优先级

### P0：先解决可靠性

- 让一次逻辑对话轮拥有独立的持久 run ledger；旧 run、恢复 run、手动重试必须一一可见。
- 将 `turn/start`、`step/start`、模型请求提交、工具调用、`assistant` 收尾、`turn/end` 和 `settled` 变成可回放的最小事件集。
- 停止操作返回“请求已发出／网关已确认／仍未确认”三种事实；不要用浏览器连接关闭推断模型已停止。
- 对 `chat_supervisor_lost` 改为显示实际来源：Web supervisor 丢失、Gateway run 状态、是否存在恢复 run、恢复 run 的终态；未知字段保持未知。

### P1：借鉴 DSH 的能力 seam

- 抽象 LLM、技能、子 Agent、后台 job 和上下文压缩的接口，让 OpenClaw 仍是默认 provider，但以后可以接 Codex/其他 provider。
- 将技能目录和技能正文分开；目录用于选择和上下文计数，正文只在选中/需要时加载，保留 ClawHub 外部结果的未验证标识。
- 为后台任务增加 owner、进度、输出游标、取消原因、settled 回执和完成通知；Agent Office 直接读这些事实。
- 把报告、进度、工具调用和错误做成同一对话内的稳定事件节点，继续保留独立材料入口作为入口视图。

### P2：再评估产品级插件化

- 只有当上述事件/权限/回滚语义稳定后，才评估 bundle/profile 或外部插件安装。
- 外部插件需要版本兼容检查、权限审批、失败回滚和重启边界；不能因为 DSH 有 plugin manager 就把 ClawHub 结果变成可执行代码。
- Cordis 是 TypeScript/Node 的运行时范式，Easel 当前 Python/OpenClaw 架构没有必要直接移植；应先抽取行为契约和事件语义。

## 不应直接照搬的部分

- DSH 当前是 developer preview，公开 API 和 Session 格式仍会破坏性变化；不能把它的包名、配置字段或事件名当作稳定标准。
- DSH 的插件安装会让 Host 代码在进程内执行，风险远高于当前 Easel 的 ClawHub 只读检索；必须先有隔离和审批。
- DSH 的自动续接只覆盖物理 carrier loss，业务、持久化或连续性错误会终止；它不等于任何断线都自动重发模型请求。
- DSH 的 Token meter 是估算/计量能力，不是供应商账单；同样不能用 Easel 的 `cost=0` 推断免费。
- DSH 的 UI/Session controller 依赖 Node、Cordis 和其自己的 Remote protocol；直接复刻到现有 FastAPI/SSE 会增加两套状态机。

## 调研结论边界

本轮只读了官方仓库固定提交的 README、架构和子系统文档，以及 Easel 当前源码/既有调查记录；没有运行 DSH、没有验证真实 DeepSeek API、没有比较速度或费用、没有安装任何插件，也没有修改运行逻辑。官方仓库后续 master 变化时，应以本报告记录的提交 SHA 重新核对。
