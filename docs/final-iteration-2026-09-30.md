# 本轮新增交互与参考依据（2026-09-30）

## 实际参考过的来源

| 功能 | 来源 | 采用的具体机制 | 验证范围 |
| --- | --- | --- | --- |
| 对话流式推理 | [Codex App Server](https://learn.chatgpt.com/docs/app-server)、[OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning) | 可读摘要增量、分段、最终结果保留，与正文及工具事件分开；不是用状态文字代替真实事件 | 已实际获取官方页面；Easel 仍使用 OpenClaw 事件，不声称复制 Codex 内部 UI |
| Windows 思考流缺失 | 本机 OpenClaw 2026.9.6 runtime 的 raw-stream 事件结构 | Windows 配置 raw stream 路径，按 sessionId/runId 关联；结束事件补齐；HTTP/raw 单源去重 | 源码核对与模拟事件/实际 supervisor 测试，未进行计费模型调用 |
| 运行记录 | [CC Switch UsageDashboard](https://github.com/farion1231/cc-switch/blob/main/src/components/usage/UsageDashboard.tsx)、[UsageHero](https://github.com/farion1231/cc-switch/blob/main/src/components/usage/UsageHero.tsx)、[RequestLogTable](https://github.com/farion1231/cc-switch/blob/main/src/components/usage/RequestLogTable.tsx)、[RequestDetailPanel](https://github.com/farion1231/cc-switch/blob/main/src/components/usage/RequestDetailPanel.tsx) | 概览优先，筛选、调用明细、单次详情分层；缓存/成功比例按总分子分母算，不把不同记录的百分比直接相加 | 已实际获取公开源码；只展示 Easel 真实具备的字段，不造费用或成功率 |
| 图生图 | 用户原项目 `C:/project/ai-image-studio/README.md`、`src/provider-service.js`、`client` 创作页 | 参考图走 multipart `/images/edits`，支持蒙版，保留上传记录并从图库复用 | 已阅读原项目；Easel 原有 CLI 已支持 img2img，本轮补齐 Web API 与 GUI |
| 内容分析 | [Buffer Insights](https://buffer.com/insights)、[Sprout Social Analytics](https://sproutsocial.com/features/social-media-analytics/)、[微信官方统计](https://developers.weixin.qq.com/doc/service/guide/product/analysis_data/analysis_data.html) | 产品层级和对应官方指标口径；页面新增“分析方法与来源” | 这些来源不证明本地编辑建议能提升效果；未做真实账号效果研究 |

## 实现状态

- 流式推理：修复恢复流不更新、4000 字截断、最后摘要丢失、跨会话与双来源重复；仅展示接口实际返回内容。
- 图生图：独立模式、参考图上传/预览/持久化、可选蒙版、图库/内容库复用、自动尺寸、任务结果与原图引用保存。上传验证字节而非文件扩展名；无效 ID 不会调用供应商，异步通道不支持蒙版时明确拒绝。
- 运行记录：重做会话筛选、用量概览、真实分页轮次分布、明细和来源口径；聊天每轮增加 Skill 证据，并读取实时工具 trace，不把选中技能当成已执行。
- 保存位置：设置页保存新路径，经图形启动器确认重启后迁移内容，校验复制结果并保留备份，逻辑 outputs 路径保持兼容。浏览器会话、持久 Cookie 和模型配置保留在原数据位置；outputs 内的临时登录/工作状态文件随整个内容目录迁移。
- 账号管理：增加管理视图、身份隐藏、退出确认与本地凭据清理状态；不新增 Easel 用户名/密码门禁。后端只清理指定平台，失败不报告成功，旧校验结果不能重新恢复登录状态。
- SMTP：用户确认使用 QQ 邮箱，随后明确暂缓；不阻塞当前核心交付，也没有发邮件或读取/填写授权码。

最终构建、测试、安装和浏览器验收状态以 [当前进度](secondary-development-progress.md) 为准。本轮用户按 Esc 停止电脑控制后未再执行浏览器或原生界面操作；自动化/源码检查不冒充可视点击验收。


最终版本 0.2.5：1005 项 Python 回归通过、1 项注册表测试跳过；15 项前端回归、构建与 lint 通过。最终 EXE 在已迁移内容的隔离测试目录升级，8/8 阶段成功并正常退出 0；修复了实际发现的临时 DLL 占用、瞬时健康检测和保存位置迁移后不能升级的问题。完整结果见上述当前进度。
