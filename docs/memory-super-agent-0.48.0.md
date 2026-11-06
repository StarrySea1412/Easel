# 0.48.0 · 记忆排序与 Super Agent 续跑收敛

## 本轮结果

独立分支 `codex/super-agent-memory-0480`，基线 `9e528858`（0.47.0）。
源码增加确定性词法排序和无进展续跑停止；不代表模型推理能力或线上稳定性已经得到业务验收。

### 记忆

- 仅有效、来源仍可用、画像/平台/账号匹配且字面适用条件成立的条目进入候选池。BM25 的文档频率也只使用该池，其他账号的内容不影响排序或分数。
- 排序采用 NFKC、英文大小写归一化、英文词和中文双字片段、BM25（k1=1.2、b=0.75）。相较纯交集计数，常见词权重降低，词频饱和与长度归一化减少长条目堆词优势。相同分数按条目 ID 稳定排序。
- 全角 `ＧＰＴ ＲＥＳＰＯＮＳＥＳ` 可召回 `GPT responses`；没有词汇交集的同义改写仍可能漏召回。这不是 embedding、向量库或通用语义检索，也不扩展用户设置的字面条件。
- 默认仍最多8条，保留字符、估算token与整轮提示预算、读取开关、来源失效、用户确认和准确版本绑定。空查询维持历史的ID顺序。
- 召回/使用记录新增算法标识及每个入选条目的ID、版本、相对排序分与匹配项数，不新增查询原文或正文副本。分数只作同一候选池内排序，不是置信度或事实可信度。
- 现有“读取范围与迁移原文”预览及“本对话使用的经验”展示匹配项数；旧轮次没有新回执时保持兼容。实际引用不保证模型采纳。

### Super Agent

- 保留同会话、原模型、独立幂等键、最多2次、文字轮次且完整操作审计为空才自动接续的规则。
- 仅在原本准备自动接续时比较可见非错误文本。连续/循环返回相同内容（NFKC、大小写及空白归一化）便停止，返回 `continuation_no_progress`，保留输出且不标记正常完成。
- 正常终态重复引用文字不误判；空输出的已确认idle/length仍受原来的次数上限管理。检测不能识别所有换句话说的空转，也不是任务完成证明。
- 可中断退避后再次检查总时限；耗尽则返回 `continuation_deadline`，不再构造下一次请求。用户停止继续优先。
- 宿主停止原因优先于之前的模型length元数据，避免错误界面把无进展误报成另一轮触顶。两种情况均不自动重试。

## DeepSeek Harness 对照

官方仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。本轮拉取固定提交
`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，稀疏检出以下源码/文档，不执行第三方安装或脚本。

- [compaction-basic index.ts L213–256](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-basic/src/index.ts#L213-L256)：只有 `replaceGeneration` 真正增加才恢复上下文溢出；取消与重试预算优先。本轮借鉴“没有变化就不继续请求”的原则，Easel检测的是输出重复，不能等同DSH的持久上下文代数证明。
- [agent-loop agent.ts L253–258](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts#L253-L258)：`whenIdle` 会跟随活动句柄变化等待，不能用一次返回冒充全部活动结束。
- [jobs.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/jobs.md)：`job/settled` 可能晚于 `turn/end`，缺少结算记录仍是不完整。Easel保留既有 completed/settled/resourceSettled 的分层，不新增未知任务重放。
- [compaction.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/compaction.md)：短期上下文压缩与Easel的用户确认长期经验是不同职责；本次没有把压缩摘要自动变成用户事实。

DSH使用MIT许可，版权归DeepSeek。本轮仅参考设计，未复制实现、引入其运行依赖或改造整套插件框架；BM25为Easel独立实现。没有同任务模型基准，因此不声称性能超越DSH。

## 验证与发布边界

- 后端相关回归187通过、1跳过（主机未授予符号链接创建权限）；覆盖归一化/排序、账号统计隔离、字面条件、预算、来源失效、确认、提案形成、版本绑定、续跑重复/时限/停止与精确终态回执。
- 前端记忆/接续定向25项通过；生产build通过；lint无错误，存在未改动文件的既有warning；Python编译和git diff --check通过。未执行全仓所有测试；构建仍有既有大chunk提示。
- Chromium真实浏览器：经“更多→画像”及创作画像选择进入，验证全角查询、真实本地记忆context API、列表与预览匹配说明、菜单键盘、预览键盘，以及1440px/390px展示；390px无横向溢出。另从隔离合成对话“新增面板→来源”核对usage接口的准确版本匹配说明及历史正文展开。
- 浏览器数据为明确隔离的合成画像/对话，不是生产会话或模型结果。初始OpenClaw未配置导致状态探测影响画像加载，验收时将仅本地隔离实例切至未配置的Qizhi运行器；未连接远程Qizhi或发送聊天。无管理员认证系统，未新增账号。
- 本轮不读取生产记忆、不调用付费模型；未验证长任务真实模型效果、线上记忆质量或全部菜单。没有以本地HTTP/浏览器验收替代138业务验收。
本轮没有修改主工作区的图片重试内容，没有部署138或发布安装器。

部署准备：产品与前端统一为0.48.0；无新增依赖、数据库迁移或配置项。后续部署应使用本分支完成合并后的构建，先保留在途任务和现行回滚版本，再分别核对源码SHA、镜像/构建身份及138运行版本。旧回执仍可读取；回退不会改写已确认的经验正文。主分支仅同步文档入口，功能代码不自动合入。

## Git交付

功能代码提交 `970dcddb641802de27cee5cdfab545000d0d2767` 已推送 `starry/codex/super-agent-memory-0480`，远端SHA一致。默认main仅更新中英文首页入口，文档提交 `6830edfbc0da954c9e526debc4c3e76050638713` 已推送并核对远端SHA；没有将功能代码合并main。本节后续记录提交仅更新交付回执，不改变0.48.0实现及验收范围。
