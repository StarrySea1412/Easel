# 本机搜索服务不可用回执核查 / Local search failure investigation

核查日期：2026-10-14。用户提供 `tool_call` / `status=error` 回执，正文为 `web_search is disabled or no provider is available.`。本轮只读核对本机既有记录和配置，并修复前端错误说明。

## 已确认的原因与来源

实际错误表示调用时搜索被禁用，或者没有可用的搜索 provider。外层 `SECURITY NOTICE` 是 OpenClaw 对外部内容的统一包装提示；它不是这次失败的根因，也不能据此判定为防火墙、GitHub、DNS或网页超时故障。

在本机 `C:\project\Easel\data\openclaw` 的 OpenClaw SQLite 中，按用户回执的包装标识 `981a629795559188` 精确命中同一会话 seq8 和 seq9：

| 记录 | 已核实的元数据 |
| --- | --- |
| seq7 父调用 | `tool_call`，参数中的工具 id 为 `web_search` |
| seq8 嵌套调用 | `openclaw.nested-tool.v1`，`toolName=web_search`，`isError=true` |
| seq8 调用起止 | 北京时间2026-10-14 15:15:53.150–15:15:53.436，约286毫秒 |
| seq9 父回执 | 北京时间15:15:53.509，`toolName=tool_call`，`isError=true`，错误包装标识与用户提供内容相同 |

该数据目录由本机7880的运行记录指向；核查时7880监听127.0.0.1、PID19440，运行共享项目 `web/app.py`。项目数据扫描74条记录；另一个默认用户状态目录最近1066条记录未命中该标识，均无解码跳过。扫描设3000条上限、单条解压1MiB上限，仅输出匹配元数据，未导出会话正文。已有本机命中足以确认这份回执的来源，不能将它归因于138当前发行。

本机项目状态的 `openclaw.json` 为 `tools.profile=full`，没有 `tools.web.search` 声明，也没有显式搜索provider插件配置；插件条目仅有anthropic/codex。完整工具profile不会自动配置搜索服务。此证据支持搜索配置缺口，但未查询运行网关的有效provider目录，不能从合并错误中进一步断言究竟命中了“禁用”还是“无provider”分支，也不能将核查时配置当作调用当时配置快照。

## 为什么界面显示没有原因

`ExecutionOperation.operationFailureReason` 原先只在行名为 `web_search` 时提取这个精确API错误；用户看到的是父调用 `tool_call`。安全包装随后被通用外部正文过滤规则移除，于是显示“工具报告失败，但未提供具体原因”。“调用工具 · 操作详情未记录”则来自通用工具名的标题规则，并不表示搜索未发起。

修复让这个已知搜索错误同时兼容现有通用别名 `tool_call`、`tool`、`mcpToolCall` 和 `dynamicToolCall`，显示已有短提示“搜索服务未配置”。仍要求JSON的字符串error、完整安全提示、`Source: API`、首尾标识一致和精确错误正文；额外正文、错误标识、非API来源与其他已知工具均继续过滤。完整回执保留在展开详情里，标题不猜测或改写真实工具身份；本轮未实现嵌套调用展示。

## 验证与交付边界

- 18项前端定向检查通过：通用别名、实际包装标识、严格负例、折叠短原因、展开完整回执，以及既有超时/执行面板回归。新增DOM检查首次复用了上一行已展开组件导致断言失败，改为独立挂载后18项全部通过；没有为该测试改动组件展开行为。
- lint通过，保留已有18条警告；TypeScript与Vite生产构建通过，保留已有大chunk和插件耗时提示。生成器仅改变换行的文件恢复原样，不作为功能变更提交。
- 上述是模拟React DOM与构建检查，未做真实浏览器交互验收；页面效果按用户偏好由用户确认。本轮没有修改搜索开关/provider/凭据、发送模型或搜索请求、重启或替换7880、部署138或发布安装器。独立分支源码修复不代表运行页面已更新或搜索已恢复。
- 本机搜索启用及真实搜索验收仍待单独实施。若后续处理，需使用Windows实际可用的provider和依赖，不可照搬138专用Linux路径；138既有真实搜索成功回执不能替代本机验收。0.2.9计划B已交付，C–F与原有未验专项继续保留。

## English

The exact supplied wrapper ID matches this machine's project OpenClaw transcript. At 15:15:53 Beijing time, the parent `tool_call` requested `web_search`; its nested receipt failed after about 286ms. The API reports that search is disabled or no provider is available. The security notice is a content wrapper, not the failure cause. Current local configuration has a full tools profile but no explicit search declaration/provider; the combined error does not identify which runtime branch applied.

The UI previously recognized this exact wrapped API error only for a row named `web_search`, discarding the cause for its generic parent. The source fix also accepts existing generic tool aliases while retaining strict wrapper filtering and the full expanded receipt. Eighteen targeted frontend checks, lint, TypeScript and the production build passed with existing warnings. No search configuration, model request, service replacement, 138 deployment or installer release occurred; actual browser acceptance and local search enablement remain separate.
