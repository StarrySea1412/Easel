# Grok Bot、DeepSeek Harness、Codex、ZCode：后续优化

调研日期：2026-10-17。基线为 Easel `98e352e9`。目标输入区、对话运行计数、完成/失败 Badge 已交付，不重新引入设置弹窗。本轮阅读公开文档与固定源码，没有安装竞品、付费请求或同任务性能对比。

## 实际读取的来源

| 产品 | 本轮证据 | 对 Easel 的启发 |
| --- | --- | --- |
| Grok Bot | xAI [产品说明](https://docs.x.ai/grok-bot/overview)、[聊天与协作](https://docs.x.ai/grok-bot/chat-and-collaboration) | 这里是独立长期 Bot 产品。工具活动、文件、问题、审批进入会话；直接用户指令能调整方向，停止不撤销已发生的动作；多 Bot 需要阶段负责人，不能只追求数量。公开文档不披露其调度内核，也不能据此断言速度更快。 |
| DeepSeek Harness | 本轮 `git ls-remote` 取得 HEAD `1517a4dbca0a2789ff1d41ba439600f8547d23fa`；实际读取固定版本 [README](https://github.com/deepseek-ai/deepseek-harness/blob/1517a4dbca0a2789ff1d41ba439600f8547d23fa/README.md)、[Core](https://github.com/deepseek-ai/deepseek-harness/blob/1517a4dbca0a2789ff1d41ba439600f8547d23fa/docs/subsystems/core.md)、[持久化](https://github.com/deepseek-ai/deepseek-harness/blob/1517a4dbca0a2789ff1d41ba439600f8547d23fa/docs/subsystems/persistence.md)、[Jobs](https://github.com/deepseek-ai/deepseek-harness/blob/1517a4dbca0a2789ff1d41ba439600f8547d23fa/docs/subsystems/jobs.md) | append-only 会话事实、单写者及 flush 屏障；`job/settled` 可能晚于 `turn/end`，轮次结束不等于后台资源都结束。仍是 developer preview，不将格式当稳定协议。 |
| Codex | 通过官方域名搜索后实际获取 OpenAI Docs [App Server](https://developers.openai.com/codex/app-server)、[Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) | 线程/轮次/结构化工具分离，`turn/interrupt` 回应后仍等待 `turn/completed`；目标在空闲安全边界续跑，用户输入和中断优先；续跑轮无工具调用则抑制再次自动续跑，完成以实际证据判断。动态工具为实验接口。 |
| ZCode | 重新读取[目标模式](https://zcode.z.ai/cn/docs/goal)；本轮 HEAD 仍为 `aac4755666d09fdcd70272fcf063c077a639015f`，读取[独立验收](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts)、[续跑循环](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/methods/target-continuation-loop.ts) | 当前会话目标、逐轮独立检查、停止/恢复屏障值得参考。验收异常存在 fail-open 取舍；Easel 保持失败或证据缺失时不完成，不照搬异常通过。 |

GitHub API 匿名限流后使用 `git ls-remote` 核实提交、按固定 SHA 读取 raw 文件。官方页为当天快照，源码证据只对标明的 SHA 有效。研究快照留在忽略目录 `outputs/harness-followup-2026-10-17/`。

## 当前项目的真实差距

| 方向 | 已具备 | 还需要跟进 | 顺序 |
| --- | --- | --- | --- |
| 目标完成与空转 | SQLite 目标/运行、模型冻结、停止屏障、实际文件及依赖核验、人工质量确认、有限轮次 | 当前指纹混入整段输出哈希、步骤标题/说明，换措辞会重置无进展计数；重新核验未检查原运行是否成功，失败轮有被标完成的可能；缺少无工作工具续跑抑制 | **本轮 P0 实施** |
| 任务归属及恢复 | run ledger、后台任务会话投影、未知不重发、图片未知占位、会话状态 Badge | 普通消息尚未全部迁入服务端；跨运行器的持久事件/压缩/后代资源结算尚未统一，Codex 重启对账仍有缺口 | P0 后续，先契约与故障演练 |
| 工具与产物 | `easel_present`、`easel_generate_image`、原轮次产物、内容/依赖版本刷新、持久图片队列；Codex 已有对应宿主 handler | 真实模型全链路、HTML 隔离联网、模型视觉能力不符时的专门验收仍需补齐；不再将已实现 present 列为缺失 | P1 |
| 可控提速与成本 | 显式启动模型、配置变化阻断、轮次/时间/工具/图片限额、图片通道并发、实际用量计量 | 自动目标串行、目标内禁止子 Agent；没有 Token/金额逐请求硬准入。需在真实路由、子任务归属与费用预留完成后再开放有界并行，不默认调用昂贵模型 | P1，独立实施与真实费用验收 |
| 执行中调整方向 | 人工接管时暂停续跑，明确停止及未确认状态 | 尚无 Grok Bot 式执行中可靠 steering；不能把普通消息发送到第二个并发 run 冒充中途指导 | P1 |
| 调度和验收体验 | 原输入区设目标、真实步骤面板、计划/漏跑/历史、人工质量验收、悬浮改名 | 目标简短生命周期命令、独立语义验收、长期任务及运营指标仍需各自验证；不新增高门槛表单 | P2 |

研究结论：优先补“为何继续、何时停、凭什么完成”，再开放并行和更多自动动作。不能由竞品功能列表推断我们的速度、成本或实际质量。

## 本轮实施与验证

已实施以下修复：

- **进展指纹**：保留完整输出哈希供审计，但未通过的文字验收项不再因回答换措辞而成为新进展；步骤改标题、改说明、新增待办不重置无进展判断。文件及依赖版本、文字项通过状态、稳定ID的已完成步骤仍参与判断。助手报告步骤完成依然不代表质量通过。
- **无工作工具续跑抑制**：每轮由可信工具准入记录累计 `workTools`，重复准入不重复计数，拒绝的调用不计入；`easel_goal_update` 和 `easel_task_guard` 不算工作工具。初轮可以规划，后续轮若未达到交付/待人工验收条件、又没有工作工具准入，转为 `blocked / no_progress`，不继续请求模型。纯文字目标已经满足全部标准时可正常完成。旧运行缺少该字段时保留未知，不倒推为零；工具准入次数也不冒充执行成功。
- **验收完整性及来源**：校验全部标准的类型、标签、值与状态，缺项不放行；人工确认必须绑定当前成功结束且版本一致的轮次。失败、停止、未知或旧轮次不能通过重新核验标成完成，验收错误阻塞并撤销质量确认；工作轮自报质量通过也不替代用户确认。
- **目标界面隔离**：真实隔离浏览器发现目标A的错误可能留在目标B面板，已按目标ID重建面板；迟到的操作错误及等待态不污染另一目标。

| 验证层次 | 本轮实际结果 |
| --- | --- |
| 漏洞复现 | 新增后端回归在修改前8失败/2通过，覆盖换措辞、失败/停止轮验收、遗漏质量项、验收异常、无工具空转和计数；修复后通过 |
| 后端组合 | 目标、原生工具hook、图片任务、产物、run账本及恢复共66项通过；从暂存源码完整导出后同组66项再次通过，排除原未提交预算/Gateway改动；不调用模型 |
| 前端 | 输入区目标、列表Badge/导航/悬浮及目标延迟错误隔离共59项通过；TypeScript/Vite构建通过，lint零错误/18条既有warning，大chunk提示保留 |
| 隔离7894真实浏览器 | 真实组件、任务API和临时SQLite，执行器模拟：输入区启动→第2轮无工作工具阻塞→运行数1→0；失败轮重新核验显示409原因并保持失败Badge；切换目标清除旧错误；正常交付人工验收后Badge变已完成；刷新恢复并默认折叠侧栏 |
| 本机7880 | 只读检查真实列表0运行/完成标记、原对话及暂停队列仍在；未启动用户任务、未重启该后端进程。本轮新后端逻辑在隔离服务验证，不能宣称7880已经热加载，需空闲时正常重启后生效 |

本轮没有改布局或控件样式；390px浅深色及完整键盘验收沿用上一轮明确记录的范围，不冒充本轮全站复核。隔离截图位于 `outputs/harness-followup-2026-10-17/review-and-badges.png`。功能交付开发分支，main仅同步中英文首页；最终远端SHA在交付时核对。

## 保留的未完成事项

Codex 目标与重启恢复、完整普通消息服务端持久化、独立语义/视觉验收、目标并行与硬费用准入、真实长期效果/账单、新闻检索质量、OCR/视听/多作品拆解和运营指标继续保留。138 与安装器未更新，旧未提交预算/Gateway 工作不混入本轮提交。前述设计不等于以上能力已实现。
