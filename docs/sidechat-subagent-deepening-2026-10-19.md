# 辅助对话与 Subagent 深化（2026-10-19）

结论：用户指出的差距成立。Easel 已有多辅助对话、OpenClaw 委派与独立控制，但此前侧栏输入和执行反馈明显弱于主聊天，Agent 办公室也不能承担完整子任务管理器的职责。本轮先补齐辅助对话常用能力及子任务回复的观测闭环；持久子任务目录、追问与跨进程恢复仍是下一阶段的核心缺口，不能宣称已追平四个参考产品。

## 调研依据与事实边界

| 产品与版本 | 本轮读取的依据 | 可确认的设计 | 不能据此断言 |
| --- | --- | --- | --- |
| Codex，官方文档 2026-10-19 读取 | [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Projects](https://learn.chatgpt.com/docs/projects)；从 developers 链接跳转到官方 Learn 页面 | 子 Agent 使用独立线程，主线程接收摘要；可查看/切换、追加指令、停止、关闭；未覆盖的模型与思考强度继承父级；子 Agent 不能扩大父级权限；项目内聊天各自保留历史 | 官方多线程与 Subagents 文档不证明截图中的专用“侧边聊天”是 Codex 的同一功能；没有公开其桌面完整实现源码；并行不保证提速比例 |
| DeepSeek Harness，`687f282e8625c6b8d11ff58211a90524be2e4317` | 固定提交的 [Subagent subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/subsystems/subagent.md)、[Jobs](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/subsystems/jobs.md)、[README](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/README.md) | durable child Session 与一次 activation 分离；统一 `startActivation`、身份/容量预留、父级或调用方回传、子目录与消息投递；本地同一子会话最多一个活动 activation；interrupt 接受不等于资源已静止 | 属于 developer preview，不能把当前协议视为稳定兼容承诺；本轮阅读的是固定提交的架构/API 文档，没有运行其系统 |
| Grok Bot，文档页面更新 2026-10-13 | 官方 [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration)，本轮实际读取 | 会话可见工具、文件、提问与审批；执行中用户消息优先；Stop 不撤销已发生动作；群组支持 2–6 Bot、@角色和可见异步交接，每阶段明确负责人 | 群组 Bot 协作不等同其内部 Subagent 调度器；文档不提供取消树、资源结算或持久存储的内部实现证据 |
| ZCode，本机 **3.16.1** | 只读解析已安装 `resources/app.asar`；renderer 的 `IntlProvider-BDsfwem3.js`、`styles-CqgV6nRf.js`、`validation-t4BGb8yA.js` | `selection-side-chat` 有 parent/child 身份、序号、替换关系；`subagent-session` 与 `subagent-directory` 是另一类面板；目录区分运行/结束、加载错误和“再显示20个”；Subagent schema 关联 agentId/agentType/childSessionId/parentSessionId 与父工具/轮次 | 客户端 bundle 的字段、文案和渲染分支不能证明服务端调度可靠性、实际并发量或真实模型表现；没有执行 ZCode 子任务 |

ZCode 10 月 18 日研究基于 3.15.3，以上是本轮重新读取的 3.16.1，不覆盖历史版本证据。用户附件可证明浏览器起始页有“侧边聊天”入口及快捷键，不能单靠入口推断上下文和运行语义。提取件与测试截图保存在本机忽略目录 `outputs/sidechat-subagent-2026-10-19/`，不把第三方打包源码和用户本地状态上传仓库。

## Easel 的真实调用链

辅助对话是用户直接操作的 `ChatSession`，带 `parentSessionId`，有独立会话 id、草稿、消息与运行轮次。它不等于模型通过工具委派的 Subagent。父会话内容只在用户明确引用时进入子草稿，侧栏结论引用回主草稿也不自动发送。

本轮改造后的发送路径是 `ChatPage.SideChatThread → ChatComposer → App.handleSideSend → handleSendMessage`，与主聊天共用附件、技能要求、模型选择、思考强度及队列路径，按子 id 分配流式状态、停止与问答。新建子会话继承父画像和执行引擎（OpenClaw/Codex），模型仍受当前选择和后端能力核验约束；“自动沿用”不是已观察到实际运行模型的证据。

真实 Subagent 则由 OpenClaw 的 `sessions_spawn` 等执行。`web/agent_office.py` 读取父轮次 transcript 的明确工具回执来识别身份；`office_controls.py` 已具备精确会话/轮次/Agent 绑定的子 Agent 模型设置与独立停止能力，因此此前不是“完全无法停止子 Agent”。`run_ledger` 是现有主运行账本，尚不是跨引擎的持久子任务目录。Codex 在独立服务路径执行，当前 Office 不能代表其完整子线程拓扑。

## 本轮落地

### 辅助对话

- 复用真实 `ChatComposer`，替换单独的简陋 textarea：素材菜单、技能和要求、模型、思考强度、队列与 Codex 文字插话沿用主聊天实现。Codex 的技能限制按引擎保留，不虚构跨引擎能力。
- `onSideSend` 返回接受结果；仅在消息真正被接受后清理子草稿。拒收/异常时保留文字和引用，主草稿不被清空。
- 展示该子会话实时文字、服务返回的思考/活动、心跳提示与本轮执行面板；OpenClaw 问答与 Codex 审批在侧栏处理，提交携带正确子会话/轮次。
- 产物按子 id 和原轮次读取并展示。读取失败提示重试，不用父会话产物填补空白；没有真实生成时不报告产物链路已验。
- 停止中、停止失败及重试绑定子 id。刷新/切回父会话时恢复其子会话已有 pending turn，包含已关闭标签；这是重连既有运行，不是重新提交生成。
- 标签“×”改为关闭视图并持久化 `sideClosed`，保留历史、草稿及后台执行；“＋ → 重新打开”恢复原子 id。停止后台执行应使用停止按钮。关闭标签不再隐式删除历史或取消任务。
- 保留多实例、F2 改名、Alt+左右排序、显式双向引用及宽度记忆；键盘聚焦时显示关闭按钮，窄容器工具栏换行。

### 子 Agent 观测与回传

- 已确认 spawn 身份后，产生属于该子 Agent 的独立 `spawn` 事件；仅明确状态回执产生 `status` 事件，不再让子详情只有父工具行。
- 从匹配子身份的 `lastAssistantMessage` / `messages` 中提取最新 assistant 文字摘要。要求时间处于创建回执与当前工具返回之间，嵌套身份不能冲突，旧回复不能覆盖新回复；排除 thinking 和工具参数。
- 复用脱敏、限制为 1600 字并标注来源/时间/截断。在员工过程详情新增“子任务最新回复”，以纯文本展示，不执行 HTML，也不借用主 Agent 思考。
- 回复不意味着任务完成。父轮结束后，历史 running 状态仍降为“状态未知”，除非有独立终态证据；当前快照最多保留 40 条事件，不保证完整子 transcript。

这是“已有子身份 → 可归属的事件 → 可核验回复 → 页面详情”的观测闭环。它不新增模型调用、不主动轮询子 Agent transcript，也没有实现持久调度与自动汇总的替代内核。

## 仍需攻克的差距与实施顺序

| 优先级 | 缺口 | 建议实现和完成条件 |
| --- | --- | --- |
| P0 | 独立且可恢复的子任务目录 | 保存 parent session/turn/tool call、child session、activation/run id、创建/终态与来源；服务重启后可列出历史，未确认的运行显示待核实，不按父轮结束推断停止 |
| P0 | 子任务可打开、追问与 steer | 以真实 child id 打开原线程，读取其获授权的历史；向空闲线程续聊、向活动线程插话分别验证。重试必须幂等，不新建替代线程冒充恢复 |
| P0 | 取消与后代资源结算 | 分开记录“请求接受”“执行已停止”“后代资源已释放”；并发取消、父级结束、断网、运行器崩溃和迟到结果不串轮次，不越权停止其他任务 |
| P1 | 委派契约及结构化结果回传 | 任务、输入引用、输出要求、负责人及验收标准明确；结果与产物关联原 child/run；主 Agent 有明确接收与失败回执，不能用 prose 声称交付 |
| P1 | 并发、模型与用量 | 权限继承不扩大、并发容量预留、模型按执行回执核对、每个子 run 用量单列且避免父级重复记账；本轮未实测模型费用与加速比 |
| P1 | 跨引擎一致能力 | 对 OpenClaw 和 Codex 分别声明目录、追问、停止与恢复能力；不支持项明确禁用，不能用一种引擎的 Office 快照推断另一种 |
| P2 | 面板整理 | 已关闭标签多时搜索/分页，辅助对话与子任务目录统一容器但保持不同身份和操作语义；更多面板仅在有真实后端能力时开放 |

优先采用可替换的运行器适配层，复用已有 OpenClaw/Codex 控制和主 run 账本。本轮不引入 DeepSeek Harness 依赖、不复制第三方 bundle，不因为参考产品数量多而并行引入四套状态模型。

## 检查与验收

- 后端定向：`test_agent_office`、`test_model_identity`、`test_office_controls`、`test_agent_runtime_settings`，**159 passed**，2 个依赖弃用 warning。包含伪造身份/过期时间/外来回复拒绝、冲突会话不能借已知run归属、脱敏/长度、独立生命周期、停止与模型控制回归；不是后端全仓通过声明。
- 前端全量：**1136 passed，0 failed / cancelled / skipped**，exit 0；使用与 `npm test` 相同文件范围并设置 `--test-concurrency=4`。侧栏专项 **10 passed** 已包含在全量中；覆盖拒收草稿、独立 stream/stop、重开、问答与 Codex 审批目标身份。后端最终另复跑 `test_agent_office` **85 passed**，是159项的子集，不重复累计。
- TypeScript/生产构建通过，lint 0 错误（18 个既有 warning），保留既有大 chunk 提示；`git diff --check` 通过。
- 真实浏览器使用 **7899 隔离 origin、真实生产 bundle**；合成父会话，GET 只读代理本机，所有写 API 在代理层阻断，未修改用户原 origin 会话。实际核对：主子不同草稿、整页刷新后保留、关闭/菜单重开原草稿、素材菜单、模型菜单及不可用项、第二标签与草稿切换、F2 改名、Alt+左排序、浅/深色、窄屏。视口能力受宿主缩放影响，以 DOM 实测校准为 **390 CSS px**；`scrollWidth=390`，面板及输入区在屏内。截图保留本机忽略目录。
- 模型服务与上游读取有离线/401 或超时，页面显示实际错误；未触发真实模型生成、审批操作、素材上传或产物生成。问答/审批提交由模拟 DOM 回归验证，不冒充真实供应商端到端。
- 无新增管理员认证；不适用登录验收。未重启本机后端或网关、未部署 138、未更新便携包。7880 的前端构建可由刷新加载；后端观测改动在下次正常重启后生效，当前服务未宣称已加载。

本机检查日志保留 `%TEMP%/easel-sideagent-*`。源代码推送、浏览器交互通过、真实子 Agent 执行和新安装器发布是四种不同状态，交付时分别说明。
