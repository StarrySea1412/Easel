# Agent loop 对照、实际缺口与0.45.3

2026-11-02，承接用户“多调研这些agent loop，然后好好修”。0.45.2已更新138正式及隔离；本次继续核对完整循环并实施兼容修复，不把框架介绍当作稳定性验收，也不替换当前默认OpenClaw引擎。前次畸形参数研究及0.45.1/0.45.2是本次基础。

## 结论与实际改动

目前仍应监督使用，尚无代表性运营任务成功率。与成熟执行器的主要差距在于：各层恢复的状态与预算没有完全对齐，工具执行后的业务验收不够完整，真实故障样本回归不足。继续添加界面或在整个对话外包一层重试不能解决这些问题。

本次发现并修复一处确定的状态错误：Codex App Server的`error.willRetry:true`表示原轮次内部继续重试；Easel此前直接存入`state.error`，后续原生`turn/completed:completed`也没有清除。于是模型恢复成功，页面仍可能显示失败、写入失败诊断、发送失败通知。

0.45.3将这类通知记录为可回放的过程活动，原生完成/中断回执清除过时错误，真正失败保留具体原因。连接丢失仍是`unconfirmed`，不能推断完成。没有新增模型重试，也不重发`turn/start`或已完成工具。这个补丁针对可选Codex适配器；138默认仍是OpenClaw，不能说它解释了用户此前所有DeepSeek失败。

## 实际读取的循环

以下为固定源码的实现事实，未运行上游完整测试，不是各产品成功率排名。

| 实现 | 完整循环中实际采用的机制 | 对Easel的直接意义 |
| --- | --- | --- |
| DeepSeek Harness | 轮次包含步骤，每步中的失败模型请求可在相同turn/step内恢复；成功assistant消息落日志后才派发工具。`max-tokens`直接结束该步，不执行其中工具 | 模型请求恢复不能变成整轮业务重播；预算终止必须保留原因 |
| Harness持久化/重试插件 | 取得会话写所有权后恢复；中断历史补缺失工具错误及step/turn闭合。重试先追加`llm/retry`，可取消退避后追加`llm/retry-started`；按provider策略计数 | 恢复日志和单一执行所有权必须先于新派发；“补错误闭合”不能当作工具成功，更不能补执行副作用 |
| Vercel AI SDK | 先解析/校验/执行工具，将结果加入下一步消息；客户端调用的结果或拒绝数不齐就停止续步。每步检查停止条件和取消；模型请求重试与多步循环分开 | 要区分工具调用发出、已受理、结果已回、业务完成；步数限制不等于HTTP尝试数限制 |
| PydanticAI | 输出校验重试、每工具重试、request usage限制分层；`length`的残缺工具参数独立报错。一个请求步骤的模型attempt还有独立后备上限 | 上下文压缩、请求重试和工具重试不能共享一个含糊的“再试一次”；费用要覆盖所有attempt |
| Codex App Server | thread、turn、item各有身份；中间`error.willRetry`不打断turn；最终`turn/completed`带completed/interrupted/failed。中断请求与最终中断回执分开 | 页面不能把过程错误当终态，或把断流/interrupt RPC成功当作资源结算 |
| 138实际OpenClaw 2026.9.6 | 内层runLoop可流式派发工具，使用已执行ID避免终帧再次派发；provider失败不派发剩余调用。外层还有attempt、空错误恢复、failover、compaction及run retry预算 | 插件before_tool_call太晚，畸形调用必须在stream/适配器边界处理；外层恢复不能与内层参数修复相乘 |

### DeepSeek Harness固定源码

固定`ce7073d51254c26cd63b22a60835b8f948deb447`：

