# Agent 并行提速、启动模型与费用保护（2026-10-16）

本轮接续用户反馈“足足耗时一个钟……增加 agent 提供速度……增加启动模型，避免调用 agent 错误导致贵的模型被疯狂扣费”。截图中的 `chat_supervisor_lost` 只能说明监督连接在长任务或服务重启后丢失，不能据此推断模型本身必然失败，也不能把重连当成重新提交任务。

## 已实现

- 设置 → **Agent 协作**增加启动模型、并行 Agent 数、单个父 Agent 子任务数、嵌套层级和单任务上限。
- 启动模型只能从 OpenClaw 中已配置、可核验的完整 `provider/model` 引用中选择；配置登记不等于凭据已测活，也不等于真实调用已成功。
- 保存启用状态时写入 `agents.defaults.subagents.model`，子 Agent 不再静默继承当前对话模型，也不启用备用模型回退。
- 未配置启动模型时，`sessions_spawn` 会加入 `tools.deny`，办公室任务入口也显示保护提示并禁用提交；禁用 Agent 时同样阻断子任务。
- OpenClaw `2026.9.6` 本地安全插件在 `before_tool_call` 阶段再次 fail-closed：拒绝无启动模型、拒绝显式指定其他模型、拒绝超过单任务上限的调用。
- 并发和递归参数写入 OpenClaw 子 Agent 配置，范围为并行 1–8、单父 Agent 子任务 1–5、嵌套 0–2 层、单任务 60–3600 秒。默认值为 4 / 3 / 1 / 900。

## 验证证据

| 检查 | 结果 | 口径 |
| --- | --- | --- |
| `tests/test_agent_runtime_settings.py` | 2 passed | 后端隔离配置；非法模型、关闭阻断、严格模型保存 |
| 前端全量回归 | 1023 passed | 既有全量套件；本轮未触发模型调用 |
| `npm run lint` | 通过 | 仅保留项目已有 warning |
| `npm run build` | 通过 | TypeScript/Vite 生产构建；保留既有大 chunk 提示 |
| 本机 HTTP | 200 | `/`、`/api/status`、`/api/settings/agent-runtime`、`/api/agent-office/models`；`gateway=true` |
| OpenClaw 插件目录 | loaded | `easel-agent-safety` 已由本机 `data/openclaw/openclaw.json` 加载，版本边界为 bundled OpenClaw 2026.9.6 |
| 真实浏览器 | 已检查 | 设置入口、模型选项、未配置提示、办公室“发起任务”阻断；未点击保存或提交任务 |

本机当前没有启动模型，因此实际状态是“未启用”：`sessions_spawn` 被阻断，办公室按钮不可提交。当前已配置候选为 `relay/glm-5.3` 与 `relay/kimi-k3`；选择并保存后才会开启新 Agent 任务。验证过程没有发送模型请求、没有调用真实付费服务，也没有做速度比例或费用节省承诺。

## 边界

并行参数只约束 OpenClaw 的子 Agent 调度，不能保证外部供应商、网络或上游队列按比例提速。`chat_supervisor_lost` 的原有停止/恢复语义仍保留：不会因为连接丢失自动重发付费请求；用户可在任务记录中重试或新建任务。138 服务器、安装包和便携包未更新。

## English

The Agent collaboration settings now require an explicitly configured `provider/model` startup model before delegation is enabled. `sessions_spawn` is denied while the model is missing, and a bundled OpenClaw 2026.9.6 safety plugin rejects model overrides and over-limit timeouts before execution. Concurrency, child count, depth and timeout are bounded. Local HTTP/browser checks and regression/build checks passed; no paid inference or real Agent task was started, so no speedup percentage is claimed.
