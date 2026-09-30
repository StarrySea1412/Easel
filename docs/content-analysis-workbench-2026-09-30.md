# 内容分析工作台：实现与数据契约

日期：2026-09-30。本文记录已实现的本地能力，与平台在线权限、模型视觉能力分别验收。

## 已实现

- 七平台统一规范导入（小红书、抖音、快手、知乎、视频号、B站、公众号），以 `platform + accountId + id` 隔离作品，标题不参与身份匹配。
- 本地 SQLite 事务持久化。一次导入任意记录校验失败即整批拒绝；重复观测幂等；旧观测进入历史而不覆盖最新指标。
- 作品详情包含真实指标、观察时间、统计口径、正文、封面文字/OCR、视频逐字稿、真实评论及材料诊断。
- 标题强承诺、正文开头与结尾、长段落、举例标记、封面文案、逐字稿推进、评论提问和重复问题均引用输入材料；提供具体修改方向。
- 评论重复按去空格和句尾标点精确归并；不冒充语义聚类，不推断独立用户数。
- 按用户标签整理主题样本；标签允许重叠，不能将标签合计再次加总。
- 根据现有主题和真实评论生成可编辑读者问题、标题方向与提纲；保留证据作品 ID。
- 实验创建冻结主指标、关联作品和基线；回收读取最新真实观测。只有后续同 `lifetime` 口径且投放标记一致才计算累计差值。差值不代表改动因果效果。
- JSON 完整证据报告及 Markdown 可读报告下载，包含数据质量、诊断原文和实验结论。
- 实时采集桥接调用原有采集链。必须返回匹配的稳定账号 ID，且作品具有稳定 ID，否则不写入工作台。明确显示仅采集部分样本。
- 可选 AI 深度解释：复用模型设置里的 OpenAI 兼容/Anthropic 通道，仅用户点击时发送当前作品文字、指标和规则。结构化结果逐条核验作品字段证据 ID 和逐字引用，拒绝无引用结果，过滤数字/百分比和明显因果承诺。引用匹配不等于模型判断正确，必须人工复核。结果持久化，材料或指标变化自动失效。

## 数据约束

`metrics` 支持 `views / likes / comments / collects / shares`，只接收非负有限数值或 `null`，不把“1万”等统计文案猜成数值。0 与缺失不同。未知或混合统计窗口不做合计，已知同窗口只提供已导入样本的部分合计并附覆盖篇数。阅读人数、阅读次数等口径应由导入者先核对，不能在同一指标内混用。

时间需要 ISO 8601 时区（如 `2026-09-30T08:00:00+08:00`）或 Unix 秒；发布时间未知保持空值。只有用户提供真实的 24h / 7d / 30d 观察口径时才填写，不能按当前年龄倒推。

材料编辑不提供 `metrics` 时保持原指标、观察时间、统计口径及投放字段，不制造新指标快照。手动导入账号归属标记为 `user_declared`；在线采集明确核验账号时标记 `live_verified`，混合样本为 `mixed`。

## HTTP 契约

| 方法与路径 | 功能 |
| --- | --- |
| `GET /api/content-analysis/accounts` | 已持久化账号列表 |
| `GET /api/content-analysis/report?platform=...&accountId=...` | 所选账号完整报告 |
| `GET /api/content-analysis/template?platform=...` | 无模拟数值的可编辑导入模板 |
| `POST /api/content-analysis/import` | 校验并持久化规范作品数组 |
| `POST /api/content-analysis/capture` | 实时采集后核验账号身份与稳定作品 ID |
| `POST /api/content-analysis/interpret` | 可选模型解释，主体为 `platform, accountId, contentId` |
| `POST /api/content-analysis/experiments` | 冻结实验基线 |
| `PATCH /api/content-analysis/experiments/{id}` | 更新状态、回收最新观测和记录结论 |
| `GET /api/content-analysis/export?...&format=json` | 下载机器可读证据报告 |
| `GET /api/content-analysis/export?...&format=markdown` | 下载可读复盘报告 |

导入主体为 `{platform, accountId, name, contents: [...]}`。每篇必须有 `id`；可选 `title, body, tags, comments, coverText, transcript, format, publishedAt, snapshotAt, period, paid, url, metrics`。单次最多 2000 篇、请求体最多 10 MB。

## 核验记录

`python -m pytest tests/test_content_analysis_workbench.py tests/test_account_analysis.py -q`：**63 passed**。其中工作台新测试 34 项；覆盖七平台账号隔离、原子导入拒绝、非有限数/布尔数拒绝、重复幂等、旧快照、材料编辑保留快照、混合口径、重复评论证据、逐字稿/封面文字、实验基线与账户隔离、持久化重开及 ASGI HTTP 契约。AI 测试使用两种协议的模拟响应，覆盖原文引用校验、伪造引用/数字/明显因果拒绝、无模型配置、材料变化失效和旧请求拒绝保存。

这些是隔离测试数据和应用内 HTTP 测试，不代表已经登录七个平台在线采集。真实平台在线可用性由实际账号、网络和权限决定。AI 深度解释已接入但未使用真实供应商凭据调用；模拟协议通过不等于真实模型质量已验收。未调用视觉模型，不宣称检查封面配色/构图、视频画面、语速或完播原因。独立图片理解仍使用项目既有图片解读功能，其真实模型调用需按已配置模型单独验证。

浏览器验收补充：使用隔离本地后端与显式模拟账号，完成导入/预览/确认、作品诊断、主题跳转、实验建立/开始/回收、编辑提纲进入选题库、Markdown 与 JSON 实际下载。收藏基线 10、后续观测 16、差值 +6 按累计变化展示；原始正文及标签在仅更新指标后保留。搜索零匹配保留旧详情的问题已修复。全量 903 passed、1 skipped；前端 build/lint 通过。
