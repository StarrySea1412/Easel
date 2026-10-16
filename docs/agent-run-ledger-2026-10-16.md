# Agent run ledger（2026-10-16）

本轮在已有聊天快照和每轮 SSE 事件日志之外增加了项目级的持久 run ledger，目标是把 Easel 的逻辑轮次与 OpenClaw/Gateway provider run 对齐。它只记录身份和生命周期元数据，不保存提示词、模型正文、凭据或工具参数。

## 已实现

- 每个 `turnId` 在提交前创建独立账本文件，记录 `sessionId`、`sessionKey`、模型引用、引擎、`attempt`、`recoveryOf`、provider run ID、传输层、事件序号和终态。
- 记录 `accepted`、supervisor 启动、provider 接受、传输启动和 terminal 事件；保存停止原因、结构化错误来源、`settled` 与 `resourceSettled`。
- 同一逻辑 `turnId` 再次 POST 会返回冲突，不会把浏览器重连或重复提交变成第二个可能扣费的请求。显式重试必须使用新轮次，并通过 `recoveryOf` 关联旧轮次。
- `/api/chat/last` 附带账本快照，并新增只读 `/api/chat/runs/{turnId}`，供恢复和诊断读取；SSE 发现 Web supervisor 已丢失时会优先说明已知的 provider run 和持久终态。
- 账本事件历史限制为最近 200 条，文件采用临时文件加原子替换，避免进程崩溃留下半份 JSON。

## 验证

- `tests/test_run_ledger.py`、`tests/test_chat_recovery.py`、`tests/test_gateway_agent.py`、聊天模型/网关认证/推理流/问题重放/core 回归：**186 passed**。
- Python 全仓回归随后为 **2889 passed / 9 skipped**。
- `python -m py_compile web/run_ledger.py web/app.py` 通过。
- `git diff --check` 通过。
- 本轮没有调用付费模型、没有重发已有任务、没有安装外部技能、没有重启或更新 138、没有更新安装器/便携包。

## 仍未完成

账本现在能留下可核对的身份和终态，但 Web 重启后仍不会自动接管一个尚在 Gateway 中运行的 provider run；SSE 也还没有完全改为从账本事件投影。下一步是接入恢复 run 的归并、stall watchdog、compaction 事务和启动版本闸门，再做真实跨进程重启验收。未完成这些之前，不宣称长任务可无损续跑，也不自动重发已提交请求。

### 账本驱动的停止核实补充

- `chat_recovery.stop_orphan` 现在优先读取账本中的 `providerRunId`，在 Web 进程重启后仍可对精确后台 run 发起显式停止核实；停止或 supervisor 丢失后的终态同步回账本。
- 新增重启后仅快照缺少 `gateway_run_id` 的回归，相关聊天恢复专项共 15 项通过。此路径仍是用户显式停止/核实，不会自动接管或重发请求。
