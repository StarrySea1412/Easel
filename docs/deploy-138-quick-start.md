# 138 快速发布 / Quick deploy to 138

> 0.6.2 Agent 重试按钮已修复并在本机7880提供。部署时需从固定提交重新构建；本机开发构建不代表138升级。本次未部署或重启138。[验证范围](agent-retry-button-2026-10-20.md)。

> 2026-10-20：源码/本机构建已到0.6.2，用户要求继续修复、暂停138部署。本轮为账号页故障只读检查138，正式仍0.3.5 / `193278acf42f`；未上传、切换或重启138，安装器未发布。新浏览器会话可打开账号中心，但截图原故障根因仍未确认。0.6.2新增供应商菜单删除、内置参数直接测活、账号缓存格式校验与页面异常诊断，必须固定提交重建前后端，在隔离环境验已有配置/缓存保留、保存删除回滚、模型检测和异常编号，再按授权激活。既有网页来源、用量、浏览器、ClawHub、登录刷新与发布前拦截仍需逐项验收；真实平台发布另验。本机7880为development/revision=null，不代表138升级。[供应商验收](provider-management-2026-10-20.md) · [账号紧急排障](accounts-page-recovery-2026-10-20.md) · [网页来源](chat-sources-2026-10-20.md) · [用量图表](usage-dashboard-2026-10-20.md)。

`Quick-Deploy-138.cmd` 和 `scripts/deploy_138.ps1` 把已有的 138 发布流程串成一个入口：固定 Git 提交、生成带 `release-manifest.json` 的 ZIP、传到 138、远端校验、构建固定镜像；只有显式使用 `-Activate` 才会停写备份并切换正式服务。

2026-10-14实际隔离/正式运行均通过，同一固定镜像、HTTPS认证与真实Agent工具回执已核对；前端交互由用户验收。详见[实际发布回执](quick-deploy-138-acceptance-2026-10-14.md)。

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