- [agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/agent-loop/src/agent.ts#L479)：失败attempt单独落日志，经`agent/request-error`决定是否在当前step继续；恢复决定后再次检查取消。合法assistant消息落日志后再读tool-call；`max-tokens`提前返回。
- [恢复写所有权](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/agent-loop/src/index.ts#L789)：先open write handle，再读取并追加interruptedTurnClosers；未拿到所有权不运行第二个会话执行器。
- [重试执行器](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/llm/llm-retry/src/index.ts#L184)：持久重试及可取消等待；`Retry-After`超过maxDelay时普通策略放弃。源码提供always模式，运营场景不采用无限重试。
- [请求错误回归](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/agent-loop/tests/request-error.spec.ts#L54)：相同turn/step、多次请求错误后成功、取消优先、恢复监听器失败不再重试。

### Vercel与PydanticAI固定源码

- Vercel `ad09bc1c55e9c2ad224d17008013a32e79b8ea82`：[shouldStartNextStep](https://github.com/vercel/ai/blob/ad09bc1c55e9c2ad224d17008013a32e79b8ea82/packages/ai/src/generate-text/generate-text.ts#L964)核验结果/拒绝数量与客户端工具调用数量相等，检查stopWhen；下一步使用已保存的response messages，汇总各步usage。SDK不自动替应用提供跨进程持久账本或图片费用对账。
- 同版[parseToolCall](https://github.com/vercel/ai/blob/ad09bc1c55e9c2ad224d17008013a32e79b8ea82/packages/ai/src/generate-text/parse-tool-call.ts#L59)只有配置repair回调才修复，修复结果再次校验；不证明它会对任意错误自动重试。
- PydanticAI `129c94ef2940565af3bc9f638196fcc994d1ed4d`：[_agent_graph.py](https://github.com/pydantic/pydantic-ai/blob/129c94ef2940565af3bc9f638196fcc994d1ed4d/pydantic_ai_slim/pydantic_ai/_agent_graph.py#L446)区分request steps与attempts，100是防止能力插件死循环的后备限制，不是推荐重试值；[截断与输出重试](https://github.com/pydantic/pydantic-ai/blob/129c94ef2940565af3bc9f638196fcc994d1ed4d/pydantic_ai_slim/pydantic_ai/_agent_graph.py#L829)保留单独终止原因；[请求前usage检查](https://github.com/pydantic/pydantic-ai/blob/129c94ef2940565af3bc9f638196fcc994d1ed4d/pydantic_ai_slim/pydantic_ai/_agent_graph.py#L2956)在进入wrapper前执行，缓存也不能绕过步骤限制。

### Codex官方契约与源码

实际读取[OpenAI官方App Server文档](https://learn.chatgpt.com/docs/app-server)的Core primitives、Turns、Turn events、Errors、Dynamic tools等节。`thread/resume`、`turn/steer`、`turn/interrupt`用途不同；终态由`turn/completed`确认，工具过程由item事件记录。WebSocket过载`-32001`建议指数退避加抖动，这不是业务重播指令。App Server/WebSocket为实验能力，不据此盲目更换生产默认引擎。

固定Codex `a09812981de703f18f38015cd5d500ab373f616c`的[ErrorNotification](https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/app-server-protocol/src/protocol/v2/notification.rs#L62)明确注释：`will_retry`为true时是瞬时错误，由app-server自动重试，不中断turn。这是本次修复的直接依据；未从官方Errors节缺少的字段臆造语义。

### 138原生循环的现场证据

从本批固定镜像`95556a75c6b8…`只读取得实际发行文件，无密钥或用户消息：

| 文件 | SHA-256 | 本次实际核对位置 |
| --- | --- | --- |
| agent-core-DG5aPUnb.mjs | 96221c65ea8e15d6499ca9f817e5d7629151b42c6d9742000791f2f48f2cebcd | runLoop约470行；工具流式及终帧去重约549–558行；取消与provider失败约583–630行 |
| embedded-agent-BaH7wGBd.mjs | e3cf2c540ae617a766b7f78f56ed252b233839b1f9cf8eef6d7ff8ef37829dd6 | silent error恢复约2042行；retry预算约7921/8010行；attempt及终态重试分支约8135–8334行 |

发行包拆分文件名属于版本证据，不写进业务代码作为稳定API。Easel仍使用provider wrapStreamFn公开扩展点。0.45.1将目标渠道的工具响应先私有消费、完成schema/终态/大小检查后派发，专门阻止原生流式阶段提前执行残缺调用；一次修复共享当前prepared runtime预算，并用非空失败回执阻止额外silent-turn恢复。这不是全渠道统一重试协议。

Grok Bot和ZCode公开资料的证据边界继续沿用[前次研究](tool-call-recovery-research-2026-11-02.md)：产品页面没有披露同类解析、恢复或幂等算法，本次不编造内部实现、不把产品体验当代码证据。

## Easel现有能力、仍有的缺口和实施顺序

1. **先修终态一致性（本次实施）。** 保留过程错误及原生轮次身份，成功不再被旧错误污染；失败、中断、未知保持区分。0.45.1派发前修复、0.45.2插件目录/主动生图已实际上线，不能把这些改动等同于全部loop完成。
2. **下一步统一预算和attempt记录。** 当前账本已有turn/providerRunId、revision及资源facts；参数恢复另有安全审计。仍需让模型请求尝试、参数修复、failover、压缩、工具执行和图片供应商查询有可关联身份、可持久的费用/时间预算。先测实际OpenClaw重试组合，不额外包整轮自动重试。prepared runtime的一次预算不能声称已经跨进程持久。
3. **收紧未知副作用的接回。** 图片已有持久供应商任务身份、查询/下载恢复和相同requestId去重；继续验收费请求已接受后失联/重启、迟到结果、停止竞争。发布与支付结果未知时保留待核验，不能根据超时重新提交。
4. **数据和产物完成需独立验收。** 默认数据仍有平台/分页范围限制；模型写“完成”不证明数据全、文件可用或图片正确。固定同一组20个真实运营任务，逐段记录来源、完整性、实际下载/解码/张数、人工质量及费用。其他工作树0.46分页WIP继续独立，不混进本批。
5. **处理运行环境与长任务。** 0.45.2隔离首启遇到持久Gateway owner租约；正常停止/启动后恢复。supervisor关闭宽限与OpenClaw原生排空预算不一致，仍需独立故障回归，不通过删锁或改数据库绕过。模型响应缓冲导致等待体验、记忆进程OOM因果、上下文压缩后关键业务状态恢复均继续开放。

后续验收按“模型尝试次数/工具派发次数/供应商提交次数/实际产物/费用”逐一断言，纳入网络断流、预算耗尽、参数错、前序工具完成、取消、重启、连接恢复和结果未知。最终以真实任务完成率、无重复收费/发布、失败定位时间判断追赶进度；测试数量和HTTP200不能替代这些指标。

## 本批验证与发布边界

`tests/test_codex_retry_events.py`通过完整service启动/结算路径，注入已完成文件交付、异轮错误、原轮次可重试错误及后续四种终态。验证每例仅一次`thread/start`/`turn/start`、交付一次、保留回答和工具回执；成功/中断不产生失败通知，真正失败保留最终原因，断线保持unconfirmed。另验证原生终态清除旧通知、真实失败不被泛化消息覆盖。

使用项目已有虚拟环境，5项新增与原有接回/持久结算组合共57项通过。首次误用系统Python导致缺少声明依赖websocket-client，已改用完整项目环境重跑；不通过跳过测试掩盖。最终前端构建及lint退出0（既有warning），版本同步为0.45.3。安装器和收费图片质量验收不在本补丁验证中，138实际激活与源码/镜像SHA在完成后追加。

## 138实际发布与Git交付

0.45.3源码`1001448c8982a6d4790be42c280955f135e867f6`已提交推送并核对starry远端；正式8444和隔离8445均已运行该构建。固定镜像`sha256:fcc90e643e9bdf589fb6d0a8f43625d1cb3139c1415accfcc4320a0edde26eca`，复用已核依赖的0.45.2镜像。仅四个运行源码文件变化：codex_service、pyproject及前端package/lock；另替换完整干净前端构建及Git导出manifest。构建前校验依赖兼容和变化集合，构建后1748运行源码逐文件SHA一致、安装包metadata0.45.3一致。

干净前端由已提交源码在本机构建，打包76文件共6554207字节，ZIP SHA256 `9090bc2672130d05c58eb7280cd06a752abe25317d7d3a9ef509ebbae81a88e1`；构建来源和各文件哈希记录在发布目录frontend-build-receipt.json。两环境通过HTTPS核对73个assets共6535162字节及首页；未公开挂载的两份public源文件不冒充HTTP入口。首次验证误取/index.html返回404，按实际首页/路由修正验证器后通过，不修改产品路由。

app/browser同固定镜像、healthy、当前重启0，Gateway正常，匿名version/readiness/failures均401。生产默认minimax-m3和原fallback保留，目标DeepSeek预算16384，reload off；readiness.modelInference仍not_probed，不等于真实任务成功。切正式前agent/browser/media active/waiting全0，图片队列仅1条既有done，无queued/running。

停写备份：正式`/home/ubuntu/easel-backups/20261102T111020Z.tar.gz`，隔离`/home/ubuntu/easel-backups-test/20261102T110606Z.tar.gz`。上一0.45.2镜像和代码保留，manager rollback仅回滚代码/镜像并保留当前数据；状态快照恢复另行处理。本次两环境启动未复现0.45.2隔离租约拒绝，停机预算缺口仍保留。

隔离入口https://127.0.0.1:8445/login（仅服务器loopback，经既有本机隧道访问），gaojitest/gaoji登录HTTP实际通过；真实浏览器前后端0.45.3、build1001448c8982、网关连接均核对，刷新默认双栏折叠。0.45.2已实际打开生图工坊和设置，点击对话展开会话栏；0.45.3页面版本通过不冒充所有菜单、真实图片质量或完整运营流程验收。正式登录后浏览器未验收，不植入测试弱密码。安装器未发布。

组合57项与版本校验另1项均通过（版本专项与5项新测试重跑6通过，不重复累计）；构建/lint退出0，既有warning保留。0.45.2完整原生CLI合成模型/真实文件工具的验收结果沿用原回执，此次不重放用户收费业务。全部已推送研究及发布文档链接HTTP200，main仅同步双语首页，功能不合main。
