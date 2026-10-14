# 首页热点密度与平台图标 / Dashboard trend density and platform icons

## 用户要求与原因

用户截图指出首页“今日热点”显示效率低，追加要求用 icon 区分来源。原卡片向微博、抖音各请求 6 条，却只显示 3 条，并把两个来源上下堆叠；通用摘要卡片的最小高度和网格拉伸进一步增加留白。实际本机接口能返回两源内容，问题主要在展示布局和截取数量。

## 已实现

- 复用共享 `PlatformIcon` 的微博、抖音本地图标，保留平台文字与可访问的分组名称。
- 每个平台请求并最多展示 5 条，带排名；长标题单行省略，悬停可读完整标题，点击仍传递完整选题。
- 根据卡片实际内容宽度布局：达到 480px 时两源并列，更窄时单列。移除本卡片强制最小高度和网格拉伸，其他摘要卡片保持原样。
- 保留获取时间、缓存/上次可用标记、各来源错误与空状态，以及热点雷达和做内容入口。全部来源失败时仍显示具体错误，不隐藏为通用空状态。

## 验证与交付边界

| 检查 | 实际结果 | 范围 |
| --- | --- | --- |
| Dashboard / Trends 回归 | 40 / 40 通过 | JSDOM 与受控 HTTP；含平台图标、5 条上限、完整标题回调、焦点、雷达导航回调、缓存时间及全来源错误 |
| 定向 lint | 通过 | DashboardPage、DashboardCard 与相关测试 |
| 生产构建 | TypeScript 与 Vite 通过 | 保留既有大于 500kB 的 chunk 和构建插件耗时提示 |
| 本机首页与静态资源 | HTTP 200；index 和 6 个入口资源逐字节匹配新 dist | 实际 7880 服务，无需重启 |
| 本机趋势接口 | HTTP 200；微博、抖音各 5 条，均为缓存、无来源错误 | 本次真实后端请求，不能保证上游持续可用 |
| 本机状态接口 | HTTP 200，gateway=true | 未调用模型 |
| 真实浏览器布局/键盘/跳转 | 本轮未自动化验收，交由用户确认 | DOM 检查不等于真实浏览器通过；未逐一访问热点外链 |

刷新本机 <http://127.0.0.1:7880/> 可加载本次构建。功能保留在 `codex/upstream-compat-2026-10-10`；main 仅同步双语首页说明。此任务不代表 138 已部署此界面，也没有重新打包安装器或完整便携版。已有快速启动脚本交付不受影响。

## English

The home card requested six topics per source but rendered three, stacked both sources vertically and inherited a stretched minimum height. The update reuses the local Weibo/Douyin icons, renders up to five numbered topics per source, and switches to two columns when the card content is at least 480px wide. Narrow cards stay in one column; full topic titles and existing actions are preserved. Each source keeps its original cache timestamp and errors, including when every source fails.

All 40 focused Dashboard/Trends simulated tests passed, along with targeted lint and the TypeScript/Vite production build. The actual local server returned HTTP 200 for its index and six entry assets, with bytes matching the new build. Both sources returned five cached topics without errors; the status API reported gateway=true. These checks do not prove browser layout, native keyboard activation, external topic links or model execution. The user performs frontend acceptance. Refresh the local 7880 page to load the update. Main receives documentation only; this task does not deploy the change to 138 or release a new installer.
