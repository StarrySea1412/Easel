# Agent loop 与长对话可靠性调查（2026-10-16）

## 结论

Easel 当前不是“完全不能多轮”，而是把两件事混在了一起：

1. OpenClaw 内部的 Agent loop 能在同一个会话上继续接收用户输入、调用工具、再次请求模型并写入会话历史。
2. Easel 的 Web supervisor 负责把一次运行转成浏览器 SSE，但它的任务所有权和部分状态仍在 Web 进程内存中；Web 重启、Gateway 重启或观察连接丢失时，执行状态、恢复状态和界面状态不能稳定对账。

所以当前的能力边界是：**正常运行可连续多轮；普通浏览器断线通常可回放；跨 Web/Gateway 重启的长任务不能保证无损恢复，也不能安全自动重发。** 这解释了 `chat_supervisor_lost`，它是 Easel 的外层收尾标记，不是“OpenClaw 不支持长对话”的证据。

## 取证范围

- 只读检查本地源码、OpenClaw SQLite、`data/gateway.log`、已有 turn/job 文件和定向测试。
- 没有重发任务、没有调用付费模型、没有重启服务、没有安装外部插件，也没有部署 138。
- 代码版本边界以当前工作树为准；运行时日志是本机历史记录，不能代替一次新的真实模型验收。

## 正常多轮路径

`web/app.py::api_chat_stream` 对每个浏览器会话使用稳定的 `sessionId`，派生固定的 `agent:main:{sessionId}`，并用确定性的 UUID 作为 OpenClaw `sessionId`。后续轮次继续使用同一对身份；当前轮才使用新的 `turnId` 作为幂等键。Native Gateway 与 HTTP 兼容路径都携带会话身份。

同一会话有进程内 `_session_lock` 和跨进程 `_CrossProcLock`，下一轮会排在上一轮之后，避免两个运行同时写同一份 transcript。客户端的 `resumePendingTurn` 会按 `turnId` 回放 job JSONL，普通 SSE 断开不会主动杀掉后台 supervisor。

一次 Agent 运行内部并非一次模型请求就结束。Gateway raw/RPC 事件可以出现模型请求、工具调用、工具结果、后续模型请求和最终 `assistant_message_end`；OpenClaw 也会在上下文压力下编译或压缩上下文。

## 本机连续会话证据

当前 `data/openclaw/agents/main/agent/openclaw-agent.sqlite` 中，`agent:main:main` 对应会话包含：

| 事实 | 观察值 |
| --- | ---: |
| `prompt.submitted` | 31 |
| `model.completed` | 31 |
| 工具调用 / 结果 | 52 / 52 |
| transcript 事件 | 155 |
| `context.compiled` | 31 |

这说明同一 OpenClaw 会话已经实际承载了多轮和多步工具执行。它不能证明所有渠道都拥有相同上下文窗口，也不能证明任何供应商费用或精确 token 数。

## 长任务和失败边界

2026-10-16 的 `data/gateway.log` 同时记录了以下事实：

- Gateway 启动后执行了 `main-session-restart-recovery`，说明运行器有恢复动作；
- 一个长任务 `breakdown-mvafzhlf-1` 经过多次模型/工具活动后以 `stopReason=length` 结束；
- 之前同一任务被诊断为 `stalled_agent_run`，持续报告 repeated model requests without progress；
- settled-turn finalization 失败后保留原始失败，没有被伪装成完整成功。

这暴露出真正需要修复的 loop 边界：模型请求可以继续发起，但没有一个由 Easel 持久保存、可在重启后接管的“逻辑轮次”状态机来判断当前处于哪一步、是否已经结算、是否存在恢复 run，以及何时应停止继续消耗。

## 故障矩阵

