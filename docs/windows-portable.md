# Windows x64 便携预览候选

更新：2026-10-08。对应 `codex/creator-workflow` 的 R24。

**当前状态：本地候选正在装配，最终 ZIP 尚未完成验收，R24 尚未完成 Git 推送，也未创建公开 Release。** 本页先说明候选的使用方式、组件范围和构建方法；实际文件名、SHA-256 与逐项结果由最终交付回执补充。不要把已有的 **0.2.6 联网安装 EXE / ZIP** 当作这个便携包：旧包保留原样，构建来源仍是 `38e728c`。

候选面向 Windows 10/11 x64，将应用、已构建前端和所需运行组件放在同一个目录。目标是完整解压后双击启动，不在用户第一次打开时执行 pip、npm 或 winget 安装。图形入口使用 Windows 的 .NET Framework；该候选尚未代码签名，也未完成全新 Windows 虚拟机的完整验收。

源码入口：[当前开发分支](https://github.com/StarrySea1412/Easel/tree/codex/creator-workflow) · [交付进度](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/secondary-development-progress.md) · [原联网安装器说明](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/windows-installer.md)

## 收到候选 ZIP 后如何使用

1. 将 ZIP **完整解压**到较短、可写的目录，例如 `C:\Easel`。不要在压缩包预览窗口内运行，也不要只取出 `Easel.exe`。
2. 双击 `Easel.exe`，保持控制窗口打开，等待网关和工作台显示就绪。浏览器随后打开本地地址；也可从控制窗口再次打开工作台。入口以窗口显示的实际地址为准。
3. 首次欢迎页可选择「先用通用模式」。打开「设置 → 模型配置 → 添加供应商」，填写自己的供应商名称、模型、Base URL 和 API Key，按需要设为主渠道并保存。包内不带现成 Key、平台账号、登录态或已配置模型。
4. 使用完毕可点击「停止服务」，或关闭 **Easel 控制窗口**，由入口停止本副本启动的服务。只关闭浏览器标签页不会停止服务。
5. 搬迁或备份前先停止服务，再移动整个目录并保留 `data`。不要在服务仍运行时移动、替换或删除该目录。

图形入口不可用时，可使用目录中的命令文件：

| 文件 | 用途 |
| --- | --- |
| `启动 Easel.cmd` | 启动当前目录的工作台并打开浏览器 |
| `检查 Easel.cmd` | 查看当前副本的服务状态 |
| `停止 Easel.cmd` | 停止当前副本管理的服务 |

命令文件与图形控制窗口的生命周期不同：**关闭命令窗口不代表服务已经停止**，请运行 `停止 Easel.cmd`。启动问题可先查看 `data/logs/portable-launch.log`，分享日志前移除个人配置与敏感信息。

本地工作台与模型服务分开准备。没有 Key 时可先进入工作台；模型调用、热榜、平台登录和发布仍需要网络及相应服务权限。渠道自测只验证其标明的接口范围，不等于真实推理或发布已经通过。本候选不预装可选 Whisper、rembg 等模型权重；相关功能首次使用时可能另行下载权重。

## 目录与数据

```text
Easel.exe
启动 Easel.cmd
停止 Easel.cmd
检查 Easel.cmd
portable-manifest.json
checksums.sha256
THIRD_PARTY_LICENSES.txt
app/
runtime/
  python/
  node/
  openclaw/
  ffmpeg/
  browsers/
data/
```

`runtime` 和 `data` 相对于解压目录定位。运行时使用包内程序，服务端配置、日志、模型缓存和产出写入本副本的 `data`，避免依赖构建者的 Python venv 或工具安装位置。首次为每个副本分配独立本地 Web 端口，后续启动和目录搬迁优先保持该地址；端口被其他服务占用时才改用新端口并提示。浏览器保存的会话与草稿与地址绑定，搬到另一台电脑或换端口时应使用工作台现有备份入口另行导出、导入。

候选归档中的 `data` 为空。构建输入不包含使用者的 `.env`、Cookie、浏览器 profile、模型凭据或个人产出。源码仍沿用本项目及上游的许可证，第三方组件各自的许可文件随包保留。

## 固定组件范围

以下为本地候选的装配目标，最终以候选中的 `portable-manifest.json` 和验收回执为准。

| 组件 | 固定版本或修订 | 说明与公开来源 |
| --- | --- | --- |
| CPython | 3.12.10 embedded amd64 | [官方嵌入版 ZIP](https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip)；保留 `LICENSE.txt`，Python 依赖使用便携包实际包集的独立精确锁 |
| Node.js | 24.19.0 win-x64 | [官方发行目录](https://nodejs.org/dist/v24.19.0/)；保留 Node 及随附组件许可 |
| OpenClaw | 2026.9.2 | [公开 npm 包](https://www.npmjs.com/package/openclaw/v/2026.9.2)；采用与已审阅严格模型选择契约对应的版本，但这不证明用户模型凭据或真实推理有效 |
| FFmpeg | 9.0.1 | [FFmpeg 项目](https://ffmpeg.org/)；实际 Windows 二进制来源、构建配置、许可与相应源码来源写入组件清单 |
| Playwright 浏览器组件 | Chromium 153.0.8010.12 / r1243 | 包含匹配的 Chromium、headless shell、FFmpeg r1011 与 winldd r1007；与 Python 包内 Playwright 的 `browsers.json` 对照，不含浏览器用户 profile 或 `.links` |

`requirements/windows-portable-py312.lock` 对应**实际装入便携 Python 的包集**，与既有 `requirements/windows-py312.lock` 分开维护。它记录精确版本；原始下载摘要、逐文件校验与来源元数据分别保留，不用版本锁代替二进制校验。

组件来源和许可说明汇总在 `THIRD_PARTY_LICENSES.txt`，前端依赖说明位于 `app/THIRD_PARTY_FRONTEND_LICENSES.txt`，原许可文件仍在相应组件目录。转发候选时一并保留这些文件、项目许可证及必要源码来源。

## 构建者准备

构建入口为 [scripts/build_windows_portable.py](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/scripts/build_windows_portable.py)。构建者准备依赖、编译入口并运行检查；最终使用者通过解压后的入口运行。

准备一个 `components.json`，顶层为 `schemaVersion: 1` 和 `components`。`components` **必须恰好包含** `python`、`node`、`openclaw`、`ffmpeg`、`browsers` 五项。每项字段如下：

| 字段 | 内容 |
| --- | --- |
| `path` | 已准备组件的显式目录；可为绝对路径或相对该 JSON 文件的路径，不得指向 venv、用户数据或链接目录 |
| `version` | 本次实际装配的版本或浏览器修订标识 |
| `source` | 对应组件的公开 HTTPS 来源 URL |
| `licenses` | 非空数组，每项是该组件目录内确实存在的许可文件相对路径，使用 `/` 分隔 |
| `sourceCode` | 可选的公开源码 URL；组件再分发需要源码来源时应填写 |
| `sourceArchiveSha256` | 可选的原始组件归档 SHA-256，用于记录来源摘要 |
| `treeSha256` | 可选的已准备组件目录摘要，按构建器的逐文件清单规则计算并核验 |

组件目录需要符合实际入口结构：

- Python 根目录含 `python.exe`、`pythonw.exe`、`python312.dll`、`python312.zip` 和相对路径的 `python312._pth`；后者启用 `Lib/site-packages`、`../../app` 和 `import site`。依赖目录须有 `00-easel-portable-runtime.pth`，内容为 `import sys; sys.dont_write_bytecode = True`，防止嵌入式 Python 忽略环境变量后由子进程写入分发文件目录。只按发行元数据 RECORD 取所需文件，排除 editable 安装、缓存、主机 `direct_url` 引用与旧 venv 启动器，重新生成可移动的命令入口。
- Node 根目录含 `node.exe` 与许可证；候选只带执行所需 Node，不带 npm/Git 或开发工具安装器。OpenClaw 目录按独立 npm prefix 布局保留 `node_modules/openclaw/openclaw.mjs` 及其运行依赖；添加需要额外安装工具的第三方插件不在开箱验收范围内。
- FFmpeg 目录保留 `bin/ffmpeg.exe` 及该构建实际需要的动态库和许可。
- 浏览器目录保留与 Playwright 修订匹配的完整程序及随附工具。只取公开程序文件，不复制 `.links`、登录 profile 或用户浏览数据。

每个组件准备完毕后记录版本、来源和校验。构建器不负责下载运行组件，也不接受把开发者的整个 venv 或已使用的安装目录直接当作输入。

在 Windows 构建机中使用开发分支，准备 Python、前端构建所需工具以及系统 .NET Framework C# 编译器。确保待打包源码已纳入 Git 索引；构建器从索引列出的允许文件装配，不自动提交 Git。默认构建会运行前端依赖安装、测试、lint 和生产构建：

```powershell
python .\scripts\build_windows_portable.py --components C:\Easel-build\components.json --output .\dist\portable-preview
```

需要分开完成前端检查时，可先保存检查回执，再在装配时复用。只有源码和构建产物摘要仍一致的回执才会被接受：

```powershell
python .\scripts\build_windows_portable.py --prepare-frontend .\.scratch\portable-frontend-checks.json
python .\scripts\build_windows_portable.py --components C:\Easel-build\components.json --frontend-receipt .\.scratch\portable-frontend-checks.json --output .\dist\portable-preview
```

输出短文件名为 `Easel-preview-<7位源码提交>-<4位源码树摘要>.zip`，并附 ZIP 的 `.sha256` 文件。短名减少 Windows「全部解压」默认目录过长的风险；完整版本和 SHA 保存在清单中，已有同名候选不会被覆盖。完成解压后，可用构建器核对包内分发文件：

```powershell
python .\scripts\build_windows_portable.py --verify-bundle C:\Easel-check
```

此检查核对文件清单与摘要，不代替 Windows 启动、真实浏览器、模型调用或平台功能验收。已运行副本的 `data` 不作为分发校验或重新打包的数据来源。

## 候选验收记录

本节由最终装配与验收结果更新。此前 R16–R23 的源码、前端和安装测试保留其原范围，不计作这个 ZIP 已经通过。

| 项目 | 本页当前状态 |
| --- | --- |
| 最终 ZIP 文件名、大小、SHA-256 | 待装配完成后记录 |
| 代码与运行组件定向检查 | 便携/发行、生命周期及明确 OpenClaw 路径合计 142 passed / 1 skipped；跳过项为主机不支持创建符号链接。C# 编译、参数及未显示窗口的状态逻辑已测，未冒充真实双击点击验收 |
| 前端重新构建 | R25 合入后重新运行 697/697、lint、TypeScript 与生产构建；现有 Three.js 大块提示保留，构建回执核对源码及产物摘要 |
| 五组件来源、版本、许可与精确 Python 包集 | 五组件输入检查通过，Python 119 个非 editable 发行包按 RECORD 摘要验证；31 项核心/媒体模块导入、pip check 及重建 Biliup 1.2.9 --help/--version 通过；待以最终 ZIP 清单核对 |
| 包内校验及敏感数据排除 | 待最终候选检查 |
| 完整解压、首次启动、停止与再次启动 | 初版装配目录已用包内 Python/Node 从 System32、隔离 PATH 启动并按身份停止；最终 ZIP 解压仍待实测 |
| 中文/空格目录搬迁、不同当前目录、系统工具不在 PATH | 待对最终候选实测 |
| 真实浏览器首页、首次引导、模型设置入口 | 初版装配目录已看到首次欢迎页并进入通用模式、设置和添加供应商表单；最终 ZIP 仍需复核；HTTP 成功不替代浏览器验收 |
| 模型与平台 | 使用者需提供凭据，尚未完成该候选的真实模型或平台发布验收 |
| 全新 Windows 10/11 虚拟机 | 尚未完成完整验收 |
| 代码签名、公开 Release、R24 Git 推送 | 尚未完成；旧 0.2.6 安装包保持原样 |

整体状态以 [持续交付清单](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/user-requirements-2026-10-08.md) 和 [交付进度](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/secondary-development-progress.md) 为准。
