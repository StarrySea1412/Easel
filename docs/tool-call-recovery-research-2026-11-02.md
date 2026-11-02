# 工具参数失败：其他 Agent 的实际处理与 Easel 的缺口

2026-11-02，用户指出同一畸形工具调用已经反复发生，并要求核对其他 Agent 的处理。本次查证官方文档、固定版本公开源码及138同版本适配器；没有重放真实任务、调用收费模型、修改正式配置或部署。本文是诊断与实现决策，**不是问题已经修复的回执**。此前0.44.1只有分类与提示，不能视为反复失败已关闭。

## 1. 本次新增实证

保留记录中至少4次相同错误来自同一自定义渠道/模型，最后一次assistant输出量均为8192 tokens。最新一轮所有已记录工具均正常返回，之后模型响应失败；目标目录只有目录，没有图片或HTML文件。此前成功工具不能因最后一步失败被重放。

本次只选择模型预算相关非秘密字段读取配置：`deepseek-v4.1-flash`没有模型级`maxTokens`，渠道也没有`maxTokens`。现场OpenClaw的`applyModelDefaults`对缺少目录元数据和显式覆盖的模型使用`DEFAULT_MODEL_MAX_TOKENS = 8192`。用同版本纯配置归一化函数处理去除凭据、只含该模型的配置，实际得到：

```json
{"id":"deepseek-v4.1-flash","maxTokens":8192,"api":"openai-completions"}
```

这是当前现场归一化的默认预算证据；不等于已经取得4次历史请求的原始HTTP参数、供应商原始`finish_reason`或残缺参数。8192与失败的重复对应很强，仍须将“预算耗尽”与“普通格式错误”区分，不能编造缺少了哪个字符。

还在现场同版本AI适配器执行了3个**纯内存合成用例**：仅调用终态校验函数，不运行任何工具、不请求模型、不写文件。

| 输入 | 输出 | 保留可执行调用数 |
| --- | --- | --- |
| `toolUse` + 未闭合JSON字符串 | `error`，与正式相同的`Provider returned an incomplete or malformed tool call` | 0 |
| `length` + 相同未闭合字符串 | 保留`length` | 0 |
| `toolUse` + 完整JSON | 保留`toolUse` | 1 |

这说明**不能只凭这个报错反推原始终止原因就是length**。也说明校验发生在工具派发之前；Easel的`before_tool_call`插件此时还收不到被拒绝的调用，单改这个hook不能修复该类解析错误。现有安全拒绝必须保留。

## 2. 实际读到的做法

### DeepSeek Harness：保留终止原因，按类型恢复

本次固定提交为`ce7073d51254c26cd63b22a60835b8f948deb447`。

