# 0.13.2 操作详情记录修复（2026-10-21）

## 用户报障与核实对象

- 用户原话：“为什么游览器又是不可用啊”，随后贴出对话截图（`林雄是哪位` 一轮的回复“搜索工具在本环境仍不可用（无 provider）”），再追问：“这里的操作详情为什么没有主动记录呢”，截图为本轮行为面板中 4 条“调用工具 · 操作详情未记录”与提示“以下旧操作未记录共同顺序，单独保留。”。
- 只读核实对象：用户本机 `7881` 实例（进程命令行指向 `.codex/worktrees/upstream-merge-080/Easel/web/app.py`，数据目录 `C:\project\Easel\data`）产生的真实 transcript、执行日志与网关日志。没有修改这些记录，也没有重放付费模型请求。

## 已核实原因（两处，互不相同）

### 1. 搜索“不可用”是两段叠加，不是同一个故障

| 时间（10-21） | 事实 | 结论 |
| --- | --- | --- |
| 16:25 | 该轮 `web_search` 真实回执 `isError=true`，正文为 `web_search is disabled or no provider is available.`；当时配置里还没有搜索插件 | 当时确实没有 provider |
| 17:28 | 配置写入 `easel-search` 插件并热重载（网关日志 `config hot reload applied (plugins.entries.easel-search, …)`） | provider 已就位 |
| 21:24（截图轮） | 该轮事件只有 user → cache-ttl → assistant 纯文本，**没有任何 toolCall**；模型沿用上一轮结论直接说“仍不可用” | 模型没有重试，不是工具不可用 |
| 22:00（只读探针） | 运行中网关 `webSearch.status` 返回 `available: true`，`webSearch.test` 用“林雄”取回真实 Bing RSS 结果 | 链路可用 |

同一回合第一次真正调用的参数问题（22:02）也已定位：模型给 `web_search` 传了 `domain_filter: null`，被 schema 拒绝（`must be array`），去掉后第二次调用成功并继续 `web_fetch`。这属于模型参数错误，不是本机配置缺失。

### 2. “操作详情未记录”是前端拿不到工具名与参数

真实 transcript 中 40 次工具调用全部长这样：

```json
{"type":"toolCall","id":"call_01d2…","name":"tool_call",
 "arguments":{"args":{"query":"苹果 duo 价格"},"id":"web_search"}}
```

OpenClaw 2026.9.x 把所有内核工具统一走一个调度器：外层 `name` 固定为 `tool_call`，真实工具名在 `arguments.id`、真实参数在 `arguments.args`。`easel/execution.py::begin()` 原先只识别 `{function:{name,arguments}}`、`{name,input}`、`{tool,input}` 三种形状，认不出 `{id,args}`，于是：

- `name` 保持 `tool_call`、`kind` 落成 `tool`，`query`/`url`/`command` 全空；
- 前端 `operationTitle` 对 `tool_call` 只显示“调用工具 · 操作详情未记录”；
- 真实受影响的正是最需要留痕的动作：`web_search` 11 次、`web_fetch` 21 次、`browser` 4 次、`ask_user` 4 次（按 transcript 全量统计）。

第二处断点在实时记录通道：`ExecutionStore.consume()` 只接 CLI/native 路径的 `on_tool` 工具帧，HTTP 直连（Easel 默认传输）没有任何逐工具事件，`web/app.py` 只在收到 `delta.tool_calls` 时发一条“🔧 正在执行操作…”的进度文字。实测该数据目录下 **41 份执行日志的 `operations` 全部为 0**，只有进度条目；因此面板既没有详情，也拿不到操作与进度的共同顺序，才出现“旧操作未记录共同顺序”的提示。

## 实现

1. `easel/execution.py`
   - 新增 `tool_name()`：保留点号命名空间末段，并剥离 `openclaw:` 前缀（`openclaw:core:web_search` → `web_search`，`openclaw:browser:browser` → `browser`）。
   - `begin()` 在原有三种信封之后增加 OpenClaw 调度信封：仅当外层为 `tool_call`/`tool`、`arguments.id` 为非空字符串且 `arguments.args` 为对象时解包；其它形状原样保留，不猜测。
2. `easel/execution_store.py`
   - 新增 `adopt()`：把 transcript 回执合并进日志行，只增不减（空值不回写、终态不被回退、`truncated` 取并集、保留原 `source` 与 `order`）。
   - 新增 `ExecutionStore.ingest(rows)`：新行按发现顺序获得 `order` 并追加 timeline；重复轮询幂等；有变化才落盘，返回是否变化供调用方推送。
3. `web/app.py`
   - 新增 `_transcript_receipt()`：用与事后面板同一条 `chat_execution.snapshot(..., live=True)` 读取**本轮** transcript（沿用轮次边界、字节与事件上限）。
   - 新增 `_tail_transcript_operations(proc)`：仅对没有逐工具帧的传输启动（`getattr(proc,'on_tool',None) is None`，即 HTTP 直连与纯 CLI；native WS 仍用自己的工具流），默认每 1.5 秒一轮，新操作写入日志并以 `execution` 事件推送。间隔可用 `EASEL_EXECUTION_TAIL_SECONDS` 调整（0.5–30 秒）。
   - `finally` 中先停轮询、再补读一次，最后 `finish()`；仍处于 running 的工具会被标为“结果未确认”，与既有语义一致。
