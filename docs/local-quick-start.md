# 本机快速启动 / Local quick start

0.38.0源码运行默认将网页与执行服务分开：关闭网页进程后后台任务继续。完整停止或升级前，在相同数据目录环境下运行`python -m easel runtime status`和`python -m easel runtime stop`，有在途运行时先完成或明确停止；显式`--restart`还会在空闲关闭执行服务后处理内容迁移。参见[运行方式与验证边界](durable-runtime-0.38.0.md)。138与安装器尚未更新。

双击项目根目录的 `Quick-Start-Easel.cmd`，即可启动本机 Easel 并在默认浏览器打开工作台。默认网页端口为 **7880**；已有工作台时核对进程与页面后复用，端口被其他服务占用时使用输出的可用端口。

脚本使用当前项目 `.venv`、`data/runtime-launch.json` 和已有网关配置，不运行安装或更新。需先完成项目安装与前端构建；数据和模型配置仍保存在原项目中。网关冷启动最多等待15分钟，期间保留启动窗口；失败时窗口停留并显示日志位置。

`Quick-Start-Easel.cmd` 和 `Quick-Start-Easel.ps1` 必须放在同一目录：

- 放在项目根目录时，自动使用该项目；移动整个项目后仍有效。
- 单独解压快速启动小包到桌面或其他目录时，默认使用本机 `C:\project\Easel`。
- 自定义项目位置或端口，在 PowerShell 中运行：

```powershell
.\Quick-Start-Easel.cmd -ProjectDir 'D:\Projects\Easel' -Port 7880
```

排查问题时可添加 `-NoBrowser`。就绪后服务在后台运行，再次双击只打开现有工作台。脚本不会自动停止服务；本机日志在 `data\logs\launch.log`、`data\gateway.log` 和 `data\gateway.error.log`。

本小包只包含两个启动脚本和使用说明，依赖已安装的本地项目，不含应用运行环境、账号凭据或个人产物。完整便携包和服务器发布仍按原独立计划处理。

Double-click `Quick-Start-Easel.cmd` to launch the installed local project and open its workbench in the default browser. The preferred Web port is **7880**. The existing launcher verifies process/page identity before reusing a running instance; if another service owns the port, use the printed URL.

Keep both scripts in the same directory. In the project root they use that checkout; when extracted elsewhere they default to `C:\project\Easel`. Override the location with `-ProjectDir` and the port with `-Port`, as shown above. `-NoBrowser` suppresses opening the browser. The scripts use the existing `.venv`, `data` and gateway settings without installing or updating dependencies. Cold gateway startup waits up to 15 minutes. Failure leaves the command window open with log locations; successful services continue in the background.

The small ZIP contains only launch scripts and this guide. It requires an installed project and includes no runtime, credentials or personal output. It is separate from a full portable application or server release.
