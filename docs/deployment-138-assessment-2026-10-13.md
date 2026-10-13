# Easel 在 192.168.0.138 的部署评估

日期：2026-10-13（Asia/Shanghai）。状态：研究与实施建议，尚未部署。用户最新范围：先研究部署，暂不调整界面层级；不要求指定6.1 sol，Codex可用则保留，不可用则不阻塞OpenClaw主体。

## 推荐方案

采用独立 Docker Compose 项目 `easel`，包含入口 nginx 和一个非root应用容器。FastAPI、OpenClaw Gateway及可选Codex运行时先放在同一应用容器，保留现有localhost/stdio通信方式；使用明确的进程管理与信号清理，不用后台脚本充当容器主进程。单个FastAPI worker，任务锁和活跃状态目前在进程内，不能直接增加worker。

先使用独立HTTPS入口，例如 `https://192.168.0.138:8444/`（候选，发布当天复查端口和防火墙）。应用端口和Gateway不直接对局域网开放；nginx只将请求代理到应用容器，TLS和认证覆盖页面、全部API、SSE、媒体及下载。AI-skills现有80/443及Compose项目继续独立运维。

后续如果有内网域名/DNS，再讨论443按主机名分流；IP下的`/easel/`也可作为后续方案，但前端、下载URL、重定向和SSE须逐项验收。虽然Vite使用相对base、请求封装推导当前pathname，不能由此声称所有子路径已可用。

第一版目标是可信操作者使用的共享单工作台。多人独立账号、独立聊天/平台登录态、权限和费用账本需要专项改造，代理认证不会自动实现数据隔离。

## 已读取的138文档与现场证据

本地来源位于 `C:\project\AI-skills\docs\deployment\`：

- `local-server-192.168.0.138.md`：ZIP发布，`AI-skills.new.$STAMP`切换，`AI-skills.prev.$STAMP`回滚，Compose项目`ai-skills`，入口80/443。
- `部署指南.md`：依赖、容量预检、持久配置和备份、镜像及数据库回滚。
- `unified-reverse-proxy-192.168.0.138.md`：Proposed，2026-09-07修订明确138当时仅统一AI-skills且无需实施多服务总网关，不能当作现有拓扑。
- 补充读取`2c4g-config-and-rewrite.md`：历史低资源运行约束，不能当作当前机器配置。

2026-10-13约12:09（Asia/Shanghai），使用已有SSH身份、BatchMode及StrictHostKeyChecking执行只读检查：

| 项目 | 现场结果与限制 |
| --- | --- |
| 系统 | Ubuntu 24.04.4 LTS，x86_64，6个CPU逻辑核心 |
| 内存 | 9902 MiB总量，约6485 MiB available，无swap；单次快照不代表峰值余量 |
| 磁盘 | 根盘39G，已用24G，剩余16G；镜像、浏览器、依赖及备份共享该盘 |
| Docker | Engine 29.1.3，Compose 2.40.3 |
| Python | 宿主机3.12.3 |
| 依赖 | 宿主机PATH未找到Node、Codex、OpenClaw、FFmpeg，不等于所有容器均缺失 |
| 入口 | 80/443已有监听；另有8088、8090、8091、8092、8095、18080等服务 |
| 现有服务 | 本机HTTPS `/api/health/`返回`status=ok`；使用`curl -k`仅核实HTTP，不证明浏览器信任证书 |
| 发布目录 | `/home/ubuntu/AI-skills/.git`不存在 |
| 模型渠道 | 无凭据GET `https://aihub.top/`在15秒超时，HTTP状态000；不能外推所有API路径不可用，须验证DNS/TLS/实际Responses接口 |
| 包仓库 | npm OpenClaw 2026.9.6元数据HTTP200；Codex 0.147.0元数据已在本机取得，Linux x64是同包的`0.147.0-linux-x64`别名版本 |

没有更改服务器文件、安装依赖、启动容器或停止现有服务。没有发送真实模型请求或迁移任何凭据。

## 代码、数据与身份布局

建议以下服务器布局（全部为待实施设计）：

```text
/home/ubuntu/Easel/                 当前发布代码与Compose定义
/home/ubuntu/Easel.new.<stamp>/     候选代码
/home/ubuntu/Easel.prev.<stamp>/    回滚代码
/home/ubuntu/easel-data/            outputs、profiles、运行记录、.env
/home/ubuntu/easel-state/           OpenClaw、Codex及浏览器状态
/home/ubuntu/easel-secrets/         入口认证、TLS、模型凭据
/home/ubuntu/easel-backups/         发布前数据/状态备份及版本回执
```

