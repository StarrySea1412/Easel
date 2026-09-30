# Windows 使用说明

## ZIP 解压使用

1. 把整个 ZIP 解压到可写目录（建议路径短，例如 `C:\Easel`）；不要在压缩软件内直接运行。
2. 双击 **Start-Easel.cmd**。第一次会安装依赖，完成后自动打开浏览器。
3. 如果只想先安装，双击 **Install-Easel.cmd**；以后使用 Start-Easel.cmd。

首次需要联网下载 Python 依赖、OpenClaw 和 Chromium。缺少 Git、Python 3.12、兼容 Node.js 或 FFmpeg 时会尝试使用 winget 补装。ZIP 不是离线免安装包。后续启动复用已安装依赖。

资料在解压目录的 `data` 中，包括独立的 OpenClaw 配置。请保留整个目录。首次进入设置填写模型服务；社交账号需要本人登录授权，没有预置真实账号或模型密钥。

## EXE 安装

双击 **Easel-Setup-版本号.exe**，选择安装位置并开始。安装成功后点击“打开工作台”，或双击安装根目录的 **Start-Easel.cmd**。版本程序存放在 `versions`，个人资料单独存放在 `data`；升级时选择同一个安装根目录即可保留资料。

安装 EXE 内嵌应用 ZIP 和校验清单，但系统工具、运行依赖仍需要联网。未签名的测试版可能出现 Windows SmartScreen 提示；请先核对本次交付 SHA-256。不会为了绕过提示关闭系统保护。

## 端口与排错

启动器默认尝试本地 7860，已被使用时自动选择空闲端口，不会关闭占用它的其他应用。实际地址保存在 `data/workbench.json`，启动成功时也会输出。重复打开同一版本会核验 PID 和页面后复用窗口入口。

启动日志：`data/logs/launch.log`；安装记录：`data/install-state.json` 与 `data/logs/install.log`。失败后重新运行安装入口可重试。不要把 `.env`、OpenClaw 配置或浏览器账号资料上传到公开反馈中。

## 版本恢复与移除

EXE 成功升级前不切换启动器；失败时旧启动器仍可使用。成功升级后，上一版启动器保存在安装根目录的 `Easel.previous.ps1`。停止当前工作台后，可用 PowerShell 执行该文件启动上一版；恢复前备份 `data`。这是程序版本恢复，不会自动倒退个人资料或分析数据格式。

本测试安装器不注册系统卸载程序。关闭本安装的工作台与 Gateway，备份 `data` 后可以移除选定安装目录；通过 winget 安装的共享系统工具由 Windows 设置单独管理。不要删除其他应用的运行环境。
