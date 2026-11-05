# 工具修复 Agent 与小红书组别优化（2026-11-05）

## 现场结论

截图对应 138 会话 mw1vv1es555csq 的轮次 1793782647262-k03kh01995。运行账本先记录 provider_accepted，随后因 180 秒无新事件进入 stall warning，最终以 model_provider_timeout 失败。同期 view_image 两次返回 Local media path is not under an allowed directory，路径分别位于 /data/outputs/3D打印玩具种草卡组/card_1.png 和 /data/outputs/3D打印鳄鱼相机种草卡组/assets/crops/_sheet.png。这两个层次必须分开：图片路径允许目录是工具环境故障，provider timeout 是模型供应商响应故障，后续 recovery 404 只能表示当前轮次不可接管。

## 对标取舍

agent-orchestrator / DeepSeek super-agent / harness 的可迁移部分是长驻路由、独立工单身份、准入门、工具事实优先、outbox/账本、one-writer 和 no-wait 边界。本轮只吸收这些状态与证据原则，没有把研究仓库代码或外部运行依赖复制进 Easel。Easel 已有 session/provider lock、run ledger、execution journal 和不重复提交约束；新增层只负责确定性工具修复与下一轮上下文，不启动第二个模型请求。

## 修复 Agent 边界

RepairAgent 以 session + turn + tool call 为幂等键。当前唯一自动动作是：当 view_image 返回 allowed-directory 错误，且源文件严格位于配置的 outputs 根目录、扩展名为图片且真实存在时，复制到 OpenClaw 实际 workspace 的 _inspect/easel-repair/。每个工具调用最多一次、每轮最多一次；源路径越界、未知工具、provider timeout、浏览器/认证/发布错误都写入 manual 回执。

回执写入 outputs/_repairs/<session>/<turn>/，执行 journal 的 operation 行带 repair 状态。下一轮同一 sessionId 的 _chat_message 会读取最近回执：repaired 可继续读取 targetPath，manual 要求人工继续，不重放已失败操作。回执只保留脱敏事实，不携带工具参数或凭据。

## 小红书组别

- 笔记/图文/视频内容：xhs-note-creator。
- 纯文字、概念、数据卡：card-design 选定风格后走 card-xiaohongshu HTML/CSS 渲染与 card_audit；真实照片卡才使用 text_on_image。
- 爆款规律、关键词矩阵、限流检测：skill-xhs-analyzer，保持串行研究和节流。
- 评论抓取与回复：skill-xhs-comment-reply，与只读分析分开。
- 发布：skill-xhs-publisher，必须用创作者后台 readback 证明平台状态；登录失效、429、网络风险和安全验证分别回执。

素材统一保存到 outputs/<主题>/assets/。视觉工具失败时不凭文件名猜图，也不把模型超时误报成图片能力问题。

## 验证边界

本轮新增修复链后端测试 36/36 通过；既有模型选择 45/45、浏览器运行时 20/20、对话失败 6/6、技能审计 3/3 通过，前端定向回归 54/54 通过。生产前端 build 通过，lint 无错误但保留既有 warning。以上分组存在重叠，不相加为单一总数。真实浏览器业务路径、138 隔离/正式部署和用户最终验收仍未完成；源码版本已同步为 0.9.0，构建 SHA 与 138 实际运行身份仍需分层核对。

## 第二轮 Super Agent 加固（0.10.0）

- 工具行在保留旧 `status` 的同时写入 `lifecycleState` 和有界历史：`admitted`、`running`、`succeeded`、`repairable`、`manual`、`stopped`、`unknown`。修复成功后进入 `repairable`，不能安全自动处理的失败进入 `manual`，监督进程结束但没有终态的工具进入 `unknown`。
- 前端执行面板保留旧的“失败/未确认”状态，同时显示“已修复，可继续”“需人工接管”“状态未知”等生命周期事实，避免用户把可继续的工具故障误判成模型失败。
- repair-agent 初始化时从持久回执恢复当前轮的调用幂等和整个会话的修复次数；会话默认最多三次修复、单轮最多一次。重复调用只返回已有回执，不再次复制文件。
- 连续对话只读取归属当前 session、状态为 `repaired/manual` 且 24 小时内的回执；修复了回执上下文的换行拼接，避免把转义字符送进模型。
- 小红书发布与分析/评论技能组合在请求入口拒绝，要求先结束只读阶段再单独确认发布。
- repair-agent 接入当前轮的 stop event；用户停止后即使迟到的工具失败回执到达，也只写 `manual` 回执，不创建检查目录或复制素材。前端对生命周期状态与旧 `status` 做相容性白名单校验，冲突值降为 `unknown`。

第二轮验证：新增生命周期/预算/路由/停止检查 31/31，执行面板/浏览器定向检查 23/23，既有相关后端回归 74/74，Python compileall 和生产 frontend build 通过；138、真实浏览器业务路径和用户最终验收仍未完成。
