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

0.46.1已部署138隔离与正式实例。功能源码为3399cdfee1b566244637aae2f8137ca32d0989bf，已推送用户远端；后续纯文档提交不改变运行构建身份。真实付费模型、识图服务、小红书发布和长期业务稳定率不在本批自动重放验收内。

本地相关后端组合122项、前端/恢复JS组合88项通过；生产build、lint（既有warning）、Python编译和diff检查通过。最终Linux固定镜像的真实OpenClaw SDK使用本地回环SSE服务，26项检查全部通过、无跳过：格式畸形/截断/参数schema/流关闭/恢复后再失败/524一次及持续失败，长思考/文字/工具增量续期，卡住的未校验调用不派发，取消与重复副作用保护。95秒静默首响应采用虚拟时钟验证，没有真实等待95秒或调用供应商。适配器只有明确启用reasoning才发出thinking事件，不能以SDK不暴露的网络片段续期。最终镜像也验证真实PNG暂存、会话归属、重复读取与符号链接父目录拒绝。

0.46.0全量前端执行至318项主动中断，不能称全量通过；本批相关组合通过也不代表全仓测试通过。

### 固定发布与正式身份

| 项目 | 实际核验值 |
| --- | --- |
| 产品版本 / 运行提交 | 0.46.1 / 3399cdfee1b566244637aae2f8137ca32d0989bf |
| app与browser镜像 | sha256:8f7dc34d11048fca0318ac1b019e73c9991ce9f847308d45583d04ac27cdfeb6 |
| 发布目录 | /home/ubuntu/easel-releases/Easel-138-3399cdfee1b5 |
| 隔离激活 | 2026-11-05 03:46:31 UTC |
| 正式激活 | 2026-11-05 03:53:54 UTC（北京时间11:53:54） |
| 正式入口 | https://192.168.0.138:8444/ |
| 配置实读 | EASEL_MODEL_STREAM_IDLE_TIMEOUT_MS=600000 |
| 清单 / 运行源码 / 前端资源 | 2304项发布清单、1758项运行源码SHA、70项JS/CSS字节SHA一致 |
| 认证与就绪 | 保留内网测试账号；登录通过、匿名version接口401、Gateway=true、runtime=openclaw、7个角色含repair |
| 容器 | app/browser健康且重启0；proxy运行，HTTPS可达（未配置独立容器healthcheck） |

最终镜像以已构建的075295ca候选为基底：基底镜像sha256:efd0b4a0029163b50af55036186be4f30533d956e828148c599fe0de0aa10a9f；清单确认仅image_inspection.py及其测试变化后覆盖这两项、重新安装并标记3399cdfe。image-build-receipt.json记录verified-two-file-source-overlay；完整运行源码哈希已重新核验，不把复用镜像层当成未经检查的源码一致性。

### HTTPS与真实浏览器

- 隔离及正式的HTTP验收使用显式受信CA，验证HTTPS登录、版本、网关与全部前端资源字节。浏览器在服务器sidecar中新建独立context，通过内部proxy别名路由；该别名不在证书SAN中，浏览器忽略其证书错误，因此浏览器记录不能替代前述CA信任检查。未控制用户电脑或复用平台登录context。
- 正式浏览器实际登录成功，打开事件通知并检查69条对话完成通知，泛化“对话 · …”标题0条；关闭通知后设置入口正常。只验证这些入口，没有把其他菜单记作通过。
- 隔离库缺少可用图片会话，创建了明确标注“合成PNG，非模型生成”的720×960夹具，两份同图文件合为一张任务卡；整图加载、原图200 image/png、下载200 attachment、添加对话草稿、用于发布草稿与素材出现、键盘Enter刷新成功、390×844无横向溢出均通过，桌面与窄屏截图已目视核对。未点击发送或发布，未在正式库写入图片夹具。
- 浏览器脚本首次以networkidle等待页面，在持续网络活动下超时，改用页面元素就绪后通过；结束时出现过Playwright路由取消诊断，最终正式脚本退出0且业务断言已完成。该测试辅助诊断不隐藏，也不能当作模型或产品稳定性证明。

### 备份、回滚与未完成边界

正式切换前检查没有queued/running/unconfirmed聊天或活跃自动化任务，停写快照保存为/home/ubuntu/easel-backups/20261105T035148Z.tar.gz。Easel.previous与previous-deployment.json保留原0.45.9 / 7688c07db8f5cc88fc7452a31014cc7aa2011a3a，镜像sha256:68d062a55d2466dc33733b22ab6ec5ee7fd273968695010bcd0d60a811f5f59a。既有manage.py rollback恢复记录的代码与固定镜像，保留当前data/state；快照数据恢复是独立操作，未在正式实例演练回滚。切换后根盘约21GiB、Docker/containerd盘约13GiB可用。

原模型失败、图片生成和发布任务均未重放；真实供应商可用性、识图质量、原任务连续完成及长期业务成功率仍未建立。用户最终验收和新安装器发布未完成。本次修复不承诺无限运行，也不声称复制了DeepSeek的完整运行时。
