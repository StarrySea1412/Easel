# 0.46.13 · GPT Responses 恢复与小红书生图

日期：2026-11-06（Asia/Shanghai）。用户授权真实请求、修复并快速更新138；优先恢复AIHub对话。

## 已证实根因

正式实例起始为0.46.11 / d42c471bedaeb90117e228a7073ad823918d465d。
持久配置的AIHub已在北京时间15:07:20保存为openai-responses，网关却从13:30:34启动且reload.mode=off。
SQLite transcript记录实际仍走openai-completions。模型保存函数仅写文件却声称“下一条消息生效”，因此配置已保存与实际生效脱节。

正式HTTPS登录后，经/api/chat/stream发送全新短会话“请仅回复 OK。”，模型aihub/gpt-6.1-sol，low，无历史/附件/技能，252秒后同样120s idle timeout。问题不依赖用户原始图片或长对话。
同一138容器、同一Key直发aihub.dog/v1/responses最小请求，3.080秒收到HTTP200和response.created；aihub.top从138约8秒连接失败。这不是模型目录可达性的推论，而是真实生成路径的对照。

## 现场恢复

无活动或未结算任务后，正常重启app加载原已保存的Responses配置，未修改120秒阈值。
正式HTTPS新会话codex-responses-20261106-90286b19fc在19.780秒返回OK，账本completed、resourceSettled=true。
SQLite会话UUID 3c1ca016-4e10-5dbc-92a3-af08ded8005c、第5条assistant实际api=openai-responses、provider=aihub、model=gpt-6.1-sol、stopReason=stop。

同时备份并只同步恢复模板aihub.api为openai-responses，避免未来空state初始化退回旧协议；保持原Key、单渠道和独立Polo图像配置。
备份路径：/home/ubuntu/easel-secrets/config-backups/20261106T082955Z-gpt-responses-04613，权限保持600/uid1000。

## 源码防复发

- 模型保存/导入返回requiresGatewayRestart，设置页明确区分保存与应用；直连API不需要重启。
- 本机用户显式应用后复用既有重启入口；启动、排队、运行期间拒绝重启，重启期间拒绝新OpenClaw请求。138等受管服务明确返回409并要求部署/服务重启，不调用可能终止supervisor子进程的本机脚本，不误报已加载。
- 网关就绪只证明配置应用动作完成，不冒充真实模型测活成功。未改变操作员reload策略、模型、Key或fallback。
- 小红书卡片组/封面必须通过easel_xhs_cards或专用生图工具，真实成功回执和图像文件才能交付；禁止HTML/截图兜底。参考图统一referenceId，逐张实际审图和当前哈希review。

## 验证与发布状态

模型配置79项、受管重启与繁忙保护11项、修复代理和卡片41项均通过；设置前端49项和依赖4项通过。前端生产构建、lint通过（lint原有警告）；远端提交和138隔离/正式发布后追加身份及真实GPT复验。
已有19.8秒正式模型恢复结果不等同所有工具、长对话或真实生图业务验收。
本轮浏览器控制因Windows无法可靠确认活动URL而停止；后续结果使用受信HTTPS真实接口与持久账本，不报告为真实浏览器交互验收。
不发布安装器，不发布小红书内容，不重放原始业务请求。

## 发布执行

发布源码：25560370fb28069f6eef301a1b223116ac298062，已推送starry同名分支并核对远端SHA。
发布ZIP SHA256：4a7ab2473a042959820b255b1f16d2118bd24b1b3adfb31de30e5acd0a635c47，2328项源文件。
前端在138完成0.46.13生产构建；旧Docker legacy builder逐步提交耗时，安装Ubuntu签名仓库docker-buildx工具（未升级/重启Docker daemon），按同一源清单和同一固定基础镜像用BuildKit完成镜像。
最终镜像：sha256:a828a9d9eb6f7e0deaf7d672be1f035b53ef866fadee3e7cd179d334cf4aff00，revision标签与发布源码相符。没有改动依赖锁或运行基础环境。

用户最新要求“不用你复测，我自己会去”。因此取消新版本切换后的真实GPT调用和浏览器复测，保留前述旧版本现场恢复证据；最终模型、工具和生图业务由用户验收。此次仅切换正式8444，隔离8445保留原版。

正式激活时间：2026-11-06T09:05:02.499112+00:00。/home/ubuntu/Easel已指向Easel-138-25560370fb28；app/browser/proxy启动完成，容器运行revision及镜像与上述身份一致，健康状态healthy，HTTPS登录入口可达（未执行登录/模型/业务复测）。停写备份：/home/ubuntu/easel-backups/20261106T090228Z.tar.gz（883MiB，0600），上一发布d42c471bedae保留可回滚。