容器内固定代码路径`/app`，数据路径`/data`和身份路径`/state`。换服务器代码目录不改变容器内路径，避免Codex持久工作目录随版本改变失效。

显式设置`EASEL_DATA_DIR=/data`、`EASEL_ROOT=/app`、`EASEL_OPENCLAW_STATE_DIR=/state/openclaw`、`OPENCLAW_STATE_DIR=/state/openclaw`、`OPENCLAW_CONFIG_PATH=/state/openclaw/openclaw.json`和`EASEL_CODEX_HOME=/state/codex`。Gateway端口明确配置且只内部可达，独立设备身份重新审批；不复用开发机和便携副本状态。浏览器profile实际路径逐平台核对并映射持久卷，不能认为全部已经服从DATA_DIR。

入口认证可先用独立HTTPS nginx用户名/密码保护可信操作者的工作台，密码按正常哈希保存；不复用AI-skills Django认证，也不直接信任浏览器传来的身份头。生产凭据独立；`gaojitest/gaoji`仅可在隔离测试环境验收，不能作为该生产机入口的默认账号。

当前`TrustedHostMiddleware`与`local_write_guard`要求正确Host和精确Origin。入口示例需配置`EASEL_EXTRA_HOSTS=192.168.0.138`、`EASEL_EXTRA_ORIGINS=https://192.168.0.138:8444`并验证代理头/客户端地址；来源检查是CSRF/本地访问保护，不是身份认证。没有Origin的代理写请求与转发头必须专项检查，不能通过全面放开来源解决。

浏览器中的会话列表、草稿和部分偏好采用本地持久化，换浏览器/地址/端口会形成新来源存储；服务器卷保留不等于客户端草稿全部迁移，应使用已有导出/导入并验证。备份中的历史记录不能绑定为新服务器上的活跃任务。

## Linux运行依赖与工程差距

- Python建议3.12；Node固定兼容版本（现有OpenClaw要求24.16+的24.x或26.1+）。Linux镜像自行安装依赖，不复制Windows`.venv`、Node可执行文件或便携包。
- 构建阶段执行`npm ci`和干净前端构建；镜像必须含`web/frontend/dist`、全部共享脚本/技能及许可归属，不只是Python wheel。
- 基线包括FFmpeg、Chromium/Playwright系统库、OpenCV需要的动态库。当前Python依赖还包含faster-whisper、rembg等重依赖；先量化镜像大小和启动内存，不在首版自动下载全部模型权重。媒体任务与浏览器限制并发，初始一个活跃Agent/一个重任务为运维门槛，需实现/验证全局限流，不能声称已有。
- OpenClaw固定2026.9.6作为当前项目验证基线，升级另审；Codex可选固定0.147.0，代码只允许该版本。
- `setup.sh`包含全局Node安装和OpenClaw latest行为，不直接在共用生产宿主机运行。`scripts/start_workspace.py`的listener归属检查调用PowerShell，不用它作为Linux服务入口。
- FastAPI可直接使用容器内Python启动`web/app.py`；应用容器内绑定`0.0.0.0`供nginx访问，不发布宿主机端口。OpenClaw绑定loopback，与应用共享网络空间。进程管理器需分别监管Web/Gateway与Codex子进程，支持有界日志、健康检查和优雅退出。
- SSE代理关闭buffering/cache，支持15秒心跳和长读超时，不能只检查首页200；WebSocket若有代理需求须明确Upgrade，但Codex stdio不会直接暴露到浏览器。
- 当前没有项目专用Dockerfile/Compose生产定义、入口认证验收或Linux整体运行回执，部署准备仍需实现。

## Codex作为可选引擎

现有`easel/codex_client.py`使用版本锁定的App Server stdio子进程，具备Linux可执行文件解析分支；`codex_service.py`提供真实模型列表、任务/事件、命令与文件回执及审批。理论上可以随Linux镜像部署，尚未在138安装/实测，不能报告Codex已经在服务器接通。

本机只读证据：Codex CLI 0.147.0；配置模型`gpt-6.1-sol`，自定义Responses渠道，使用配置中的bearer字段（未打印值）。现有7880运行时与新启动的0.147.0元数据进程均列出5.6等模型，没有6.1。用户已取消指定模型门槛，不为此阻塞上线或盲目升级CLI。

如保留自定义渠道，在服务器独立Codex目录写经过审阅的配置，凭据单独注入环境`env_key`或受控secret，避免把本机含token的整份config、Windows路径、MCP配置和个人状态打包。ChatGPT登录是另一种选择：官方支持设备码或SSH转发localhost回调，也描述了经SSH转移auth缓存的备用办法；这并不是当前自定义渠道的必要步骤，本轮不迁移登录态。之前“不能迁移缓存/必须重新登录”的笼统判断由本节纠正。

