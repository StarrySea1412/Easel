> **2026-10-27：0.35.0仅源码候选，本批不部署。** 办公室只读投影依赖同一提交的前后端；保留完整outputs/_codex、_automation与_artifacts记录，升级前暂停排期并等待资源结算。没有新增原生调度者或自动重跑，回退保留记录并使用配套程序，禁止多版本共用可写数据。138与安装器未更新。[实现与验证边界](native-office-0.35.0.md)。

> **2026-10-27：0.32.0仅源码候选，本批不部署。** Codex结果核对新增会话级操作系统文件锁；共享数据目录须允许服务账户创建/锁定锁文件，不同版本实例不得并行读写同一数据目录。应用级HTTP重启复核受本机执行策略阻止，隔离单元测试、直接HTTP和浏览器原轮次回执已核对；部署138前仍需完成固定提交的升级/回滚演练并重新验收。安装器未更新。[实现与验证边界](codex-reconciliation-0.32.0.md)。

> **2026-10-26：0.31.0仅源码候选，本批不部署。** 新增版本任务计划，升级前暂停排期并核对所有在途工作会话，停止写入后备份完整数据、SQLite、scope及作品文件；固定同一提交构建前后端。旧版本不理解planned-reviewed-delivery，不能与新版共用可写数据；回退须恢复配套程序、数据与工作文件。不会自动启用/重跑旧计划，不发布安装器。[本批实现及验证边界](task-planning-0.31.0.md)。

> **2026-10-26：0.23.0仅源码候选。** 定时任务管理页及持久触发摘要需固定提交重建前后端、空闲时重启后端，保留outputs/_automation/tasks.sqlite3，不自动启用或重跑计划；沿用0.22.0确认稿和素材副本备份要求。先隔离验证旧计划、触发计数、最近状态、暂停/编辑和重启持久化。本批不部署138、不发布安装器，也未重新核实138版本。[本批升级与验证边界](schedule-center-0.23.0.md)。

> **2026-10-26：0.22.0仅源码候选。** 发布草稿新增确认稿表、素材版本和封存副本；升级需同时备份outputs/_artifacts/creation-drafts.sqlite3及publish-media目录，固定提交重建前后端。先用隔离副本验证旧稿、来源检查和重启持久化；回退需使用一致代码/静态资源及完整数据备份，旧代码不执行新版本交接检查。本批不部署138、不发布安装器，也未重新核实138版本。[升级与验证边界](creation-handoff-0.22.0.md)。

> **2026-10-22：0.14.1部署进行中。** 用户授权将网页下载、桥接修复及DeepSeek模型图标一起升级到138；app和browser sidecar必须使用同一固定候选。正式仍0.13.3，待隔离实际附件与正式切换验收。保留账号/渠道/会话及回滚点；不发布安装器，不等同GPT/Gemini全自动已完成。[当前部署回执](archive/2026/release-138-0.14.1-2026-10-22.md)。

> **0.12.0 发布回执源码交付（2026-10-21）**：独立回执页与素材指引需固定提交重建前端；知乎预检修改还需更新后端/共享脚本。账号登录资料与现有receipts.json保持，不改数据格式、不重发历史任务。正式138仍为0.11.2，本轮不自动部署。按授权发布时先在隔离环境验证回执导航、已登录知乎预检和失败提示，再切换正式。[验证与部署范围](archive/2026/publish-receipts-page-0.12.0-2026-10-21.md)。

> **2026-10-20最新实际部署**：用户恢复授权后，138隔离/正式均已更新0.7.2 / `e63a08eac773`；正式新增happycoding的5个模型，原默认不变。HTTP/运行哈希已验，最终浏览器/真实业务交用户，安装器未发布。下方暂停部署文字为历史开发记录。[本次回执、备份与空间边界](archive/2026/release-138-0.7.2-2026-10-20.md)。

> **0.7.2本机样式修复**：来源面板搜索框消除双层描边，重建前端dist后刷新即可使用；本轮仅更新本机7880，138未部署/重启，安装器未发布。

