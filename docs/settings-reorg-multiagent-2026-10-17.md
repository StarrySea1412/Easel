# 设置页整理：主题归位与 multiagent 默认启动（2026-10-17）

## 起因

用户原话：“设置页面，深色模式应该放到更多设置或者是侧边栏，同时multiagent应该默认启动并在模型设置页面啊”。两项归位：①深色模式从独立的“外观”一级设置页移除，落到“更多设置”或侧边栏；②multiagent（即“Agent 协作”，OpenClaw `subagents` + `sessions_spawn` 准入）默认启动，入口移入“模型与渠道”页。

## 勘察结论

- 深色模式当前独占设置页的“外观”导航（`AppearanceSettings`：跟随系统/浅色/深色 + 预览 + 状态行），与“更多设置”同级。
- multiagent 现状：`AgentRuntimeSettings` 独占“Agent 协作”导航；启用语义由 OpenClaw 配置决定——`agents.defaults.subagents.model` 必须是已配置模型且 `tools.deny` 不含 `sessions_spawn`；启动守卫 `_sync_agent_safety_guard` 在无有效启动模型时写入阻断，防止子 Agent 继承主对话的高价模型。本机 `data/openclaw/openclaw.json` 当时 `subagents` 为空、deny 含 `sessions_spawn`，即 multiagent 关闭；主模型可由 `agents.defaults.model.primary` 确定。

## 实施内容

**主题归位**

- `AppearanceSettings` 卡片移入“更多设置”（与演示数据、保存位置、会话备份同列），保留跟随系统/浅色/深色三态、预览与持久化状态行；移除独立“外观”导航，旧的 `appearance` 深链映射到“更多设置”。
- 侧栏底部（事件通知与设置之间）新增一键主题切换：浅色时显示月亮图标与“深色”（点击切深色），深色时显示太阳图标与“浅色”；跟随系统时按当前显示切换并覆盖为显式选择；提示文案注明更多外观选项在设置 → 更多设置；浏览器拒绝持久化时切换仍然生效并如实提示“未能保存到本机”。

**multiagent 默认启动 + 归位**

- 后端：未显式配置过的环境（`agents.defaults.subagents` 键不存在）在下一次后端启动时，由 `_sync_agent_safety_guard` 自动写入 `subagents = {model: <agents.defaults.model.primary>, 默认限额}` 并解除 `sessions_spawn` 阻断，即“默认启动”；用户显式保存过的状态（含显式关闭：`subagents` 已存在且 deny 保留）永不被覆盖；没有可用主模型时保持原有 fail-closed 阻断。
- `_agent_runtime_config` 在“从未配置”时返回 `defaulted`/`suggestedModel`（= 主模型），用于 UI 预选；`enabled` 仍严格按配置文件真实值计算，不在页面上虚报已启用。
- “Agent 协作（Multiagent）”卡片移入“模型与渠道 → 对话通道”（tabbar 下方，随对话通道显示）；移除独立“Agent 协作”导航，旧 `agent-runtime` 深链映射到模型页对话通道；办公室任务入口的引导文案同步改为“设置 → 模型与渠道中启用 Agent 协作”。
- 前端默认呈现：从未配置时开关默认勾选、启动模型预选主模型、徽标如实显示“未启用”并给出“已默认启用：启动模型跟随当前主模型，保存本卡后生效。”；保存仍要求明确选择已配置的启动模型（不静默回退），保存后徽标转“已启用”。

## 验收记录

| 层次 | 实际检查 | 结果 |
| --- | --- | --- |
| 后端 | Agent 运行时专项（含新增：默认以主模型自播种、显式关闭不被覆盖）+ 办公室、任务、续跑、通知、历史、模型选择组合 | **171 项通过** |
| 前端全量 | `npm test` | **1078 项通过**（新增：侧栏主题切换与持久化失败提示、外观归位与旧深链映射、Agent 协作卡片位于模型页且旧深链映射） |
| 构建与静态检查 | 生产构建、lint、`git diff --check` | 构建通过；lint 0 错误、18 条既有 warning |
| 隔离浏览器（7898） | 真 `Sidebar`/`AppearanceSettings`/`AgentRuntimeSettings` + 真 `web/app.py` 运行时函数（QA 配置目录，不触网关） | 侧栏一键切换：浅→深（label 与 localStorage 同步）→浅；外观卡片在新位置渲染并实时联动状态行；Agent 卡片默认勾选 + 预选主模型 + “未启用”诚实徽标与默认说明；点击保存 → 徽标“已启用”、写入 `subagents.model=fixture/fast` 与默认限额、解除 deny；`重置→模拟后端重启`：未配置环境自动播种启用（对应真实启动守卫）；390px 无横向溢出；深/浅色截图复核 |
| 本机 7880 | 交付后重建 dist 的只读核对 | 见交付回执；新前端对未重启的旧后端保持兼容（无 `suggestedModel` 时退化为手动选择，不崩溃） |

隔离夹具、服务器与截图保存在忽略目录 `outputs/settings-reorg-2026-10-17/`。

## 边界与保留项

- 未调用付费模型、未部署 138、未更新安装包；未修改本机 `data/openclaw/openclaw.json`（自播种在下一次后端正常启动时发生，本轮不强制重启用户进程）。
- 本机 7880 后端为空配置环境：重启后端后 multiagent 将按主模型自动默认启用（可在模型与渠道页改为专用快速模型或关闭）；未重启前页面显示“默认启用待保存”。
- 显式关闭过 multiagent 的环境不会被默认化覆盖；如需恢复默认启动，在该卡片重新勾选保存即可。
