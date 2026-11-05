# 0.46.1 · 长任务等待、对话图片与通知标题

## 现场事实与纠正

138正式0.45.9问题2f919b69发生于2026-11-04 09:07:36 UTC（北京时间17:07:36），整轮96.9秒，终态为Easel合成的请求恢复停止诊断。相邻恢复审计在09:07:34记录attempt=0、provider_response_deadline、elapsedMs=90000；审计缺会话/轮次ID，只能按时间关联，不能宣称其requestId已直接关联原轮次。源码确认恢复层对包含所有流事件的完整模型响应设置90秒硬截止，修复阶段120秒也受该截止压制。没有证据证明该轮已重试或供应商返回524，usage=0不证明没有处理或计费。

取消该策略：恢复层不再设置整次响应或修复响应总截止。默认600000ms没有可观察模型流事件才中断本地等待，沿用现有渠道600秒默认，非性能承诺。文字、思考、工具增量及终态会续期，适配器合成start不续期。SDK未暴露的网络心跳不算可观察模型活动。EASEL_MODEL_STREAM_IDLE_TIMEOUT_MS可配置0–7200000，0关闭本层空闲检测；无效配置回到默认。外层聊天TIMEOUT_CHAT=7200秒、原生渠道/传输限制、用户取消仍有效，不承诺无限运行。

本地空闲使用model_stream_idle_timeout；供应商明确504/524使用model_provider_timeout。旧Easel request recovery exhausted文字本身改归model_recovery_stopped，不从历史模糊文本伪造原因。只有精确504/524且没有任何输出/工具片段可同上下文有限重试一次；空闲中断不重发。工具参数仍私有消费、完整校验后派发，完成工具指纹防重放与停止闸门保留。

## 官方实现对照（2026-11-05读取固定源码）

检索路径为官方文档/仓库；网页搜索无可用正文后，用GitHub CLI读取官方仓库固定SHA，并仅以实际源码做结论。OpenAI部分遵循openai-docs技能；不调用真实模型。

| 来源 | 实际设置和边界 | 本项目采纳 |
| --- | --- | --- |
| [Codex provider source](https://github.com/openai/codex/blob/c90354172c5c49535b122443e9a8ed52c2233b80/codex-rs/model-provider-info/src/lib.rs#L72) | DEFAULT_STREAM_IDLE_TIMEOUT_MS=300000；WebSocket连接默认15000ms，配置字段分别定义连接与stream idle。不是整项Agent任务5分钟结束。 | 区分连接、流事件空闲和外层任务生命周期，持续活动续期。 |
| [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript/blob/3cde979dcebea3450c508f7afc71315be09bf99a/src/client.ts#L1807) | DEFAULT_TIMEOUT=600000；fetchWithTimeout围绕底层fetch，返回后clearTimeout。不能直接解读成Claude Code整项任务上限或SSE全生命周期。 | SDK/HTTP请求超时与Agent任务分层，不能把SDK默认值当作任务截止规范。 |
| [DeepSeek Super Agent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/executor/dsh.ts#L27) | prepare命令10分钟，worker回合结束后的后台任务另有30分钟收尾限制，结合host lifetime取消；不是LLM完整响应短截止。 | 按执行阶段和持久状态管理恢复，不无界重放，也不把准备超时当推理超时。 |
| [用户提供的架构解读](https://github.com/StarrySea1412/agent-orchestrator/tree/a30e323c7beca415e814e2842094414ab3f51325) | README明确为原型只读解剖。 | 用于定位官方原型，超时结论以官方源码为准，不引入外部运行时或声称架构等同。 |

## 图片与通知

原会话mw2x8ffl1yszmh、轮次1793845432626-iywnwz5g3r的图片先在outputs目录被view_image允许目录规则拒绝；复制后识图请求等满60000ms失败。两者是不同阶段，文件已生成并交付，不能称生图失败。原图与归档副本同为1655260字节，SHA256=6d8b67909e4e7a2a9817dfaf86d8c95899b3cbb27a7f14e38bef0e6f4e0d1305。原任务没有重放。

新增只读注册表归属检查，已交付当前会话的outputs真图可暂存到原media允许目录；限制20MiB、拒绝符号链接、校验读前后状态和图像格式，原子落盘，不扩大访问权限、不新增交付或生图。5秒仅限制本地文件准备子进程，不用于模型推理。识图服务超时仍需人工核对视觉质量，不能根据文件名猜图。

图片任务卡片整图contain展示，标题、文件大小和状态清晰；提示词可展开，添加对话/用于发布仅操作草稿，下载/刷新独立。有pending和组件归属保护。仅已验证64位内容SHA、相同会话/轮次/状态的副本合并；不靠名称/大小猜测，也不改旧资源version。旧记录只刷新可见小批文件元数据，不发模型请求。

通知标题原由后端写死为对话，覆盖前端已有标题；会话真实标题仍在conversation_snapshots。新通知和历史列表投影只读真实title，保留原ID、时间、已读和删除状态，缺元数据时显示对话加ID后六位；不读取消息正文生成名称。

## 验证与部署状态

本批候选0.46.1：源码/合成、真实SDK本地SSE、138隔离/正式、HTTPS及真实浏览器证据分别补记。真实付费模型、识图服务、小红书发布和长期业务稳定率不在本批自动重放验收内。

本地相关后端组合122项、前端/恢复JS组合88项通过；生产build、lint（既有warning）、Python编译和diff检查通过。138隔离容器固定真实SDK使用回环SSE服务：7类格式/截断/504/524恢复矩阵，长思考/文字/工具增量及卡住的未校验调用均通过，共25项顶层检查；并非真实供应商验收。适配器只有明确启用reasoning才发出thinking事件，测试已按实际调用语义设置，不能以网络收到但SDK不暴露的片段续期。

既有0.46.0已在138隔离激活：31d56085e3de，image sha256:f438966a3c29a5de8a43a6cdc4d5a4b268dcfe0ebcaa7bd73cc12c07b31b7334；1752源码、70资源哈希与认证/网关/健康通过。正式仍0.45.9，待0.46.1完成隔离后一起升级。0.46.0全量前端执行至318项主动中断，不能称全量通过。
