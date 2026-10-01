# Windows 使用说明

本文适用于 [StarrySea1412/Easel 的 `codex/creator-workflow` 分支](https://github.com/StarrySea1412/Easel/tree/codex/creator-workflow) 的 Windows 安装器。版本与使用范围以[本仓库说明](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/README.md)及实际交付包为准；不要把上游版本当作本分支的定制构建。

## 普通用户：图形压缩包 / EXE

1. 将 **Easel-版本号-Windows-GUI.zip** 完整解压；不要在压缩软件内直接运行。
2. 双击里面的 **Easel-Setup-版本号.exe**。单独下载的同名 EXE 使用方式相同。
3. 在图形向导中选择安装位置，点击“开始安装”，查看阶段进度；失败后按提示重试。
4. 安装成功后点击“打开工作台”，浏览器会打开网页工作台。
5. 以后双击安装目录中的 **打开 Easel.vbs**，图形启动窗口会显示进度；启动失败可以查看日志或重试。

首次需要联网下载 Python 依赖、OpenClaw 和 Chromium。缺少 Git、Python 3.12、兼容 Node.js 或 FFmpeg 时会尝试使用 winget 补装。ZIP 不是离线免安装包。后续启动复用已安装依赖。

程序保存在所选安装目录的 `versions` 中，资料在同级 `data` 中，包括独立的 OpenClaw 配置。首次进入设置填写模型服务；社交账号需要本人登录授权，没有预置真实账号或模型密钥。

## 升级与源码包

升级时运行新版 EXE 并选择同一个安装根目录。安装完成后切换到新版入口，个人资料仍保存在 `data`。不要用新版文件直接覆盖旧版目录。

**Easel-版本号-windows.zip** 是开发/排错用源码载荷，解压后 `Start-Easel.cmd` / `Install-Easel.cmd` 会使用命令行安装入口。面向普通用户请使用上面的 **Windows-GUI.zip** 或 EXE。

安装 EXE 内嵌应用 ZIP 和校验清单，但系统工具、运行依赖仍需要联网。未签名的测试版可能出现 Windows SmartScreen 提示；请先核对本次交付 SHA-256。不会为了绕过提示关闭系统保护。

## 端口与排错

启动器默认尝试本地 7860，已被使用时自动选择空闲端口，不会关闭占用它的其他应用。实际地址保存在 `data/workbench.json`，启动成功时也会输出。重复打开同一版本会核验 PID 和页面后复用窗口入口。

启动日志：`data/logs/launch.log`；安装记录：`data/install-state.json` 与 `data/logs/install.log`。失败后通过图形窗口重试。不要把 `.env`、OpenClaw 配置或浏览器账号资料上传到公开反馈中。

在工作台“设置 → 保存位置”可选择新的空目录。结束创作任务后，双击“打开 Easel.vbs”，确认“重启并迁移”。关闭浏览器本身不会停止后台服务。重启时复制并校验内容、保留原目录备份；浏览器会话、持久 Cookie 和模型配置保留在原数据位置。内容目录内的临时工作记录也会迁移。迁移失败会显示原因，原内容保持可用。

## 版本恢复与移除

EXE 成功升级前不切换启动器；失败时旧启动器仍可使用。成功升级后，上一版启动器保存在安装根目录的 `Easel.previous.ps1`。停止当前工作台后，可用 PowerShell 执行该文件启动上一版；恢复前备份 `data`。这是程序版本恢复，不会自动倒退个人资料或分析数据格式。

本测试安装器不注册系统卸载程序。关闭本安装的工作台与 Gateway，备份 `data` 后可以移除选定安装目录；通过 winget 安装的共享系统工具由 Windows 设置单独管理。不要删除其他应用的运行环境。
