# 对话页新增侧边栏：调研与设计（2026-10-18）

> **2026-10-19 复核**：本轮重新读取已安装 ZCode **3.16.1**，确认辅助对话与子智能体目录是不同面板类型；Codex 官方 Subagents/Projects 文档现在可经官方 Learn 页面读取，下面保留 10 月 18 日 3.15.3 的历史取证。最新实现、来源与未完成项见[深化调研](sidechat-subagent-deepening-2026-10-19.md)。

> 用户原话：“看看能否在对话中，新增一个侧边栏，参考页面如上，，你得调研好，，其他的harness有什么”（截图为 ZCode 内置浏览器的标签菜单：重命名 / 置顶 / **新建侧边聊天（Alt+Shift+S）** / 分叉 / 添加计划任务… / 复制 / **移至右侧面板** / 在新窗口中打开 / 归档，右上角高亮侧栏开关图标）。
> 调研方式：只读解析本机 ZCode 3.15.3 `app.asar`（`C:\Users\l\AppData\Local\Programs\ZCode\resources\app.asar`，抽取件在忽略目录 `outputs/zcode-research-2026-10-18/`）+ 官方文档联网读取（各条目标注来源与时间）。不改动任何本机应用。

## 1. 参考截图拆解（ZCode 内置浏览器标签菜单）

| 菜单项 | 类型 | 含义（依据本机 bundle 交叉验证） |
| --- | --- | --- |
| 重命名 / 置顶 / 复制 / 归档 | 标签管理 | 对浏览器标签本身的操作（归档对应 workspaceSidebar.toggleArchivedTasks 系列） |
| **新建侧边聊天**（Alt+Shift+S） | 侧边对话 | 在右侧面板新建一个“辅助对话”标签（`sidePane.selectionChat` = 辅助对话；`selection-side-chat` 数据模型见下） |
| 分叉 / 添加计划任务… | 会话衍生 | 基于当前标签/会话派生新线程或计划任务（对应自动化与子会话体系） |
| **移至右侧面板** | 面板归置 | 把该标签移入右侧 `sidePane`（面板标签类型里有与其并列的 `browser-use` 等） |

## 2. ZCode 3.15.3 侧边面板实证（本机 asar，只读）

### 2.1 面板形态（`IntlProvider` 中文键表，抽取件 `out__renderer__assets__IntlProvider-C9JSe21t.js`）

```
sidePane.expand  展开侧边面板        sidePane.collapse 收起侧边面板
sidePane.togglePanel 切换面板        sidePane.maximize 扩大面板
sidePane.restoreSize 恢复面板宽度    sidePane.addTab 新增标签
sidePane.openTab 打开标签页          sidePane.tabOverview 搜索标签页
sidePane.selectionChat 辅助对话      sidePane.review 审查
sidePane.subagent 子智能体           sidePane.subagentDirectory 子智能体目录
sidePane.workflowRun 工作流实例      sidePane.workflowDirectory 工作流目录
sidePane.workflowActor 工作流子代理  sidePane.workflowScript 脚本步骤
sidePane.workflowArtifact 产物       sidePane.pluginUi 插件
sidePane.openFile 打开文件（从 workspace 搜索文件在面板打开，含加载/空态）
```

结论：ZCode 的侧边面板是一个**右侧、可调宽/可最大化/可收起、多标签（可搜索标签）的容器**，承载的不只聊天：辅助对话、审查（diff）、子智能体、工作流实例与产物、插件 UI、打开的文件、终端、bash 输出、浏览器（`browser-use` 标签类型）等。

### 2.2 侧边对话的数据模型（`out__renderer__assets__styles-CSpM3qgc.js`）

- 标签类型 `selection-side-chat`，id 形如 `selection-side-chat:${workspaceKey}:${parentSessionId}:${childSessionId}`，字段含 `openedAt`、`ordinal`（同一父会话的多个侧边对话按序号编号，可复用空号）、`replacesChildSessionId`（替换重建）。
- **侧边对话是挂到父会话下的独立子会话（childSessionId）**，不是主会话里的旁支消息；父任务关闭时联动关闭其全部侧边对话。
- 面板状态存于 `sidePaneState.tabs`，与主工作区的标签体系并列。

### 2.3 对 Easel 的关键启示

1. “侧边聊天/辅助对话”= **父会话的子会话**：独立 transcript、独立记录，面板只是展示位；主线程不被插入消息。
2. 面板本身是**多标签容器**——先做对话标签，之后把产物预览/审查/进程（TodoWrite 式待办，见 `zcode-goal-process-research-2026-10-17.md`）等挂进去是同一形态的自然延伸。
3. 入口习惯：面板 + 号新增标签、标签可搜索、宽度可恢复；“移到右侧面板”是把已有视图归置进面板,而不是新建内容。

## 3. 其他 harness 对照（来源与时间标注）

