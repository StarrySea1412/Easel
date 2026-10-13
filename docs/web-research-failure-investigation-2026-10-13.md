# 网页研究多次失败调查

日期：2026-10-13。对应138真实会话为`agent:main:mv6hpx3osm6jtk`，本轮时间为北京时间17:40:22–17:43:06。调查读取实际工具回执和运行环境，并做少量独立HTTP检查；没有发送新的模型任务、改变服务器配置或切换发行。

## 结论与真实回执

这次失败由搜索服务未配置、连续猜测不存在的URL、Google地址安全拒绝、容器缺少curl共同造成，并非服务器完全无法访问外网。46次工具调用中18次明确失败，另8次命令没有获得有效抓取数据却返回退出码0；20次网页读取取得非空正文。

| 工具与结果 | 次数 | 实际原因 |
| --- | ---: | --- |
| web_search失败 | 2 | `web_search is disabled or no provider is available.`；当前没有搜索provider/凭据 |
| web_fetch HTTP404 | 13 | Apple、The Verge、MacRumors等多个猜测地址不存在；未先确认URL并及时换方法 |
| web_fetch安全拒绝 | 2 | Google搜索页解析触发`Blocked: resolves to private/internal/special-use IP address` |
| exec明确失败 | 1 | 缺少curl；`shell-command-not-found`，退出127 |
| exec管道退出0但未抓到数据 | 8 | curl缺失的错误被`2>/dev/null`隐藏，后面的python/grep/head返回0 |
| web_fetch HTTP200 | 20 | 取得非空正文，但还须验证标题、最终URL和所需信息 |

这些不是同一个请求自动重试46次，而是模型在缺少搜索能力后不断尝试来源和终端替代方法。两次搜索失败后仍继续用猜测URL；同类404出现后没有及时停止。现有通用网页规则没有约束这一行为。

HTTP200也不等于研究有效：部分The Verge请求跳到无关的Microlino文章，Apple商城正文没有抽出所需价格。最后CNET评测实际包含`$1,199`与`$1,299`，因此不能据失败次数断言最终价格全是编造。

## 环境核查与独立HTTP检查

- 容器实际`curl`和`wget`均不存在，Python和Bash可用。原Dockerfile没有安装curl。没有在运行容器中临时安装工具。
- tools配置只有`toolSearch=false`；这项解决工具schema兼容，不会自动提供搜索服务。运行环境未配置搜索provider或相关搜索凭据。
- 独立Python HTTP检查：example.com和Apple主页返回200；截图Apple newsroom地址、The Verge地址与MacRumors地址返回404；Apple specs地址返回200。Google请求约15秒后报网络不可达。此检查是直接HTTP结果，未冒充新的OpenClaw工具验收。
- 同一容器的Google DNS解析包含`2001::1`特殊用途地址，且IPv4也呈异常解析；这与安全拒绝一致。不能仅据本轮检查定位DNS上游责任，不能通过关闭SSRF校验、固定IP或代理绕过该拒绝。
- Chromium已安装；OpenClaw支持自动发现Playwright浏览器与Linux无DISPLAY时headless。此次会话没有browser调用，不能宣称浏览器损坏或已经验收通过。

## 已实现的源码修正

1. 部署Dockerfile加入curl依赖。运行镜像仍是原发行，本轮没有重建镜像，不能称服务器已有curl。
2. 全局AGENTS与每轮提醒增加网页研究规则：来源URL确认、搜索不可用停止重复、404回到实际链接导航/换来源、同域同类失败两次改方法、超时/5xx有限退避、保留安全校验；命令先检查客户端、保留stderr并检查管道/HTTP/有效非空结果；HTTP200还需检查内容相关性。取消“外网代理已配置”的未核实假设。这些属于模型行为约束，尚不是确定性的工具调用门禁。
3. 失败行折叠时显示一行具体原因，映射搜索未配置、HTTP404、地址安全拒绝和命令不存在；完整回执保留在详情中。过滤外部包装、HTML、URL及控制字符，最长100字；成功/退出0不由UI重新判失败，不新增汇总或每次弹窗。

消息组装3项回归及发行导出2项检查通过；失败展示及既有执行面板15项DOM检查通过，包含真实API包装样本和负例，最终TypeScript检查通过。不能将历史重跑数量相加重复计数。没有生产构建、实际浏览器页面验收或新模型网页任务验收。

## 下一次完整部署的必要条件

- 收录本轮修正与[完整发布范围](deployment-summary-2026-10-13.md)，从统一提交重建并验证curl真实存在且HTTPS状态/退出码检查有效。Docker依赖输入已改变，不能直接沿用旧镜像冒充依赖已补。
- 配置并实际验证一个搜索provider。DuckDuckGo无Key模式需要安装对应插件且属于实验性HTML方案；SearXNG需要对应插件、独立受控服务和JSON配置。当前镜像没有这些插件，不能只改provider字符串，也不擅自使用其他项目的SearXNG服务。
- 在候选环境真实验证OpenClaw浏览器启动和受控页面读取，根据实际错误修正；不能把已安装Chromium等同于可用的browser工具。
- 重跑一条受控网页研究任务，检查搜索来源、原文相关性、终端有效结果与失败处理；未知地址或不通网站可以准确报告失败，不要求第三方网站全部成功。正式版本与界面同步按既有备份、候选验收流程处理。

原始脱敏调查证据保存在本地`outputs/easel-ui-2026-10-13/web-failure-audit-2026-10-13.json`，不提交用户会话产物；回执源为服务器OpenClaw SQLite的`transcript_events`，包含压缩事件，统计已解压。此次服务器仍运行v0.2.7/build1a324540854c。
