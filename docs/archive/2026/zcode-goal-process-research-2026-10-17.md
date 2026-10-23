# ZCode 目标与"进程"实现对照（本机 3.15.3）

日期：2026-10-17。对应用户要求“调用技能查查看，zcode 的目标和进程是怎么实现的”。**只读解析**本机 ZCode 桌面应用（`@zcode/desktop 3.15.3`）的 `resources/app.asar`，未运行 ZCode 目标、未修改其任何文件；抽取产物保存在忽略目录 `outputs/zcode-research-2026-10-17/`（不提交，含 `out/host/index.js` 1.68MB、`out/host/chunk-OUCOFHX4.js` 823KB、`out/scheduler/index.js` 1.04MB、renderer `IntlProvider-*.js` 855KB）。协议语义另对照上一轮已实际读取的 ZCode 官方文档与固定提交源码（见[定时任务与目标方案](schedules-goals-research-2026-10-16.md)）。

## 目标的实现（本机证据）

| 层次 | 实现 | 证据（抽取文件内符号） |
| --- | --- | --- |
| 协议 | `session/goal` 请求：`{sessionId, inputId, action, objective, expectedRevision}`，返回会话快照 | host bundle：`"开始请求 ZCode Protocol session/goal"`、`G.request(_e.sessionGoal,{sessionId,inputId,action,objective,expectedRevision})` |
| 晚到屏障 | 操作携带 `expectedRevision`，服务端按 revision 校验 | 同上请求字段 |
| 状态投影 | 会话投影携带 `target`（目标）；消息级 `maxGoalIteration`（轮次上限）；快照携带 `goalStats`（计量）、`goalVerifications`、`goalVerificationTimeline`（独立验收轨迹） | host bundle：`E0(y.messages,{maxGoalIteration, target:y.projection.target})`、`goalStats:Dse(y.goalStats),goalVerifications:...,goalVerificationTimeline:...` |
| 任务归属 | 桌面端经 `zcode-task-service.goalSession → zcodeAgentService.goalSession` 执行；日志含 `mayStartContinuation`（是否允许续跑） | host bundle 日志 `[zcode-task-service] goalSession start` |
| 生命周期 | 查看/设置/暂停/恢复/清除（官方命令面：`/goal`、`/goal pause|resume|clear`） | 上一轮官方源码（固定提交）与本轮 `action` 字段 |

**与 Easel 对照**：Easel 已有等价机制——`goalRevision/stopEpoch/owner` 的停止与晚到结果屏障、`iterations/activeSeconds/toolsUsed/imagesUsed` 计量、`checks` 验收与 `runs` 时间线、空闲安全边界续跑。差异：ZCode 把"验收时间线"和"待办（todos）"作为快照的独立层；Easel 的验收在 `goal.checks`、步骤在 `goal.steps` 内，由事件流串起。

## "进程"的实现（= 聊天状态面板的待办）

| 层次 | 实现 | 证据 |
| --- | --- | --- |
| UI 名称 | 状态面板的待办列表就叫"进程"（`chat.statusPanel.todo: '进程'`，含"收起 N 项已完成"） | renderer `IntlProvider` 文案 |
| 数据来源 | 模型工具 `TodoWrite`（内置 Explore 子代理的工具清单含它），todos 进入会话状态 | host bundle：`tools:[...,"TodoWrite"]` |
| 投影 | `sessionTodosToPlanSteps`：todos → 计划步骤（`todo-<n>`、`status`、`title: content`）；`sessionTodoGroupsToRuntime` 支持分组待办（`startedAt/updatedAt` + 嵌套 todos） | host bundle 函数名与实现片段 |
| 位置 | 与目标并列出现在会话状态/进度面板；普通对话同样可以有待办 | 快照字段 `todos/todoGroups` 与 `goalStats` 并列 |

**与 Easel 对照**：Easel 的等价物是 `easel_goal_update` 步骤工具 + 对话右栏"目标进展"（勾选/阻塞/说明）。差异：ZCode 的"进程"**独立于目标**（普通对话也可有 todo 面板），Easel 的步骤只存在于目标运行中。

## 本轮据此对 Easel 的对齐动作

1. **目标归于对话、对齐 Codex 的极简**：输入框里的内容直接作为目标（`/goal`、`/目标`、`/`菜单或目标按钮），去掉"可衡量结果/执行选项（轮次/秒数/工具/生图）"设置；完成标准默认=交付证据 + 用户确认；执行上限沿用默认（5轮/1200秒/40工具/0图，保留在记录中）。显式模型确认、停止屏障、预算语义不动。
2. **"定时任务"页只留定时计划**：移除"对话目标"列表与该页的目标创建分支；目标完全在对话里管理。
3. **不照搬项（列为可选后续）**：独立于目标的 TodoWrite 式"进程"面板（Easel 普通对话暂无待办工具）、`goalVerificationTimeline` 的独立验收轨迹（Easel 目前记录在 checks/事件中）。两者都需要后端契约变化，另立任务。

## 边界

- 本机解析仅覆盖 `app.asar` 中与目标/待办相关的 bundle；压缩产物内的局部变量名不逐一复原，结论以符号与字符串证据为准。
- 未做竞品实测（未实际运行 ZCode 目标/待办），官网与源码证据的有效范围以标注的版本/提交为准。
