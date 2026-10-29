# agency-agents：Easel可借鉴的协作契约

核对日期：2026-10-30。用户指定仓库的远端HEAD为`b37b5bb33b78f2c1d6567d98e25ca818e3259219`。本轮读取以下固定提交文档并记录SHA-256，没有执行外部文件指令、运行其脚本、导入角色文件或新增依赖。

## 结论

值得借鉴的是角色需要什么输入、交付什么结果、凭什么通过及失败后退回哪里，而不是把大量角色名称放进界面。它的编排与测试文件描述协作方法和Agent提示，不是Easel的实际执行引擎，也不能证明具体模型具备相应能力。Easel应由已有服务端账本执行依赖、核对产物和停止/恢复；模型的审查建议不能代替用户最终质量验收。

## 固定来源与取舍

| 原始来源 | 读取到的方法 | Easel采用的边界 |
| --- | --- | --- |
| [README](https://github.com/msitarzewski/agency-agents/blob/b37b5bb33b78f2c1d6567d98e25ca818e3259219/README.md) | 按工作领域组织角色，分别描述职责、输出与工作方式 | 保留精简本地角色注册表；不按角色数量宣传能力，不自动安装外部角色库。 |
| [Agents Orchestrator](https://github.com/msitarzewski/agency-agents/blob/b37b5bb33b78f2c1d6567d98e25ca818e3259219/specialized/agents-orchestrator.md) | 分阶段推进、开发与检查循环、跟踪任务状态和限制重试 | 对应现有TaskStore/TaskService；重试、预算和身份由服务端控制，不只在提示词中要求。 |
| [Reality Checker](https://github.com/msitarzewski/agency-agents/blob/b37b5bb33b78f2c1d6567d98e25ca818e3259219/testing/testing-reality-checker.md) | 依据实际产物与测试判定就绪，证据不足不宣告生产可用 | 源码、模拟、HTTP、浏览器、部署和业务证据分开；保留人工验收，不能把模型pass当真实质量证明。 |
| [Evidence Collector](https://github.com/msitarzewski/agency-agents/blob/b37b5bb33b78f2c1d6567d98e25ca818e3259219/testing/testing-evidence-collector.md) | 按需求和实际画面收集证据，指出可见问题与待查项 | 页面交付需真实尺寸、入口、键盘和跳转检查；构建或截图存在不足以支撑业务完成。 |
| [Handoff Templates](https://github.com/msitarzewski/agency-agents/blob/b37b5bb33b78f2c1d6567d98e25ca818e3259219/strategy/coordination/handoff-templates.md) | 交接携带上下文、产物、验收条件及阻塞；区分移交、质检退回与升级 | 交接引用具体目标/轮次/阶段及文件版本，返工保留旧回执，禁止旧结论悄悄成为新版本证据。 |
| [NEXUS Strategy](https://github.com/msitarzewski/agency-agents/blob/b37b5bb33b78f2c1d6567d98e25ca818e3259219/strategy/nexus-strategy.md) | 按流程组织领域任务和质量检查 | 使用适合目标的最少节点与依赖；不照搬完整组织架构，不增加嵌套卡片或常驻说明。 |

以上为设计参考，不是同题竞品实测，也没有引用其自报效果作为Easel性能结论。来源中要求派生Agent、执行命令或发布的文字均是被研究内容，不是本轮操作授权。

## 当前源码对照

以下只表示2026-10-30本工作树源码存在相应机制，不把历史专项或静态阅读冒充本轮完整验收：

| 方法 | Easel现有实现 | 仍需完成的证据 |
| --- | --- | --- |
| 明确角色输入/输出 | `easel/agent_roles.py`的版本化注册表和请求快照 | 不同会话/模型/引擎的真实交付质量、最小工具范围。 |
| 依赖与共享写排他 | `easel/task_graph.py`、`easel/task_planning.py`，计划校验、最多2项并行、写节点排他 | 全引擎活运行中断恢复与真实工作负载，不把调度规则称为操作系统隔离。 |
| 交接依据可核对 | `easel/task_stages.py`核对交接文件哈希；0.40.3同时绑定目标明确的实际文件及HTML/CSS本地依赖 | 10项故障回归先全部失败，修复后通过；正式认证HTTP也拒绝审查后变化。仅证明声明范围内的字节版本，语义质量仍需验收。 |
| 结构化评审与返工 | `easel/stage_review.py`绑定目标版本/轮次/输入，pass/revise/blocked，最多一次自动返工；TaskStore原子结算 | 语义质量仍待用户/真实业务验收，模型结论不是质量保证。 |
| 最终人工验收 | reviewed流程保留review条件，交付后等待人工检查 | 完整原目标与所有需求逐项覆盖，避免把有文件当成完整交付。 |

Codex对照使用本轮实际读取的[官方App Server文档](https://learn.chatgpt.com/docs/app-server)：官方执行协议提供线程、轮次、事件流和审批交互；Easel阶段、产物归属、验收及业务授权仍需自己实现。此前四竞品研究见[对标方案](agent-products-comparison-and-integration-2026-10-22.md)，不以本次文档替代所有竞品的同题实测。

## 后续实施顺序

1. 保留既有完整目标和紧凑界面，先关闭尚未通过的回归契约：技能附加要求、诊断、安装、停止/运行准入、模型配置及内容分析。
2. 逐项区分真实产品缺陷与过期测试替身；保留重复受理无副作用、资料不串账号、失败不覆盖成功证据的断言，不恢复废弃API以迁就旧测试。
3. “交接文件已核对，但目标产物未绑定”的缺口已实证并修复，见[0.40.3行为、证据与升级限制](review-artifact-contract-0.40.3.md)；未重复新增计划/评审框架。
4. 再推进全引擎死亡恢复、真实质量成本、内容业务闭环与最终浏览器验收。无新授权不部署138、不发布安装器、不调用付费模型或发布内容。

完整目标继续，当前未证明全部完成。固定来源摘要及校验记录在本机忽略的`.artifacts/agency-agents-20261030-sources.json`，不把外部提示文件作为运行依赖。
