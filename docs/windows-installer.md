# Windows 自包含安装器

安装器连接了同一套八阶段安装核心。EXE 内嵌当前版本 ZIP 和 SHA-256 清单，双击会打开 Windows 原生安装窗口，可选择安装目录、查看进度与日志，并在失败后重试。当前为本地发行候选：未代码签名，干净 Windows 虚拟机的全新安装与升级验收仍需完成。

本仓库的新构建使用 `StarrySea1412/Easel` 的 Release API 与下载地址，不再使用上游仓库的发行包。未公开对应版本时，在线发现会明确失败；不会回退安装上游版本。已有 0.2.6 EXE / ZIP 仍来自 `38e728c`，保留原样，不包含后续办公室迭代；下方旧版本命令仅作参数示例。

## 用户入口

`Easel-Setup-<version>.exe` 单文件即可双击安装，不必先把 ZIP 上传 GitHub Release。EXE 内嵌同版本 `Easel-<version>-windows.zip`、版本和校验值，不接受命令行替换。ZIP 与各自的 `.sha256` 仍单独输出，供审查和归档。GUI 中可选择目录及是否允许 winget 安装缺失的系统工具；安装进行时显示八阶段进度和脱敏日志。成功后点击「打开工作台」才会启动本地 Web 服务，并在 HTTP 就绪后打开浏览器。发行版启动脚本将 Web 绑定到 `127.0.0.1:7860`，只供本机访问。自动执行可传 `--yes`，此时使用命令行模式。

```powershell
.\Easel-Setup-0.2.1.exe
# 无交互安装并允许 winget 补齐缺失的系统工具：
.\Easel-Setup-0.2.1.exe --yes --allow-winget
# 从已有源码目录复制缺失的 .env / profiles / outputs / assets：
.\Easel-Setup-0.2.1.exe --gui --migrate-from 'D:\old-easel'
# 只读验证内嵌 ZIP、SHA、清单和 GUI 初始化：
.\Easel-Setup-0.2.1.exe --self-test
```

Git、Node.js、Python、FFmpeg 缺失时，GUI 可经选项允许 winget 补齐；Node 版本过旧时也会尝试经 winget 升级。不允许或自动安装失败时会停止并给出指引。Node 要求 24.16+（24.x）或 26.1+；发行 Python 固定 3.12，OpenClaw 固定 2026.9.6。OpenClaw 安装到选定 Easel 版本目录的独立 npm prefix，不覆盖系统全局版本。ZIP 已在 EXE 中，但 Python 依赖、OpenClaw、Chromium 和包管理器仍需联网，首版不是离线安装包。

路径：

| 内容 | 位置 |
| --- | --- |
| 每个版本的代码与虚拟环境 | `%LOCALAPPDATA%\Easel\versions\<version>` |
| 配置、账号画像、产物和素材 | `%LOCALAPPDATA%\Easel\data` |
| 阶段状态 | `data\install-state.json` |
| 脱敏阶段日志 | `data\logs\install.log` |
| 当前启动入口 | `%LOCALAPPDATA%\Easel\Easel.ps1` |
| 上一个成功版本入口 | `%LOCALAPPDATA%\Easel\Easel.previous.ps1` |

浏览器与 OpenClaw 已有的家目录登录状态继续保留；安装器不会把它们拷进发行包。迁移只补缺失的文件，深层目录同样不会覆盖；复制中断不留下一个被当作成功的半文件。版本目录中的数据 Junction 兼容既有技能的相对路径。