4. 前端 `web/frontend/src/lib/execution.ts`：`ask_user`→“向用户提问”、`tool_search`→“查找工具”、`tool_describe`→“读取工具说明”；`web_search`/`web_fetch`/`browser` 沿用既有按 `kind` 生成的具体标题。通用“操作详情未记录”只保留给确实读不出信封的行。

未改动模型提示词、工具白名单、搜索插件或任何凭据；没有新增数据库表，日志文件仍为单个 JSON。

## 验证

- 后端执行相关 **41 项通过**（`tests/test_execution_wrappers.py`、`tests/test_execution_ingest.py`、`tests/test_chat_execution.py`、`tests/test_execution_tail.py`），其中新增：
  - 调度信封 4 种工具 id × 2 种外层名、命名空间剥离、非法信封不回退猜测；
  - `ingest` 的顺序、幂等、终态不回退、持久化重载、非法行忽略；
  - 真实 supervisor 集成：无工具帧的 CLI 轮次结束后，执行日志含 `web_search/search/failed`、`query=林雄`，timeline 有对应操作项，SSE 的 `execution` 事件携带了操作。
- 同批聊天/审计回归 **178 项通过、9 项失败**；这 9 项在 0.13.1 干净工作树（`54b7073f`）上逐一复现，属既有问题（`test_chat_event_log_recovery` 6 项、`test_skill_audit_stream` 3 项），本轮未修复也未宣称通过。
- 前端全量 **1365 项通过**（0.13.1 为 1364 + 本轮新增 1 项标题用例）；`npm run build`（tsc + vite）通过，仅有既有大 chunk 提示；`npm run lint` 0 error / 25 既有 warning。
- **真实 transcript 只读回放**（0.13.1 代码 vs 本轮修复，同一批审计文件）：

| 轮次 | 修复前 | 修复后 |
| --- | --- | --- |
| `1792589417699-ww3wnmyuok`（截图那类 4 条） | 4 × `tool_call`，无 query | 4 × `web_search`，query=苹果 duo 价格 |
| `1792571105497-4hbx5kr6xvi` | 1 × `tool_call`，无 query | 1 × `web_search`，query=林雄 |
| `1792569348632-ang0ybvmexg` | 3 × `tool_call` | 3 × `web_fetch`，含真实 URL |

- 未执行：真实付费模型的新任务、`7881` 实例升级、浏览器界面复验、138 部署、安装器发布。上述回放是只读数据验证，不等于已在新构建上跑通一轮真实对话。
- **历史轮次**：详情本身会随解码修复立即恢复（工具名、查询、网址、失败原因都来自已有 transcript）；但升级前没有执行日志的轮次仍然没有“操作与进度的共同顺序”，面板会继续保留该提示。这是如实标注，不是构建失败；新发生的轮次才具备完整顺序。

## 升级、回滚与边界

- 兼容修复，版本 0.13.1→0.13.2；单一版本来源仍为 `pyproject.toml`，前端构建从该文件取值（本轮重新构建后入口资源见交付回执）。
- 升级需要：拉取本分支源码 → 重新构建前端 → 重启对应 Web 实例。仅替换静态文件不会加载新的后端解码与轮询逻辑。
- 用户当前 `7881` 实例运行的是 `upstream-merge-0.8.0` 工作树（10-21 17:58 启动），**不含本轮修复**；需要按既有方式以 0.13.2 源码重启后才会生效。本轮未重启该实例。
- 回滚：恢复 `easel/execution.py`、`easel/execution_store.py`、`web/app.py`、前端 `execution.ts` 到 0.13.1 并重建/重启；已写入旧格式执行日志仍可读（`ingest` 只是新增字段路径，不改旧字段）。
- 本机时间窗口内网关与 Web 服务在 22:03 后自行停止（非本轮操作），因此没有在线实例可供浏览器复验；该状态如实记录，不冒充已验收。
- 当前工作台无管理员认证系统，本轮不新增测试管理员；138、安装器和公网生产均未改动。

## Git 交付回执

- 功能提交 `433fa96378918513c69e8fbdd2c8d69047c4223b` 已推送 `starry/codex/execution-ops-0.13.2`；本地 `rev-parse HEAD` 与 `git ls-remote` 一致。
- 默认分支仅同步中英文首页，`starry/main` 为 `2a0736c3e019977491aea660e9e3f5d5f9726454`，已核对远端 SHA；功能代码未合并 `main`。
- 本地构建入口 `assets/index-BtfjuKGk.js`，构建内版本常量 0.13.2；该构建来自隔离工作树 `exec-ops-0132`，未部署到用户 `7881` 实例、138 或安装器。