Codex验收门槛：Linux0.147.0启动/退出及协议初始化→实际模型列表→隔离样本一轮文字、文件和命令回执→审批拒绝/停止→刷新/断线恢复→服务重启未确认状态。不把metadata available或model/list当成推理成功。安装或调用无法通过则设置默认OpenClaw并禁用Codex入口，不自动把失败的Codex任务重发给OpenClaw。

当前Codex服务明确`skills=False`、`agentOffice=False`，并拒绝携带Easel技能选择的任务。保留Codex也不意味着运营技能/办公室能自动使用它；首版运营功能仍依赖OpenClaw。

## ZIP发布、核版与回滚

1. 发布前先收口既有未提交工作，运行对应检查并提交；从确定的commit导出源码，加入该commit构建的前端及构建回执。当前工作区仍有其他任务未提交，不能把它标作HEAD发布包。
2. 发布清单记录Git SHA、每个源码文件相对路径及MD5/SHA-256、前端构建摘要、ZIP SHA-256、镜像digest和依赖版本。138无Git，按清单逐文件核验；仅校验ZIP传输MD5不能证明运行容器来自本地HEAD。构建产物按构建回执核验。
3. ZIP排除.env、Codex token/config秘密、平台登录态、个人outputs、.git、node_modules和Windows依赖；秘密与数据由受控目录/卷提供。ZIP结构与Compose变量先离线检查。
4. 上传到Easel专用位置，解压到`Easel.new.$STAMP`；先检查CPU/内存/磁盘、端口、HTTPS与模型出口，再备份Easel数据、身份、入口配置及旧镜像digest。无需迁移AI-skills数据库。
5. 镜像使用固定发行标签/digest，在受控构建机或138低负载窗口预构建；不先停止服务临时安装。核验候选镜像、进程、健康与代理配置，再切代码目录并重建`easel`服务。首次上线不操作`ai-skills`项目。
6. 回滚恢复旧代码及旧镜像digest；兼容持久卷继续保留。若新代码改变了状态格式，先停止写入，再按发布前备份有计划恢复，避免覆盖新产物。旧源码目录本身不包含全部持久数据。
7. 验收成功后保留至少一版镜像/目录和备份，记录版本回执。源码推送、ZIP制作、服务器上线分别记状态。本轮仅研究，没有打包或上线。

## 下一步顺序与验收

| 阶段 | 工作与退出条件 |
| --- | --- |
| P0 部署准备 | 独立镜像/Compose、持久目录、认证/来源保护、进程健康、并发和日志上限；离线配置/构建检查 |
| P1 Linux隔离试跑 | 固定运行时及无秘密样本；OpenClaw设备身份批准；可选Codex协议检查 |
| P2 138试运行 | 候选HTTPS入口，真实浏览器逐项菜单/跳转/保存/上传/下载/技能/账号扫码/390px；原AI-skills回归 |
| P3 实际调用 | 经任务授权的模型小样本、工具/文件结果与SSE重连/停止；平台登录逐个验证，发布另外授权 |
| P4 正式交接 | 全文件摘要/镜像版本、持久数据与回滚演练、峰值资源/磁盘观测、准确未验事项 |

建议先确保OpenClaw工作台上线，再验收可选Codex；不为桌面框架或指定模型扩展本轮范围。不需要GPU来调用云端模型，但FFmpeg、浏览器、转录等本地任务有独立资源开销。

## 官方依据与验证边界

本轮OpenAI Docs首次shell访问被Forbidden/Cloudflare阻断，随后真实浏览器实际读取以下官方内容：

- [Authentication](https://learn.chatgpt.com/docs/auth)：ChatGPT/API及自定义provider认证、独立CODEX_HOME、headless设备码/SSH回调/备用缓存迁移。
- [Advanced configuration: custom providers](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)：base_url、wire_api、env_key及外部认证机制。

npm0.147.0元数据确认包含Linux x64/arm64别名产物；此前向不存在的独立包版本请求404，已用主包optionalDependencies澄清，不作为Linux不支持的证据。官方模型目录查找未取得完整正文，不据本机配置或第三方别名保证特定模型来源、可用性和计费。

本轮已完成本地源码/文档审阅、只读SSH容量/端口/健康/出口检查及本机真实Codex元数据查询。未执行Linux安装、生成/上传发布ZIP、修改138反代、实际模型推理、平台发布、入口认证登录和部署浏览器验收。
