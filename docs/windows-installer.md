# Windows 在线引导安装器

⑦连接了同一套八阶段安装核心，提供发行包构建、内嵌 SHA-256 的 EXE 和无交互安装入口。当前为本地发行候选：未上传 GitHub Release、未代码签名，干净 Windows 虚拟机的全新安装与升级验收仍需完成。构建 EXE 成功不等于公开下载地址已经可用。

## 用户入口

正式发行时同一个 Release 应同时提供 `Easel-Setup-<version>.exe`、`Easel-<version>-windows.zip` 和各自的 `.sha256`。EXE 内嵌该 ZIP 的官方 URL、版本、校验值，不接受命令行替换三者。双击后显示路径和联网安装确认，完成或失败时窗口保持打开；自动执行可传 `--yes`。

```powershell
.\Easel-Setup-0.2.1.exe
# 明确同意用 winget 安装缺失的系统工具：
.\Easel-Setup-0.2.1.exe --allow-winget
# 从已有源码目录复制缺失的 .env / profiles / outputs / assets：
.\Easel-Setup-0.2.1.exe --migrate-from 'D:\old-easel'
```

Git、Node.js、Python、FFmpeg 缺失时默认停止并给出指引。Node 要求 24.16+（24.x）或 26.1+；发行 Python 固定 3.12，OpenClaw 固定 2026.9.6。已有全局 OpenClaw 版本不兼容时停止，不直接替换它；按错误信息确认并处理后可重跑。安装依赖和包管理器会联网，首版不是离线包。

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

只对暂时网络故障自动重试：下载最多三次尝试，退避 5/15 秒；可重试安装阶段最多三次尝试，退避 10/30 秒。SHA 不匹配、HTTP 401/403/404、证书错误、权限、版本、配置和构建错误直接停止。先完整校验 ZIP 路径，再临时解压、验证清单与组件，最后发布版本目录；拒绝目录穿越、Windows 设备名、数据流、符号链接和大小写冲突。

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
python -m pip install pyinstaller==6.16.0
Push-Location web/frontend
npm ci
npm run lint
npm run build
Pop-Location
python scripts/build_windows_release.py
```

产物位于 `dist/windows-installer/`。ZIP 包含 Git 索引中的受允许源码、预构建前端、仓库许可证、前端第三方许可、`release-manifest.json` 和 Python 精确版本锁；排除真实 `.env`、账号数据、Cookie、输出、缓存、本地依赖和 README 的演示视频。EXE 另附 CPython/PyInstaller 依赖许可。构建新增文件前须加入 Git 索引，否则不会进入归档。

Python 运行依赖来自已审阅的 `requirements/windows-py312.lock`。需要更新依赖时在 Windows Python 3.12 运行 `python scripts/build_windows_release.py --lock-only`，审阅锁文件变更并重新验证。该锁固定运行包版本；第三方 sdist 构建工具与 npm/OpenClaw 的传递依赖仍取决于其各自包源，不宣称整个互联网依赖链完全离线或字节级可复现。

手动触发 `.github/workflows/windows-installer.yml` 会做安装器测试、锁文件前端构建、打包和 EXE `--help` 冒烟，只上传 Actions 产物，不自动创建 Release。公开发行前应递增 `pyproject.toml` 的版本，保留同一批 EXE、ZIP 与校验文件，不在已发布版本上替换不同内容的 ZIP；签名须使用正式证书，当前候选未签名。

源码测试可显式指定 HTTPS ZIP 与 SHA：

```powershell
python scripts/bootstrapper.py --version 0.2.1 --zip-url https://example.com/Easel-0.2.1-windows.zip --sha256 <64位校验值>
```

公开发行剩余验收：干净 Windows 10/11 无源码安装、网络中断与关闭进程后恢复、真实 Gateway 启动、已有账号数据迁移、从旧版本升级及旧入口可回退。离线测试和本机构建记录见 [四功能交付记录](secondary-development-progress.md)。