> **0.7.1本机更新**：追加侧边栏内容发布快捷入口，仍需固定提交重建前后端；本轮只更新启动7880，138未部署/重启，安装器未发布。

> **0.7.0源码交付（2026-10-20）**：供应商启停/排序增加两个独立偏好文件，备份与恢复需一并保留；固定提交重建前后端，正常重启后端才能使用新接口。先隔离验证保存、失败回滚、停用阻止新任务、模型获取与文字缩放。浏览器最终验收由用户执行。本轮不部署/重启138，不发布安装器；源码与本机构建版本不代表138已升级。[变更及边界](archive/2026/provider-flow-and-typography-2026-10-20.md)。

# 138 快速发布 / Quick deploy to 138

> 0.6.2 Agent 重试按钮已修复并在本机7880提供。部署时需从固定提交重新构建；本机开发构建不代表138升级。本次未部署或重启138。[验证范围](archive/2026/agent-retry-button-2026-10-20.md)。

> 2026-10-20：源码/本机构建已到0.6.2，用户要求继续修复、暂停138部署。本轮为账号页故障只读检查138，正式仍0.3.5 / `193278acf42f`；未上传、切换或重启138，安装器未发布。新浏览器会话可打开账号中心，但截图原故障根因仍未确认。0.6.2新增供应商菜单删除、内置参数直接测活、账号缓存格式校验与页面异常诊断，必须固定提交重建前后端，在隔离环境验已有配置/缓存保留、保存删除回滚、模型检测和异常编号，再按授权激活。既有网页来源、用量、浏览器、ClawHub、登录刷新与发布前拦截仍需逐项验收；真实平台发布另验。本机7880为development/revision=null，不代表138升级。[供应商验收](archive/2026/provider-management-2026-10-20.md) · [账号紧急排障](archive/2026/accounts-page-recovery-2026-10-20.md) · [网页来源](archive/2026/chat-sources-2026-10-20.md) · [用量图表](archive/2026/usage-dashboard-2026-10-20.md)。

`Quick-Deploy-138.cmd` 和 `scripts/deploy_138.ps1` 把已有的 138 发布流程串成一个入口：固定 Git 提交、生成带 `release-manifest.json` 的 ZIP、传到 138、远端校验、构建固定镜像；只有显式使用 `-Activate` 才会停写备份并切换正式服务。

2026-10-14实际隔离/正式运行均通过，同一固定镜像、HTTPS认证与真实Agent工具回执已核对；前端交互由用户验收。详见[实际发布回执](archive/2026/quick-deploy-138-acceptance-2026-10-14.md)。

## 快速用法

在项目根目录打开 PowerShell：

```powershell
# 只构建、上传并在 138 远端构建候选；不影响正在运行的服务
.\Quick-Deploy-138.cmd -Commit HEAD

# 先完成候选流程，再执行远端备份、激活和 HTTPS /login 探针
.\Quick-Deploy-138.cmd -Commit HEAD -Activate

# 建议先在隔离实例验收
.\Quick-Deploy-138.cmd -Commit HEAD -IsolatedTest -Activate
```

脚本默认使用 `ubuntu@192.168.0.138`、`/home/ubuntu`、`/home/ubuntu/easel-releases`，通过本机 OpenSSH 既有密钥认证。可按实际环境覆盖：

```powershell
.\scripts\deploy_138.ps1 `
  -HostName 192.168.0.138 -UserName ubuntu `
  -Commit 0ba9fe201ca384f40894545db068a093b0e21235 `
  -RemoteBase /home/ubuntu -Activate
