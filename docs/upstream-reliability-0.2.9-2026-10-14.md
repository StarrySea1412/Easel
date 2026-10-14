# 0.2.9 上游可靠性跟进 · 2026-10-14

本版落实[上游对比计划](upstream-comparison-plan-2026-10-14.md)的 B 批次。主要来源为 [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel)，固定比较提交为 [`bb3c8ff0463f36c202454d74171682ba6e470cb1`](https://github.com/ZJU-REAL/Easel/commit/bb3c8ff0463f36c202454d74171682ba6e470cb1)，上游源码版本为0.3.0。本仓库源码候选为0.2.9，两者版本号各自维护，不代表已完整迁移上游0.3.0。

实施分支为 `codex/upstream-reliability-0.2.9`，本地基线 `a208cb895fbeb6da82e88a067b7a74021a02c41c`。独立工作区保留创作者工作流、持久执行证据、已有凭据事务及账号数据隔离，没有直接覆盖上游页面或引擎架构。

## 已吸收的行为

| 上游来源 | 本版实现／已有等效行为 | 验证与边界 |
| --- | --- | --- |
| [`c8ad1f36`](https://github.com/ZJU-REAL/Easel/commit/c8ad1f36)、[`ede33b89`](https://github.com/ZJU-REAL/Easel/commit/ede33b89)、`718f9a04`：扫码入口与登录判定 | 小红书补登录入口和扫码模式切换；可见二维码不重复切换，隐藏二维码不阻挡入口。登录成功要求官方HTTPS页面上的可见账号标识；通用发布器拒绝空白页、匿名登录跳转与其他站点 | 模拟页面覆盖可见/隐藏与官方/非官方地址；现有二维码像素检测、原子刷新、过期验证和状态回写回归保留。真实App扫码未重验 |
| [`eee47f86`](https://github.com/ZJU-REAL/Easel/commit/eee47f86)：小红书身份、等待和目录锁 | 新增OS跨进程Profile锁，登录、发布、身份读取与采集共用同一锁；不删除Chromium自身锁。服务端确认本人userId；请求和正文等待有时间上限；仅抓已发布列表 | 真正Windows双进程锁竞争、中文空格路径及异常释放已测；身份/网络/退出、账号切换、空数据与草稿过滤使用受控数据验证。真实平台API与账号采集未重验 |
| 同上：失败与缺字段 | 身份未知提示重试；创作中心失效、无数据、列表失败或账号变化时不保存快照。仅确认空态才接受空列表；缺近7日指标保留本人概览及笔记并显示警告 | 继续使用既有账号代际失效、来源隔离及历史保留；不以零补缺字段，不以昵称认定归属 |
| [`e6d5e8eb`](https://github.com/ZJU-REAL/Easel/commit/e6d5e8eb)：Windows PATH | 安装器优先加入自身npm路径，保留调用进程PATH，再补注册表Machine/User PATH；winget后刷新也保留进程工具路径 | PowerShell子进程实际执行PATH表达式；脚本保留UTF-8 BOM。未执行依赖安装或写注册表 |
| [`a9164842`](https://github.com/ZJU-REAL/Easel/commit/a9164842)、[`9ccba752`](https://github.com/ZJU-REAL/Easel/commit/9ccba752)：思考能力与格式 | 自定义聊天模型支持能力自动/启用/禁用；OpenAI兼容协议支持自动检测及明确格式。自动模式删除格式覆盖，交由运行时判断；Anthropic使用原生协议。字段缺省保留旧值，空密钥保留已有凭据，非法字段写入前拒绝 | 隔离文件验证配置事务与凭据保存；共享Select键盘、折叠草稿和保存载荷回归。未发送真实模型请求 |
| UTF-8、二维码新鲜度和过期响应 | 定制分支已有等效实现，保留原代码与回归，不重复改变编码或状态机 | CLI路径、登录捕获/恢复、账号代际回归；不把历史真实验收计为本次新验收 |

上游纯解析逻辑在 `xhs_account.py` 与账号概览解析中按本仓库证据契约适配，保留项目MIT许可及上游归属。

## 兼容边界

小红书 `account_id` 现在采用认证接口确认的稳定userId。旧版本从页面显示的小红书号取得的历史仍留在原账号目录，不凭昵称自动合并；该账号首次成功采集后可能建立新的活动账号证据。旧数据没有删除或迁移，真实平台验收需确认同一账号的历史对应关系。

明确不支持思考的型号，在新建内部同步任务或本轮明确指定型号的CLI/native RPC中关闭隐式思考级别。既有会话未指定型号时保留原策略，避免默认模型覆盖绑定型号；用户明确选择的思考级别仍走实际网关能力校验。HTTP由OpenClaw读取模型元数据，本版没有增加未经文档确认的HTTP思考参数，不声称所有会话默认值已统一改为off。

Profile锁覆盖本仓库小红书启动链路，外部工具仍由Chromium自身锁保护。页面结构变化或缺少“已发布”入口会明确失败，不把无法读取的数据当作成功。

## 验证记录

- 最终核心后端定向232项通过：登录捕获/恢复、账号数据与代际、模型配置/思考、CLI路径及新增上游可靠性回归。新增测试使用临时目录和受控数据，其中Profile锁为真实Windows双进程竞争，PATH为真实PowerShell表达式执行。
- 前端相关67项通过：实际SettingsPanel/ProviderBoard、共享Select、模型/思考选择与测活面板，API使用桩、禁止网络；覆盖键盘、草稿、保存载荷和已有凭据保留。属于happy-dom/JSDOM逻辑检查，未算作真实浏览器验收。
- 全量前端lint退出0，保留既有18条警告；TypeScript与Vite生产构建通过，保留既有大chunk/插件耗时提示。生成技能依赖文件与原内容相同，未提交仅换行差异。
- 安装runner附加检查27项通过，既有后台子进程测试在两次高负载运行中分别触发marker/5秒时序断言；不改runner实现或放宽断言，最后单独复验1项通过（1.31秒）。未将失败的整组运行报告为全通过。
- 已只读核对本机实际OpenClaw包版本2026.9.6及其配置类型定义，七种thinkingFormat均在支持枚举中；未启动模型或修改真实配置。

本轮未重验真实小红书App扫码、平台API、账号采集、模型推理、全新Windows安装、全部菜单或窄屏布局。前端页面验收按用户要求由用户完成。源码版本与前端dist来自独立worktree，没有替换本机7880服务目录。

## 交付与后续

- 代码、双语README、CHANGELOG、计划、进度和用户清单一起提交并推送到 `starry/codex/upstream-reliability-0.2.9`；远端SHA见交付回执。
- `main` 仅同步双语首页和明确分支入口，不合并功能代码。
- 未部署0.2.9到138、重启既有服务或发布新exe/安装器；完整便携打包保持此前暂停状态。
- 原计划A的0.2.8运行修复已完成，正式提交为 `0ba9fe201ca384f40894545db068a093b0e21235`，OpenClaw仍固定2026.9.6，依据[运行回执](runtime-repair-2026-10-14.md)。原计划旧部署描述保留为历史比较基线。
- C共享资源路径、D真实文件画廊、E引擎契约、F新增引擎继续单独实施；自动审批、完整恢复/负载、平台/付费媒体和服务器Codex启用等历史未验项保持。

## English

This 0.2.9 source candidate implements reliability batch B from upstream Easel at fixed commit `bb3c8ff0` (upstream 0.3.0): QR entry and positive login evidence, bounded XHS identity/creator collection, shared cross-process profile ownership, inherited Windows PATH preservation, and custom-model reasoning capability/automatic request-format controls. Existing credential transactions, account/source isolation, stale-result guards and durable execution records remain in use.

Authenticated XHS userId replaces the displayed account number for new collection; historical directories remain without nickname-based merging. Failed or uncertain reads preserve history. Explicit non-reasoning models disable implicit effort only when the model is known; unspecified existing sessions retain their policy. HTTP delegates metadata interpretation to OpenClaw.

Core backend checks: 232 passed. Frontend checks: 67 passed; lint and production build passed with existing warnings. Additional installer checks: 27 passed, and one timing-sensitive test passed on its final isolated retry after two loaded runs failed. The actual pinned OpenClaw 2026.9.6 type definitions support all seven offered formats.

Automation uses temporary data, real OS contention and PowerShell expressions, and simulated React DOM. Platform login/collection, model requests, clean installation and browser visual acceptance remain separate. No local 7880 replacement, 138 activation or installer release occurred. Main receives documentation only; C–F remain later batches. The previous 0.2.8 deployment is recorded separately; OpenClaw remains pinned to 2026.9.6.
