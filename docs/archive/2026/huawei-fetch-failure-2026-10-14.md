# Google News 抓取失败核查 / Google News fetch investigation

核查日期：2026-10-14。范围是用户截图中的 Google News 红色失败行，以及同一会话搜索结果能否支持最终回答。本轮读取 138 既有记录并复测目标地址，未切换或重启服务。

## 已确认的原因

`web_fetch` 请求 `https://news.google.com/search?q=Huawei+2026&hl=en` 超时。OpenClaw SQLite 的对应工具回执 `isError=true`，JSON `error` 的完整 API 包装内是 `request timed out`。调用时间为 06:10:45.357 UTC，返回时间为 06:11:16.052 UTC，约 30.7 秒。

在正式运行容器 `easel-app-1` 内只读复测：DNS 成功解析；curl 使用 8 秒连接上限、15 秒总上限，约 8 秒后退出 28，报告无法连接目标 443 端口，未收到 HTTP 响应。此证据支持当前容器到 Google News 的连接不可用；无法据此确定是网络出口、目标侧或中间网络设备造成，也不能写成 Google 返回 403、429 或安全策略拒绝。

核查当时正式镜像为 `easel:0ba9fe201ca3`，核查未触发重新部署。随后提示修复已通过快速入口发布到 `12f144c8`，详见后续发布回执。

## 为什么界面没有显示原因

前端 `operationFailureReason` 对 OpenClaw 的完整外部内容包装只识别“搜索未配置”和“地址被安全检查拦截”两类已知 API 错误；超时字符串没有进入白名单，随后被外部正文过滤逻辑移除。因此截图出现“工具报告失败，但未提供具体原因”，尽管 SQLite 原始回执中已有明确超时原因。

源码现在增加第三种精确识别：同一完整安全提示、`Source: API`、匹配的首尾标识及正文恰为 `request timed out`，且工具名为 `web_fetch` 时，折叠行显示“网页请求超时”。额外正文、不匹配的标识、网页来源和其他工具均保持原过滤规则；完整回执仍在展开后查看。这项修复只改善错误说明，不改变目标网络可达性。

## 搜索返回与新闻结论

同一会话共确认 29 个工具回执：27 次 `web_search` 没有工具错误，1 次华为新闻页抓取 HTTP 200，1 次 Google News 抓取超时。27 次搜索只形成 4 组不同的 URL 列表，主要是华为首页、产品页、商城、百科和招聘页。华为新闻页经 readability 提取的正文只有 Cookie 提示和筛选标题，没有新闻正文。

138 的免费搜索 provider 是 Bing RSS；当前自定义参数只声明 `query` 和 `count`，没有实现 `freshness` 或 `date_after` 的时间筛选。不能把模型提交了这些参数等同于服务已按最近一周或指定日期过滤。不同查询返回相似结果，也不能直接认定为缓存串查询；缓存键本身包含完整查询和数量。

这些回执能证明搜索工具返回了网页，但不足以证明近期没有重大新闻。截图最终回答中的“没有裁员、制裁升级等热点事件”应改为“当前检索未取得足够的近期新闻证据，无法确认”；产品页信息也不能直接当作最新新闻。

后续研究应优先读取搜索返回的具体新闻来源，核对日期和正文；结果持续重复或只有主页时，明确缺口并停止反复查询。抓取搜索结果页无法替代可靠新闻检索。搜索时效能力与低质量结果处理仍是后续待办，本轮没有宣称已修复。

## 验证与交付边界

17项前端定向检查及TypeScript编译通过，覆盖本次实际 API 超时格式、折叠行显示、展开保留完整回执，以及不匹配包装与外部正文拒绝。原核查属于只读 SQLite 核查和容器内网络探测；DOM 自动化不等同于真实浏览器验收。随后已在 `12f144c8` 正式发布中部署提示修复，运行源码/前端包及真实工具回执通过，[实际发布回执](quick-deploy-138-acceptance-2026-10-14.md)记录边界，页面交互由用户验收。

## English summary

The Google News web_fetch failed with request timed out after about 30.7 seconds. A bounded probe inside the live 138 container resolved DNS successfully but could not connect to port 443 within eight seconds; curl exited 28 without an HTTP response. The evidence does not identify the network component responsible and does not establish an HTTP rejection or an SSRF block.

The frontend discarded the actual timeout because its strict OpenClaw API wrapper allowlist covered only two other errors. The source fix adds an exact web_fetch timeout match and displays a short localized cause while keeping arbitrary external bodies filtered. This explanation fix was subsequently deployed in `12f144c8`; Google News connectivity remains outside that display fix. The user performs frontend interaction acceptance.

The same session contains 27 search returns, one Huawei newsroom HTTP 200 fetch with only a cookie notice/filter heading, and one failed Google News fetch. Searches produced only four distinct URL lists, largely home/product pages. The current Bing RSS provider declares only query/count and implements no date or freshness filter. These receipts cannot justify a claim that no recent major Huawei event exists. Search freshness and research quality remain follow-up work.