| 场景 | 当前行为 | 是否安全 | 说明 |
| --- | --- | --- | --- |
| 同一页面连续发送，上一轮已完成 | 复用同一 OpenClaw session | 基本安全 | 受会话锁保护，属于当前已支持路径 |
| 同一轮浏览器 SSE 断线，Web 进程仍在 | 后台 supervisor 继续，job JSONL/最近结果可回放 | 基本安全 | 观察连接丢失不等于模型请求重发 |
| 页面刷新后恢复 pending turn | 以 `turnId` 重连并回放事件 | 有条件安全 | 依赖 job 文件和 Web 进程中的 `_CHAT_JOBS` 仍存在 |
| Web 进程重启，Gateway run 已完成 | 旧 marker 可被显式 stop 对账；当前默认不会自动把新 run 并回旧 turn | 有限 | 可能只得到 `chat_supervisor_lost` 和已收到片段 |
| Web 进程重启，Gateway run 仍在 | 只能依赖保存的旧 `gateway_run_id` 做显式核实 | 不足 | `_BG_TASKS`/`_CHAT_JOBS` 消失，恢复 run 关系未持久化 |
| Gateway 自动恢复并产生新 run | Gateway 可能继续执行，但 Easel 不知道它是旧 turn 的 `recoveryOf` | 不足 | 自动重发/重复扣费风险，当前不自动接管 |
| 同会话并发发送 | 进程内和跨进程锁排队 | 基本安全 | 代价是等待时间长，停止排队任务有单独路径 |
| 一次运行内工具调用后继续模型 | Native raw/RPC 可观察多步 | 有条件安全 | 需要最终事件；工具和恢复状态尚未统一进 ledger |
| 上下文接近窗口 | OpenClaw 可能 compaction；Easel 展示事件/估算 | 有条件安全 | 无统一持久 compaction transaction，`200000` 不能当真实供应商窗口 |
| `stopReason=length` 或 stalled run | 保存部分输出并提示继续/重试 | 不足 | 没有以逻辑 turn 维度做预算、attempt 和 resource settlement |
| Gateway 版本与状态库不匹配 | 启动失败 | 不安全 | 本机另有日志显示 2026.9.2 仅支持 schema 15，而状态库为 schema 18；应在启动前阻断并给出升级/隔离目录提示 |

## 应怎样支持多轮长对话

### P0：先让一次逻辑轮次可恢复

在现有 OpenClaw 外增加项目级 append-only run ledger。每个 `turnId` 至少记录：

- `sessionId` / `sessionKey` / OpenClaw `sessionId`；
- 一个或多个 provider `runId`；
- `attempt`、`recoveryOf`、`idempotencyKey`；
- accepted、首 token、最后序号、终态和原始错误来源；
- `cancelRequested`、`cancelConfirmed`、`resourceSettled`；
- provider、model、thinking、上下文快照引用和 compaction 事务引用。

浏览器只订阅 ledger 的有序事件。SSE 只是 carrier；carrier 断了，任务仍由 ledger 描述。Gateway 产生新 run 时必须先登记为同一逻辑 turn 的 recovery attempt，不能静默当成新消息再发一次。

### P1：给长任务加明确的执行边界

- 按逻辑 turn 统计模型请求次数、连续无进展时间、工具等待时间和总预算；
- 把 `stopReason=length`、stalled、provider error、用户停止和正常收尾分开；
- 最终回答、失败、取消和资源释放分别写入事件；没有 `resourceSettled` 就保持 incomplete；
- 恢复时先查询 Gateway 的真实 run 状态，再决定继续观察、请求取消还是报告未知，不自动重复付费请求。

### P1：把 compaction 变成可恢复事务

记录 `compaction/start`、摘要来源、替换范围、估算口径、provider/model、`compaction/end` 及失败阶段。上下文面板同时显示供应商/运行时报告、Easel 估算和未知字段；旧会话的 `200000` 只能作为保存的历史预算，不能直接标成渠道容量。

### P2：统一 Agent Office、报告和通知

报告进度、工具调用、模型请求、错误和完成通知都从同一个事件投影读取。这样“最近对话”可以展示原有报告页面，同时不会因为 UI 页面切换或 Web 重启丢掉执行事实。

## 暂不采用的做法

- 不把 SSE 重新连接当作重新发消息；
- 不因为收到部分 thinking/token 就推断任务完成；
- 不用旧 marker 的 `gateway_run_id` 猜测一个未知的恢复 run；
- 不把 OpenClaw 的上下文估算或历史 `200000` 当作供应商窗口；
- 不在没有幂等和结算证据时自动重试，避免重复扣费。

## 验收标准

要把这条链路称为“支持多轮长对话”，至少需要一次不付费的故障注入回归覆盖：

1. 连续三轮同会话，确认 transcript/sessionKey 不变且每轮 `turnId` 独立；
2. 工具调用后继续模型，确认 step 顺序、最终事件和资源释放；
3. SSE 断开但 Web 不重启，确认无重复请求且能完整回放；
4. Web 重启后，确认同一逻辑 turn 能发现旧 run/恢复 run 并显示真实终态；
5. Gateway 重启或版本不匹配，确认阻断错误不会伪装成模型失败；
6. compaction 成功/失败各一次，确认上下文账本和 UI 状态可恢复；
7. 用户停止与自动超时各一次，确认不会释放仍在写入的会话锁，也不会重复提交。

在 P0 ledger 和上述回归完成前，当前产品口径应写成“支持正常连续多轮和有限断线回放；跨服务重启的长任务恢复仍在建设中”。