- [Messages适配器](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/llm/llm-deepseek/src/translate.ts#L90)：将`max_tokens`单独映射为`max-tokens`；正常结束时校验工具JSON，格式不合法报错；预算终止走独立路径。流在`message_stop`前断开则报`STREAM_CLOSED`。
- [共享组装器](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/llm/llm/src/assembler.ts#L135)：预算终止时剔除该次响应中的工具调用块，并同步剔除对应回放元数据；中断路径仅保留可用文本/推理块。不是给半截JSON补括号后执行。
- [默认重试策略](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/llm/llm/src/retry-policy.ts#L14)：默认最多5次，代码集合为`EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`；没有把所有畸形工具参数都列入默认重试。
- [重试执行器](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/llm/llm-retry/src/index.ts#L184)：重试前持久化`llm/retry`、执行前记录`llm/retry-started`；退避支持取消。源码也提供`always`无限重试选项，**不建议Easel采用**，运营生成需要费用和时间边界。
- [同轮次/步骤测试](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/agent-loop/tests/request-error.spec.ts#L54)：失败请求恢复保留turn/step；另测取消优先于重试、恢复监听器自身报错不能继续重试。这是源码和上游测试内容，本次未运行整套上游测试，也不是其真实成功率实测。

可借鉴的是终止原因、请求级恢复和持久重试记录。其Messages路径与我们的第三方Chat Completions路径不同，不能直接认为换用Harness就能兼容该渠道。

### PydanticAI：截断单独处理，校验修复有次数上限

本次固定提交为`129c94ef2940565af3bc9f638196fcc994d1ed4d`。

- [`check_incomplete_tool_call`](https://github.com/pydantic/pydantic-ai/blob/129c94ef2940565af3bc9f638196fcc994d1ed4d/pydantic_ai_slim/pydantic_ai/_agent_graph.py#L829)：最后模型响应为`length`且最后工具参数不能严格解析时，抛出专门的`IncompleteToolCall`，明确建议提高合法预算或缩短响应。
- [没有可执行输出的预算终止](https://github.com/pydantic/pydantic-ai/blob/129c94ef2940565af3bc9f638196fcc994d1ed4d/pydantic_ai_slim/pydantic_ai/_agent_graph.py#L3883)：不按普通无输出重试处理，避免原样重复消耗预算。
- [输出重试计数](https://github.com/pydantic/pydantic-ai/blob/129c94ef2940565af3bc9f638196fcc994d1ed4d/pydantic_ai_slim/pydantic_ai/_agent_graph.py#L845)：反馈与重试预算显式计数；工具重试和输出重试有各自边界。不能据此推断所有模型格式错误都会被自动修好。

### Vercel AI SDK：在执行之前修复参数，再重新校验

本次固定提交为`ad09bc1c55e9c2ad224d17008013a32e79b8ea82`。

- [`parseToolCall`](https://github.com/vercel/ai/blob/ad09bc1c55e9c2ad224d17008013a32e79b8ea82/packages/ai/src/generate-text/parse-tool-call.ts#L59)：对工具不存在/参数无效，只有调用方配置了`repairToolCall`才尝试修复；修复后再次经过解析与校验。修复回调返回空或失败不会当作有效调用执行。
- [重新询问模型的例子](https://github.com/vercel/ai/blob/ad09bc1c55e9c2ad224d17008013a32e79b8ea82/examples/ai-functions/src/generate-text/mock/tool-call-repair-reask.ts)：保留原调用ID，把校验错误作为工具反馈，让模型重新生成参数，再返回修复调用。这个例子会新增模型请求，费用与重试边界需调用方控制，不能把“框架支持回调”写成“自动免费修好”。

### Codex源码：参数解析错误反馈给模型

本次固定Codex提交为`a09812981de703f18f38015cd5d500ab373f616c`。公开Rust源码中的[`parse_arguments`](https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/core/src/tools/handlers/mod.rs#L90)用serde解析工具参数；解析失败转成`FunctionCallError::RespondToModel`，错误信息含“failed to parse function arguments”。同文件将顶层非对象参数也转成同类反馈。也就是说它将格式错误交回Agent执行协议处理；这段源码本身不证明会自动修复成功、重试次数、预算变化或原请求是否重发。

### OpenAI官方API与Codex App Server

[Codex App Server官方文档](https://learn.chatgpt.com/docs/app-server)将thread、turn及工具item分开标识；对入口队列满明确返回JSON-RPC `-32001`，建议指数退避加抖动。这是入口过载重试，不能推导为畸形工具参数也应重播整轮。

[OpenAI官方Function calling文档](https://developers.openai.com/api/docs/guides/function-calling)推荐严格schema；要求对象`additionalProperties:false`、字段required，Chat Completions默认仍非严格模式。`parallel_tool_calls:false`可限制同次零或一个调用，但不能代替预算控制。

[OpenAI官方Reasoning文档](https://developers.openai.com/api/docs/guides/reasoning)明确输出上限包含推理等生成tokens，预算耗尽返回`incomplete`及`max_output_tokens`；可能在产生可见输出前就耗尽。**这描述OpenAI协议，不证明第三方渠道相同字段完全同义，也不能将OpenAI建议的预算数值直接套到本次DeepSeek渠道。**

Codex公开工具handler证明解析错误可以形成给模型的协议反馈，但其完整调用循环/持久策略不是这段源码所能证明；不能声称它自动补JSON、必然成功，或固定自动重试几次。

### Grok Bot与ZCode：公开资料没有披露同类错误算法

本次实际读取[Grok Bot Overview](https://docs.x.ai/grok-bot/overview)和[ZCode目标模式](https://zcode.z.ai/cn/docs/goal)。前者介绍产品运行方式；后者说明暂停保留轮次、工具记录和文件，用量上限会停止推进。两页均未披露本次`malformed tool call`的内部解析/修复实现，不能据产品体验推断隐藏的重试机制。没有读取本机个人登录目录或逆向本轮应用包。

## 3. Easel应实施的顺序与验收

这些是依据本次证据形成的实现决策，尚未实现或部署，不与0.46分页候选混称为已修。

1. **先把预算与终止原因拿到执行层。** 记录有效输出上限及其来源（显式/目录/默认）、原始终止原因、实际用量、工具名及参数字节数/摘要；不持久化秘密或完整工具正文。解析器删除无效参数之前记录诊断，分别表示预算终止、畸形JSON、断流、schema校验失败。先补渠道契约测试，再依据该渠道确认的能力设置预算，不盲目把8192改成极大值。
2. **让长产物不依赖一个大工具参数。** 卡组/长HTML采用短的结构化内容加确定性模板，或有序小块写入；每块持久化并校验序号/摘要，最终原子提交。重启从最后确认块继续，已存在成品不能先清空。生图走实际生图工具，不能为绕过错误转为HTML。仅增加一句“请分块”不足以算完成。
3. **在校验和派发之间提供有界参数修复。** 仅对确认未派发的调用保留原调用ID、工具名及错误反馈，受原模型、授权、调用/时间/费用预算约束；修复后重新校验，不执行残缺或猜补的JSON。预算耗尽须先改变输出规模或经能力确认的预算，否则原样重试会重复失败。当前OpenClaw失败发生在Easel工具hook之前，必须在适配器/请求恢复边界解决，不能把普通续轮按钮当成参数修复。
4. **保留已完成与未知副作用。** 模型参数修复、失败请求重试、工具业务重试是三件事。发布/支付/生图提交已接受或结果未知时，只查询原任务及原幂等键，不能通过重播整轮“自动恢复”。取消优先；连续不兼容应阻止继续自动派发，清楚显示未完成步骤。

冻结候选后至少验证：8192预算耗尽、错误`tool_calls`终态、残缺JSON、合法JSON但schema错、缺少终止帧、一次失败后修复成功、修复仍失败到达上限、取消、重启、前序工具已完成、收费请求接受后失联。分别断言原始模型请求次数、工具派发次数、任务ID、持久产物和资源结算。合成测试不能替代已授权的同渠道真实任务及实际产物验收。

## 4. 当前交付边界

本次只完成研究、现场只读补证、3项适配器纯函数复现及中文文档；没有新增产品修复，正式重复失败仍未关闭，没有运行付费模型。既有未提交0.46分页、图片日志UTF-8和测试隔离工作保持；完整后端冻结回归、其余浏览器收尾、真实业务及最终用户验收继续。138仍以此前已核0.43.9为正式基线，本次未切换版本、配置或容器，未发布安装器。