```

## 安全边界

源码候选0.34.0含Codex目标/计划执行及定时任务运行时防休眠，本身不表示138已升级。部署必须使用已提交的固定SHA，核对前后端同版本及后端主机的Codex登录/模型和hooks；先在隔离环境按[本批执行与回退契约](codex-tasks-0.34.0.md)验收。回退前暂停Codex计划并等待资源结算，旧版本不能继续执行原生目标。防休眠设置在任务数据库`settings`表；Linux主机须确认`systemd-inhibit`可用，仅在实际任务期间抑制休眠，不能唤醒已休眠主机。

- 默认是候选模式，不会停止容器、改 symlink、重启服务或写入生产配置。
- 同一固定提交的远端目录只校验并复用，不先删除；隔离切换后的正式发布不会移除隔离实例的活动源码。校验失败停止，不能覆盖损坏或其他提交的目录。
- 激活后等待Compose容器Healthy（最多240秒），然后才检查HTTPS登录页；回滚提示根据正式/隔离模式选择当前活动管理器及对应参数。
- 镜像构建核对当前正式镜像的固定摘要和发行清单；Dockerfile、Node/Python锁文件及项目依赖声明全部一致时复用既有依赖，仍重建完整应用源码和前端。任一依赖变化走完整锁定构建，构建方式和基础镜像摘要写入远端 `image-build-receipt.json`。
- `-Activate` 是唯一的正式切换开关；远端 `manage.py activate` 会先保存 data/state/secrets 停写备份，再切换 `Easel` symlink。
- 源码只来自选定的已提交 Git SHA。工作树有未提交修改时脚本拒绝运行；`-AllowDirty` 只允许继续发布所选提交，未提交文件仍不会进入 ZIP。
- 脚本不读取或传输本地 `.env`、OpenClaw 状态、浏览器 profile、平台 cookies、个人 outputs 或 SSH 私钥。
- 远端失败发生在激活前时，候选目录和镜像会保留，正式服务不变。激活后可按输出的命令调用上一版本 `manage.py rollback`；完整双版本故障回滚演练仍需单独验收。

## 前置条件与验收

本机需要 Git、Python（优先使用项目 `.venv`）、OpenSSH `ssh/scp`；138 需要 `ubuntu` 用户的 SSH 权限、Docker、`unzip`、`curl`，以及已经初始化的 `/home/ubuntu/easel-secrets`、TLS 和 OpenClaw 状态目录。脚本会在远端运行 `verify`、`preflight` 和 Docker 构建；只有 `-Activate` 才运行 `prepare` 并接触持久环境目录。正式模式最后请求受 HTTPS 保护的 `/login`，不会把未登录的 401 误判成失败服务。

本入口不代替真实浏览器登录、Agent 工具、全菜单、代表性负载和恢复演练。部署成功只表示选定提交已通过发布清单校验、镜像构建、激活和 HTTPS 探针；仍按 [138 运行手册](../deployment/138/RUNBOOK.md) 完成版本、登录、网关、工具和页面逐项对账。

## Quick deploy (English)

`Quick-Deploy-138.cmd` and `scripts/deploy_138.ps1` chain the existing 138 release steps: export one committed Git SHA, create the manifest ZIP, upload it, verify it remotely and build the fixed image. Production backup and activation happen only with the explicit `-Activate` switch.

```powershell
# Stage and build a candidate; the running service is unchanged
.\Quick-Deploy-138.cmd -Commit HEAD

# Back up and activate the selected commit on 138
.\Quick-Deploy-138.cmd -Commit HEAD -Activate

# Run the same flow against the isolated instance first
.\Quick-Deploy-138.cmd -Commit HEAD -IsolatedTest -Activate
```

The script verifies and reuses an existing stage for the same committed SHA, so a production run cannot delete an isolated instance's active source. It refuses damaged or mismatched stages, waits up to 240 seconds for Compose health after activation, and prints the correct production or isolated rollback command.

When every Dockerfile and Node/Python dependency input matches the recorded live image, the builder reuses that fixed image's runtime while rebuilding the complete application source and frontend. Changed dependency inputs require a full locked build. The build receipt records its mode and baseline digest.

The script uses the existing `ubuntu@192.168.0.138` SSH key, never copies credentials or personal runtime data, refuses a dirty tree by default, and leaves a candidate plus image for inspection if verification or the build fails before activation. Follow the [138 runbook](../deployment/138/RUNBOOK.md) for the remaining browser, login, Gateway, tool, rollback and load acceptance boundaries.
