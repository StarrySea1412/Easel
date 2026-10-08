# 知乎热榜故障评估与修正

日期：2026-10-08（Asia/Shanghai）。本记录区分真实 HTTP 抽查、保存响应的解析复核和隔离测试。

## 当前结论

知乎主来源本次已恢复返回内容，并找到另一个实际返回 30 条问题热榜的公开演示接口。由于该实例明确仅供演示，没有把它设成常驻依赖；已实现其响应协议的备用适配器，可显式配置自行部署或获准使用的实例。**默认仍是一个来源，不能报告成默认双源已上线。**

默认调用路径为 `GET /api/trends?platforms=zhihu` → `web/trend_sources.py` → `https://60s.viki.moe/v2/zhihu`。配置 `EASEL_ZHIHU_DAILYHOT_URL` 后，只有主来源失败或正在冷却时才依次尝试配置的备用接口。工作台不使用知乎 Cookie、个人登录态或收费密钥，没有证据表明此前故障需要修复知乎账号登录。

本轮查到并检查的是**问题热榜**，不是热搜关键词或知乎日报；后两者不能用来冒充同一榜单。

## 已取得的证据

| 来源 | 时间与实际结果 | 能支持的结论 |
| --- | --- | --- |
| [60s 知乎热榜](https://60s.viki.moe/v2/zhihu) | 2026-10-01 的既有记录为 HTTP 429；2026-10-08 11:56:24 抽查为 HTTP 200、业务 `code: 200`，返回 30 条记录，用时约 0.42 秒 | 曾存在来源限流，本次请求已恢复；不是持续失效或本地解析必然失败 |
| [xxapi 知乎候选](https://v2.xxapi.cn/api/zhihuhot) | 2026-10-08 11:55:44 为 HTTP 200，但业务 `code: -8`、`msg: 请携带Key`；与 10 月 1 日记录一致 | 该候选需要授权，HTTP 200 不等于取得榜单；未加入免费回退列表 |
| 本地解析器与上述已保存的 60s 响应 | 复核取得 30 个标题、30 个热度文案、30 个问题链接与 30 个问题创建时间 | 新解析器兼容这次实际响应；没有再次请求上游 |

本次 60s 成功响应没有 `Retry-After`，也未提供整个榜单的更新时间。不能从两个日期的抽查计算故障率，或确定以前的 429 究竟由聚合服务、其访问网关还是知乎上游产生。

实际响应使用 `hot_value_desc`、`created_at`（Unix 毫秒）和 `link`。旧解析器已能读取标题与链接，但忽略热度文案和毫秒创建时间。这会造成成功榜单的信息缺失，不能解释此前明确的 HTTP 429。

## 其他接口的检索与实测

候选来自公开仓库的 README、路由实现与官方文档。以下三个候选接口各做了一次普通 GET，使用项目自身的 User-Agent，不登录、不添加强制刷新参数、不改用代理或身份重试；本阶段没有重复请求 xxapi。

| 候选与公开依据 | 2026-10-08 实际检查（+08:00） | 数据与接入结论 |
| --- | --- | --- |
| [imsyy/DailyHotApi README](https://github.com/imsyy/DailyHotApi/blob/master/README.md) 明示 `https://api-hot.imsyy.top/zhihu` 为知乎热榜 | 12:24:29；TLS 握手报 `UNEXPECTED_EOF_WHILE_READING`，约 0.19 秒，未取得 HTTP 状态或正文 | 未取得条目，未接入；不能据此宣称所有网络或该项目所有部署均失效。文档另提示示例可能停维护、默认缓存 60 分钟 |
| [NewsNow README](https://github.com/newsnext/newsnow/blob/main/README.md)、[公开接口](https://github.com/newsnext/newsnow/blob/main/server/api/s/index.ts) 与[知乎来源](https://github.com/newsnext/newsnow/blob/main/server/sources/zhihu.ts) 确认 `https://newsnow.busiyi.world/api/s?id=zhihu` | 12:25:55；读取超时，约 10.66 秒，未取得响应正文；没有使用 `latest` 参数 | 未取得条目，未接入。代码支持返回缓存，`updatedTime` 不总是原始缓存时间，更不是知乎榜单更新时间 |
| [ShellMonster/DailyHotApi-Go README](https://github.com/ShellMonster/DailyHotApi-Go/blob/main/README.md) 明示演示主机与 `/zhihu` 路由：`https://apinews.geekaso.com/zhihu` | 12:29:10；HTTP 200、业务 `code: 200`，约 0.78 秒；30 条标题、30 个知乎问题链接、30 个数值热度、30 个问题创建时间 | 实际可读取问题热榜；`fromCache: true`，`updateTime: 2026-10-08T12:29:11+08:00`。已兼容该协议，公共演示实例默认不启用 |

另查阅 [HelTi/daily-hot-api](https://github.com/HelTi/daily-hot-api/blob/main/README.md)，找到知乎热榜的自部署实现，但没有从查阅的文档中取得可实测公共主机，未猜测地址。

[60s 官方说明](https://github.com/vikiboss/60s/blob/main/readme.md) 已明确主域名使用 Cloudflare Workers、每日额度有限且限流严格，仅供开发调试；生产建议自部署或使用[社区公共实例](https://docs.60s-api.viki.moe/7306811m0)。本轮读取了公共实例清单，没有逐个请求或加入回退列表。这些实例是同一个 60s 项目的部署，仍依赖知乎上游，不能当作互相独立的数据来源或稳定性保证。官方说明能证明服务边界，不能反推 10 月 1 日那次 429 的内部产生位置。

### 演示响应的时间与缓存语义

[Go 响应构造代码](https://github.com/ShellMonster/DailyHotApi-Go/blob/main/internal/models/response.go) 每次用 `time.Now()` 填充 `updateTime`；[知乎路由](https://github.com/ShellMonster/DailyHotApi-Go/blob/main/internal/routes/zhihu.go) 用请求是否包含 `cache=false` 来填写 `fromCache`，并非根据真实命中检测填写。该路由的 `timestamp` 则来自问题的 `target.created × 1000`。

因此，备用适配器保留以下区别：

| 返回字段 | 含义与边界 |
| --- | --- |
| `fetchedAt` / `checkedAt` | Easel 成功取得数据／检查来源的时间；不是知乎榜单更新时间 |
| `sourceUpdatedAt` | 此协议无法证明榜单更新时间，保持 `null` |
| `source.responseGeneratedAt` | 来源报告的响应生成时间，归一化为 Unix 秒，不影响榜单新鲜度判定 |
| `source.reportedFromCache` | 原样保留来源提供的布尔声明；不能据此声称已验证缓存命中或缓存年龄 |
| `item.createdAt` | 知乎问题创建时间，独立于上榜时间和榜单更新时间 |

`status: fresh` 表示本次成功取得响应，不承诺上游榜单实时。界面以“获取于”和“来源未提供榜单时间”说明这一区别，未将响应生成时间显示成来源更新。真实响应的 30 个问题链接已检查结构，未逐项访问问题页面。

### 显式配置备用实例

`EASEL_ZHIHU_DAILYHOT_URL` 默认未设置。应指向你自行部署或获准使用、兼容上述 DailyHotApi-Go 响应结构的**完整知乎热榜接口地址**。示例 PowerShell：

```powershell
$env:EASEL_ZHIHU_DAILYHOT_URL = 'http://127.0.0.1:6688/zhihu'
python scripts/start_workspace.py --restart --no-browser
```

示例假定该本地实例已经部署；本轮没有启动或验证 `127.0.0.1:6688`。变量从启动进程环境读取，不是设置页字段，也不由本模块自动加载 `.env`；修改后需重启后端。地址必须为 HTTP(S)，不得含用户名、密码、查询参数或片段；无效值会被忽略并记录不含地址内容的告警。公开演示地址没有写入默认配置。

备用响应须标明 `name: zhihu`、`type: 热榜`，并提供 `zhihu.com` 的问题链接。热搜关键词、其他平台榜单、知乎日报或没有可用问题链接的内容会被拒绝。主来源成功时不请求备用；失败时保留前序来源的名称、URL、检查时间与错误分类，成功来源及其元信息记录在 `source` 中。

## 已实施的修正

- 兼容 `hot_value_desc`，保留来源提供的热度文案；真实的数值 `0` 不再被当作缺失。
- 知乎问题创建时间归一化为 Unix 秒，单独返回 `item.createdAt`。不将其填充为 `publishedAt`，更不当作上榜时间或 `sourceUpdatedAt`；没有时区的日期字符串保持未知。
- HTTP 429、503 若返回有效 `Retry-After`，识别秒数或 HTTP 日期，并遵守该来源的冷却窗口。手动刷新不会提前向它发起请求；已有独立备用源仍可继续工作。业务 JSON 的 `code: 429` 也明确归为限流。
- 失败或旧数据结果提供 `nextRetryAt`，每条失败 `attempt` 保留来源名称、URL、`checkedAt` 和错误分类；复用冷却结果不伪造新的检查时间。
- 增加显式启用的 DailyHotApi-Go 备用协议，兼容数值热度、问题创建时间，保留来源的响应时间与缓存声明，不制造榜单更新时间。
- 保留现有正常缓存 5 分钟、默认请求冷却 60 秒和旧数据最长 24 小时的规则。长时间的来源冷却不会延长旧榜单寿命，超过 24 小时移除旧条目；失败不更新 `fetchedAt`。

这些修正补齐真实字段并减少限流期间的无效请求，不保证公益聚合服务持续可用。缓存仍仅存在于当前后端进程，重启后需要重新取得成功响应。没有新增收费服务、使用登录态、轮换身份/IP、绕过验证码或用其他平台的话题冒充知乎榜单。自行部署备用实现也不能保证知乎上游始终可读取。

## 验证范围

`python -m pytest tests/test_trend_sources.py -q`：**36 passed**。全部网络异常、缓存时间和回退分支均使用隔离替身；覆盖毫秒/时区/零值、HTTP 与业务限流、两种 Retry-After 格式、手动刷新冷却、备用来源继续工作、旧数据到期、配置显式启用与无效地址拒绝、问题热榜判别以及响应时间不冒充榜单更新。

实际 HTTP 抽查与保存响应的解析复核单独记录，不将上述 36 项测试计为真实平台测试。保存的 60s 和 DailyHotApi-Go 成功响应均通过离线解析，各保留 30 个标题、热度、问题链接和问题创建时间；`publishedAt`、`sourceUpdatedAt` 均未伪造。回退分支已用隔离替身验证，没有为验收故意触发主来源限流。本轮没有逐项打开榜单中的问题链接，也未据此声称知乎文章页、账号登录或发布功能通过浏览器验收。

原始诊断证据位于本机忽略目录 `.scratch/zhihu-trends-2026-10-08/`，不提交响应正文或临时验收文件。历史故障依据见 [10 月 1 日工作区计划](workspace-experience-action-plan-2026-10-01.md) 的“热点故障依据与接入边界”。
