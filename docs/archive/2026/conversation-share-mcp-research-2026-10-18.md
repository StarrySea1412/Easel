# 对话分享 MCP：调研与设计（2026-10-18）

> 用户原话：“增加对话分享的MCP，，我想要的是，对话分享出去是完整的，同时模型能够对那个对话实现接管，在接管后，生成对应的内容，能够加载回来到这个对话中。。这个你也要做好调研，我们哪些竞品是能够做到的”。
> 调研方式：只读解析本机 ZCode 3.15.3 `app.asar`（抽取件在忽略目录 `outputs/zcode-research-2026-10-18/`）＋官方文档联网读取（可达者标来源与日期；不可达者如实标注）。不改动任何本机应用。

## 1. 竞品能力矩阵（完整分享 / 接管 / 回传原对话）

| 竞品 | 分享是否完整 | 别人能否接管继续 | 产物能否回传**原**对话 | 依据 |
| --- | --- | --- | --- | --- |
| **ZCode 3.15.3** | ✅ 可选轮次 + **产物一并上传**，有发布预检/披露确认 | ✅ `accessMode: public_importable`——分享页可**导入**（配合任务**分叉** `forkedFromTaskId`）；另有 handoff 机制 | ❌ 导入是复制到你的工作区继续，不回写原会话 | 本机 asar：`conversation-share` 模块（`be.publish({sessionId,title,accessMode,selection:{kind:'productTurns',productTurnIds},…})` → `share_url`；`conversationShare.progress.{collecting,checking,uploading}`、`publishSucceededWithSkips`、`分享预检失败`；`taskList.forkedUntitled`） |
| **ChatGPT 分享链接** | ✅ 快照（含图片/代码），可选择排除部分内容 | ✅ 收件人可“在 ChatGPT 中继续”得到**自己的副本** | ❌ 副本不回写原作者对话 | 未能取得官方页面核对（help.openai.com 403），按既有认识标注 |
| **Claude 分享链接** | ✅ 只读快照 | ❌ 无“接管继续”（Claude Code 会话可按用户 resume，非跨人接管） | ❌ | Claude Code 官方文档（code.claude.com/docs，2026-10-18 WebFetch）：扩展/桌面端只有 diff、多会话并排、定时任务，无分享-接管 |
| **Cursor** | —（无公开对话分享；Agent 面板支持 steering/排队/会话搜索） | ➖ 同工作区协作者可复用同一会话（共享工作区语义），非分享链接 | ❌ | cursor.com/docs/agent/overview（2026-10-18 WebFetch） |
| **Devin / Open WebUI / 其它** | Devin 会话在 Slack 线程中，团队成员可**在同一线程继续**（原地接管协作）；Open WebUI 分享为公开只读快照 | Devin ✅ 原地接管；Open WebUI ➖ 可“继续”成副本 | ❌（未发现回写原会话者） | 官方页 404/不可达，按既有认识标注；Devin 的“多人同一会话”语义与我们要做的**接管**最接近 |
| **LangSmith / LangGraph 线程** | 线程可分享、可“时间旅行”与分叉 | ✅ 可在同一线程追加 run（接管） | ➖ 追加发生在平台内，不回写外部应用 | 按既有认识标注（本机未核对） |

**结论**：**“完整分享 + 外部接管”已有成熟先例（ZCode 的 public_importable、Devin 的同线程协作、ChatGPT 的继续副本）；但“接管产出回写进原对话”没有竞品在做**——这正是用户要的差异点，也是本设计的核心：分享是双向的（read + append back）。

## 2. Easel 现状与关键约束

- **对话数据在客户端**（浏览器 localStorage，`easel_sessions`），后端不持有会话消息；网关（OpenClaw）另有服务端会话库（sqlite）。→ **回传必须由客户端合并**：后端只做分享与追加存储，Easel 前端在打开该会话时把追加内容合并进本地会话（去重、标注来源、不静默改写历史）。
- 已有能力可复用：`web/app.py`（FastAPI，新增分享路由）、`localPersistence`（客户端落盘）、`ChatArtifacts`（产物已随消息/交付层）、现有会话标题/模型/引擎字段。
- 本机 7880 后端为旧构建：新增后端路由需**空闲重启**才生效（与前几轮同一约定，如实标注）。

## 3. MCP 设计（对话分享 MCP）

**形态**：独立 stdio MCP 服务器（零外部依赖，纯标准库），与后端共用同一分享存储模块；外部模型/客户端（ZCode、Claude Desktop、Cursor 等任何支持 MCP 的 harness）配置该 server 后即可：完整读取分享、在分享上追加生成内容、把追加记回原对话。

