# 目标与定时任务对标 Codex：修订与验收

日期：2026-10-17。对应用户授权：“我的目标和定时任务需要对标codex，你给我重新修改”。基线为 `f66a0b5e`；本轮以 OpenAI 官方文档为基准修订既有实现，延续[首版实施](schedules-goals-implementation-2026-10-16.md)与[框架调研](harness-followup-2026-10-17.md)。未调用付费模型、未部署 138、未更新安装包。

## 实际读取的官方来源

| 来源 | 本轮读取内容 |
| --- | --- |
| Codex [Goals cookbook](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) | 线程级持久目标；`/goal`、`/goal pause`、`/goal resume`、`/goal clear`；仅在空闲安全边界续跑；无工具调用的续跑轮抑制下一次自动续跑；完成必须基于证据；预算到限≠完成；用户输入与中断优先 |
| Codex [App Server 文档](https://developers.openai.com/codex/app-server) | `thread/goal/set|get|clear` 持久目标状态（objective、status、tokenBudget、tokensUsed、timeUsedSeconds）；补目标不清空累计、换目标才重置计量；`turn/steer`、`turn/interrupt` 语义 |
| ChatGPT/Codex [Scheduled tasks](https://developers.openai.com/codex/automations)（learn.chatgpt.com） | 独立任务=每次新对话、对话内任务=回到原对话并支持分钟级间隔；Scheduled 收件箱与“需要处理”未读提示；自定义周期含 MONTHLY 示例；建议先手动测试再排期 |
| ChatGPT/Codex [Long-running work](https://developers.openai.com/codex/long-running-work) | `/goal` 目标正文即首个提示与完成标准；进度行暂停/恢复/编辑/清除；目标不扩大权限；并行目标各自上下文 |
| ChatGPT/Codex [Notifications](https://developers.openai.com/codex/notifications) | 工作“需要处理”时才提醒：未读/运行中/等待回复的活动视图 |

来源经官方域名页面在真实浏览器中实际打开并读取正文；页面为当天快照。

## 修订映射（Codex 语义 → Easel 行为）

| Codex 语义 | 本轮 Easel 修订 |
| --- | --- |
| `/goal` 查看；`/goal pause`、`/goal resume`、`/goal clear` 生命周期命令 | `/goal`（无正文）查看当前目标（无目标则进入设置）；`/goal pause|resume|clear` 与中文 `暂停|继续|清除` 在对话内本地执行，命令不发送给模型；`/` 命令菜单按目标状态列出可用命令并支持方向键与 Enter |
| 用户输入优先，中断才暂停目标 | 用户消息不再取消/暂停活跃目标：消息优先处理，目标保持 active，在该轮结束后从原记录继续（`reserve_chat` 只延迟续跑，不再改目标状态）；仅目标轮次运行中暂不能插话（无 turn/steer 通道，保留明确提示）；“停止/中断”本轮 → 目标转为 `paused`，可从当前记录继续 |
| 预算到限：停止实质工作、总结进展与阻塞、给出下一步；达上限≠完成 | 轮次、时长、工具任意上限达到时目标进入 `blocked`/`budget`，并向原对话写入一次确定性收尾消息（目标、用量、进度、阻塞、下一步）；面板显示“已达执行上限”；不写“完成”，重复上限检查不重复写入 |
| 定时任务收件箱：最近运行“需要处理” | 计划卡按最近一次触发结果标记“需要处理”，页面标题汇总为“N 个已启用 · M 个需要处理” |
| 自定义周期（官方 MONTHLY 示例） | 计划新增“每月”规则（每月几号 1–31）：短月自动跳过（31 号不在二月执行）、DST 缺失时刻跳过、三次未来时间预览；后端与前端类型同步 |
| 从对话创建定时任务 | 对话内输入 `/定时 <正文>`（或命令菜单“定时任务”）跳转定时任务页并预填计划表单，明确需补全时间与执行模型后保存为暂停计划 |
| 保留的有意差异 | 不提供默认模型跟随（保持显式冻结）；不做 turn/steer 中途注入；不做 worktree/云并行目标；Token/金额仍不硬封顶（首版边界不变） |

既有能力（证据验收、停止屏障、未知不重发、模型冻结、累计限额、空闲安全边界续跑、无工作工具续跑抑制）保持不变，属于本轮已核对为对齐的部分。

## 实现位置

- `easel/task_store.py`：`reserve_chat` 消息优先语义；`finish` 的 interrupted→paused 分支；`_conclude_budget`/`conclude_budget` 预算收尾（`goal-budget-<id>` 消息幂等）；`claim`/`guard` 上限路径接入收尾。
- `easel/task_rules.py`：`Schedule` 新增 `monthly` 与 `day`；`next_time`/`latest_time` 月度分支（短月跳过、DST 安全）。
- `web/task_service.py`：时长上限路径改走预算收尾。
- 前端：`lib/goalCommand.ts`（命令解析与建议）、`ComposerGoalMenu`（按状态渲染命令项）、`ChatComposer`（命令分发、菜单键盘、发送阻断文案）、`ChatPage`（生命周期动作、查看目标、定时草稿回调）、`ChatGoalPanel`（预算标签、优先级提示、终态优先）、`AutomationPage`（每月、需处理、草稿预填）、`App.tsx`（对话→定时任务草稿路由）、`automation.css`。

## 验收记录

| 层次 | 实际检查 | 结果 |
| --- | --- | --- |
| 后端回归 | 目标/续跑、原生插件 hook、生图队列、模型选择、恢复、run 账本、产物、运行设置组合 | **118 项通过**（含新增：消息优先不取消目标、中断即 paused、预算收尾幂等、工具上限收尾、每月短月/DST/预览） |
| 前端全量 | `npm test` 全量 | **1072 项通过**（新增命令解析、菜单键盘、生命周期动作、面板预算/终态、计划需处理） |
| 构建与静态检查 | TypeScript/Vite 生产构建、lint、`git diff --check` | 构建通过；lint 0 错误、18 条既有 warning；diff check 通过 |
| 隔离浏览器（7896） | 真组件 + 真 TaskService/SQLite + 假执行器，无模型费用 | `/` 菜单四项、`/goal` 查看/`pause|resume|clear`（含中文）、活跃目标下消息准入（真实 `reserve_chat` 返回 admitted）、运行中发送阻断（禁用 + 提示）、中断→已暂停（草稿保留、发送恢复、原对话收到中断说明）、预算会话面板“已达执行上限”与收尾消息、定时页“2 个已启用 · 1 个需要处理”与计划卡“需要处理”、每月规则保存（下一次 2026-11-15 09:00）与预览、`/定时` 草稿预填并切页、390px 深色/浅色无横向溢出 |
| 浏览器实测发现并修复 | 已取消目标在面板仍显示“已达执行上限”（phase 覆盖终态） | 修复为终态优先（已取消/已完成不被 phase 覆盖），补充回归并复验 |
| 本机 7880 | 交付后重建 dist 的只读核对 | 见交付回执；后端语义变更需空闲时正常重启生效 |

隔离验收数据、服务器与截图保存在忽略目录 `outputs/goals-codex-align-2026-10-17/`，不提交个人产出与临时文件。

## 边界与保留项

- 未调用真实付费模型；真实多轮质量、供应商账单与长时间休眠/重启实测保持既有边界。
- 目标轮次运行中不支持插入消息（无 turn/steer 通道），页面明确提示等待或暂停；不做默认模型跟随、worktree/云并行与 Token/金额硬封顶。
- Codex 执行器目标、独立语义/视觉验收、并行提速、完整目标修订/分页、运营指标、138 部署与安装器继续保留为未完成项。
- 本机 7880 的前端新界面在重建 dist 后可见；后端行为变更（消息优先、中断即暂停、预算收尾、每月）需在空闲时正常重启工作台后生效，本轮不强制重启用户进程。