成功后运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Easel\Easel.ps1" web
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Easel\Easel.ps1" install status
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Easel\Easel.ps1" doctor
```

升级失败不会切换入口或删除旧版本。可用 `Easel.previous.ps1 web` 启动先前成功版本；两版本共享用户数据，这不是数据时间点回滚。新版本更改数据结构时仍需另行设计迁移与备份。

## 阶段与恢复

`system → openclaw → pydeps → frontend → chromium → profile → skills → gateway` 都有真实执行动作与结构化结果。状态绑定版本和绝对安装路径。系统与最终健康检查会重查，已完成的重依赖安装不会无条件重复；失败或中断阶段可继续。

只对暂时网络故障自动重试：需联网的下载最多三次尝试，退避 5/15 秒；可重试安装阶段最多三次尝试，退避 10/30 秒。SHA 不匹配、HTTP 401/403/404、证书错误、权限、版本、配置和构建错误直接停止。GUI 的「重试安装」会复用阶段状态，从失败处继续；已完成的重依赖阶段不会无条件重复。先校验内嵌 ZIP 和路径，再临时解压、验证清单与组件，最后发布版本目录；拒绝目录穿越、Windows 设备名、数据流、符号链接和大小写冲突。

无交互安装不要求先填写模型 Key。最终运行 `doctor --install-mode`（只跳过模型认证/路由检查）和本次安装目录的真实 Web 首页 HTTP 检查；通过后才切换启动入口。`easel doctor` 的完整模型检查仍保留。查看状态和日志后，可运行 `install reset --phase <id>` 清除某阶段状态再重试；它不卸载组件。

开发者源码入口仍可使用：

```powershell
.\setup.ps1 -NonInteractive
.\setup.ps1 -NonInteractive -DataDir 'D:\easel-data'
# 调试单个实际阶段（由 runner 调用时自动记录阶段结果）：
.\setup.ps1 -Phase frontend -NonInteractive
```

## 构建与发行

Windows Python 3.12、Node.js 24.16+ 和 Git 环境中：

```powershell
py -3.12 -m pip install pyinstaller==6.22.3
Push-Location web/frontend
npm ci
npm run lint
npm run build
Pop-Location
py -3.12 scripts/build_windows_release.py
```

产物位于根目录 `dist/`，包括 `Easel-Setup-<version>.exe`、`Easel-<version>-windows.zip`、各自的 `.sha256`、`release.json` 与第三方许可。EXE 内嵌 ZIP 和校验清单。ZIP 包含 Git 索引中的受允许源码、预构建前端、仓库许可证、前端第三方许可、`release-manifest.json` 和 Python 精确版本锁；排除真实 `.env`、账号数据、Cookie、输出、缓存、本地依赖和 README 的演示视频。EXE 另附 CPython/PyInstaller 依赖许可。构建新增文件前须加入 Git 索引，否则不会进入归档。

Python 运行依赖来自已审阅的 `requirements/windows-py312.lock`。需要更新依赖时在 Windows Python 3.12 运行 `python scripts/build_windows_release.py --lock-only`，审阅锁文件变更并重新验证。该锁固定运行包版本；第三方 sdist 构建工具与 npm/OpenClaw 的传递依赖仍取决于其各自包源，不宣称整个互联网依赖链完全离线或字节级可复现。

手动触发 `.github/workflows/windows-installer.yml` 会做安装器测试、锁文件前端构建、打包和 EXE 冒烟，只上传 Actions 产物，不自动创建 Release。公开发行前应递增 `pyproject.toml` 的版本，保留同一批 EXE、ZIP 与校验文件，不在已发布版本上替换不同内容的 ZIP；签名须使用正式证书，当前候选未签名。窗口模式 EXE 的自检应通过退出码判断，而非依赖控制台输出。

源码测试可显式指定 HTTPS ZIP 与 SHA：

```powershell
python scripts/bootstrapper.py --version 0.2.1 --zip-url https://example.com/Easel-0.2.1-windows.zip --sha256 <64位校验值>
```

公开发行剩余验收：干净 Windows 10/11 无源码安装、网络中断与关闭进程后恢复、真实 Gateway 启动、已有账号数据迁移、从旧版本升级及旧入口可回退。离线测试和本机构建记录见 [四功能交付记录](secondary-development-progress.md)。