| Harness | 侧边面/侧边聊天 | 要点 | 来源 |
| --- | --- | --- | --- |
| **Cursor** | ✅ 有侧边聊天（最接近的参考） | 输入框打 `/side` 或 `/btw`（或聊天面板顶部 + 按钮）开侧边聊天：“在不打断主对话的情况下提问或调查”；它是**独立的持久对话**，把父线程作为**隐藏参考上下文**、有自己的 transcript，可在主线程用 @ 提及它把上下文取回；Agent 本身位于 sidepane（Cmd+I）；面板还支持排队消息/立即发送(Cmd+Enter)/steering/会话搜索(Cmd+K) | cursor.com/docs/agent/overview（WebFetch 2026-10-18） |
| **VS Code Copilot Chat** | ✅ 面板式 | Chat view“在编辑器旁”、Inline chat 就地编辑、Agents window 跨会话管理、sessions 在 Chat view 与 Agents window 间保持上下文 | code.visualstudio.com/docs/copilot/overview（WebFetch 2026-10-18） |
| **Claude Code** | ➖ 无专用侧栏 | VS Code 扩展为“编辑器内联 diff、@ 提及、计划审阅、会话历史”（命令面板 New Tab）；JetBrains 插件交互式 diff；桌面应用可并排多会话、审阅 diff、定时任务 | code.claude.com/docs/en/overview（WebFetch 2026-10-18） |
| **Codex** | ✅ 2026-10-19 已取得官方 Subagents/Projects 文档 | 独立子线程、摘要回传、切换/追加指令/停止/关闭；项目内独立聊天保留历史。文档不证明其具有截图中的专用侧边聊天，不能把两种功能等同。10 月 18 日页面 403 是当时访问限制，现已复核 | [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Projects](https://learn.chatgpt.com/docs/projects) |

## 4. Easel 现状可复用点

- 对话页**已有右侧面板骨架**：`chat-goal-workspace.has-goal-panel` + `ChatGoalPanel`（目标详情右栏）——侧边栏可把这块泛化为“右侧可折叠多标签容器”，目标面板成为其中一个标签。
- 会话体系可承载子会话：`createSession`/`sessionsRef`/`saveSessions` + 本轮的 `pickMergeTarget` 规则；子会话可用既有会话行渲染（缩进/角标即可），或在面板内单列。
- 现成可挂面板的内容：`ChatArtifacts`（产物预览/媒体）、`ChatExecutionPanel` 与 Skill 核验证据（本轮已改悬停）、上下文用量面板、`ChatGoalPanel`。
- 布局要点：`.chat-page` 已是全高主列；`.chat-composer` 锚定经验（本轮菜单定位修复）可复用于面板内输入。

## 5. 候选方案与推荐 MVP

- **方案 A · 侧边对话优先（Cursor 式）**：对话页右侧加可折叠面板，第一版只做“辅助对话”一个标签：以当前会话为隐藏参考、独立 transcript 的子会话；入口 `/side`、`/btw` 与面板 + 号；不打断主线程，可把要点 @ 回主线程。（最贴合截图里的“新建侧边聊天”。）
- **方案 B · 工具侧栏优先（ZCode 式容器）**：右侧多标签容器，先挂“产物预览 + 目标面板 + 进程（待办时间线）”，聊天仍为主区域；侧边对话后置。
- **方案 C · 容器 + 侧边对话（推荐）**：面板容器一次到位（可收起/调宽/多标签），首个标签就是“辅助对话”，产物/目标/进程作为后续标签按需加入——与 ZCode 结构一致、与 Cursor 行为一致，避免二次改布局。

### MVP 验收条件草案（方案 C）

1. 对话页右侧出现可折叠面板：展开/收起、宽度可调并记忆（本地），窄屏（<900px）自动收起为全宽抽屉或不显示折叠按钮，不挤压输入框。
2. “辅助对话”标签：从当前会话新建/继续一个**子会话**（记录父会话 id 与序号）；发送消息不进入主会话消息流、不动主会话草稿；子会话沿用当前模型与限额，仍受网关连接状态约束（未连接如实禁用）。
3. 上下文：父会话内容仅作只读参考（默认取最近 N 轮摘要或显式引用），**不自动写入子会话提示词**；子会话可显式“引用到主对话”（插入草稿，不自动发送）。
4. 面板内标签：第一版含“辅助对话”；预留标签位（产物预览/目标/进程）但可后续启用；面板状态（宽、开合、标签）本地持久化。
5. 回归：既有对话/目标面板行为不变（目标面板并入容器后所有既有测试与键盘路径保持）；构建/lint/1087+ 测试；7880 浏览器核对（浅/深色、390px、键盘可达）。

### 不做清单（MVP 不做）

- 不做多标签并排的任意拖拽/Dock；不复制 ZCode 的工作流/子智能体标签。
- 不把侧边对话自动并入主线程上下文，也不自动触发付费模型调用。
- 不改 138/安装包；不碰并发未提交工作。

## 6. 结论

“对话中新增侧边栏”**可行且与 Easel 现有右栏骨架同构**：ZCode 与 Cursor 都证明该形态（右侧容器 + 父会话的子对话）是成熟做法；推荐按方案 C 分期实施，先交付“容器 + 辅助对话（/side）”，再按需把产物/目标/进程挂进同一容器。