**工具（tools）**：
- `share_conversation(sessionId, title, messages[], meta{modelRef,engine,created})` → 创建不可猜测 token 的完整分享（全量消息 + 元数据 + 摘要计数）；返回 `{token, url, messageCount}`。
- `read_conversation_share(token, afterIndex=0)` → 完整读取（分页）分享内容与既有追加；外部模型据此**接管**。
- `append_to_shared_conversation(token, messages[], source{model,harnes}, note)` → 把接管生成内容追加进分享（追加记录带 id/时间/来源）。
- `list_conversation_shares(limit)` → 本机已有分享与追加计数（便于找回）。

**资源（resources，只读）**：`easel-share://<token>` 返回完整分享（与 read 工具同构，供只读型客户端）。

**存储**：`data/conversation-shares/<token>.json`（分享本体：消息快照、元数据、创建时间、轮次计数）＋ `<token>.appends.jsonl`（追加，逐条带 `appendId/at/source/messages`）。写入串行加锁、单文件大小上限、消息数与字符数上限、控制字符清洗；token = 32 字节 URL-safe 随机。

**安全边界**：本地/局域网内以不可猜测 token 访问（无鉴权，与 Easel 现有本地 API 同策略），文档明确“分享即导出，注意隐私”；不提供公网发布；不调用任何付费模型；MCP 服务器只读写分享目录，不触碰会话库与密钥。

**客户端（Easel 前端）**：
- 会话头部「分享」按钮：把**当前会话全量**消息（含角色/时间/模型）创建为分享，显示 token/链接与“复制”。
- 「加载回来」：读取该分享的追加记录，把接管的产出合并进本地会话——消息带 `shareAppend` 标记（来源模型/harness、时间、token），在气泡上显示“来自分享接管”标签；按 `appendId` 去重，重复加载不产生重复消息；后端不可达时如实报错。
- 已有分享的会话在头部显示“分享中 · N 条回传待加载”，点一次即合并。

## 4. MVP 验收条件

1. 完整分享：全量消息与元数据落盘（token 访问），缺字段/超限/空会话有明确错误；创建返回 token 与计数。
2. MCP：`initialize`/`tools/list`/`tools/call` 协议正确；`share_conversation → read_conversation_share → append_to_shared_conversation → read` 全链路可跑通（pytest 内直接驱动 stdio）；未知工具/非法 token 返回结构化错误。
3. 回传加载（前端）：合并去重、来源标注、刷新后不重复；`localPersistence` 失败如实提示。
4. 回归：既有后端/前端测试全绿；新增分享与 MCP 测试；7880 浏览器核对（分享→外部追加→加载回来）。
5. 文档：CHANGELOG/README/进度与需求文档同步；调研来源与不可达项如实标注。

**不做（MVP）**：不做公网分享托管与登录鉴权；不做分享页 Web 预览（下一步）；不自动把回传内容并入上下文重放；不改 138/安装包；不碰并发未提交工作。

## 5. 实现落地（MVP 已完成）

- **后端** `web/conversation_share.py`：`ConversationShareStore`（创建/读取/追加/列出，串行加锁、控制字符清洗、消息与体积上限、token=`secrets.token_urlsafe`）+ 四条路由（`POST/GET /api/conversation-shares`、`GET /api/conversation-shares/{token}`、`POST /api/conversation-shares/{token}/appends`），数据在 `<DATA_DIR>/conversation-shares/`。
- **MCP** `mcp/conversation_share_mcp.py`：stdio、逐行 JSON-RPC、零第三方依赖（与既有 `mcp/easel-notify` 同约定）；工具 `share_conversation`/`read_conversation_share`/`append_to_shared_conversation`/`list_conversation_shares`，资源 `easel-share://<token>`。注册（easel profile）：
  `openclaw --profile easel mcp add easel-conversation-share --command "<python>" --arg "<项目根>/mcp/conversation_share_mcp.py" --env "EASEL_DATA_DIR=<项目根>" --cwd "<项目根>"`
- **客户端**：会话头部「分享」按钮（完整快照→本地 token）；已分享会话显示「加载接管内容」，把外部追加合并进原对话——按 `appendId` 去重、逐条标注“来自分享接管 · 来源 · 时间”，并在 `decodeSessions` 白名单中持久化（刷新不丢、不重复）。
- **测试**：后端存储 6 项 + MCP 全链路 4 项（stdio 子进程驱动）；前端合并/载荷/接口错误 3 项 + 持久化往返 1 项。7880 需空闲重启后端后分享接口才生效（前端与 MCP 均已就绪）。
