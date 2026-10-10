## 2026-10-10 最新便携交付回执

- **本轮可交接文件**：`dist/portable-20261010/Easel-preview-2f1818d-c38a.zip`，Windows x64 便携预览版，1,169,390,503 字节。完整解压到短、可写目录（如 `C:\Easel`），再运行 `Easel.exe`；也可使用启动/检查/停止 CMD。
- 固定源码：`2f1818d4d11d0ea09968fb1e83af76a90a30a1c1`；`sourceDirty=false`、仅Git跟踪文件，ZIP内`data/`为空，不含用户Key、平台登录态或个人作品。后续交付文档提交不会改变此ZIP来源。
- SHA-256：`6407d221b4ff92a9d25f02c0906b06da3c66310829558484b3b8f469eeaf765b`；同目录 `Easel-preview-2f1818d-c38a.zip.sha256` 可校验。
- 检查：最终全量前端 **916通过、0失败**，npm ci/lint/生产构建完成；账号及便携后端250通过1跳过（此前定向结果，不当作后端全仓全量）。三处旧导航/图标断言已修正，相关20项复跑通过。
- 构建换行回执：prebuild仅将生成JSON的CRLF改为LF，内容与HEAD一致；恢复原源码后跳过重复生成再次编译，生产产物逐字节一致，源码/产物哈希重新验证通过，未修改测试结果。
- Windows路径回执：长临时目录触发网关依赖文件路径限制，首次装配中止且未产出ZIP；改用短构建路径完成后移入dist。使用时仍须完整解压到短目录（如`C:\Easel`），不要使用多层嵌套交接目录。
- 打包性能回执：对已复制文件逐项对比源/目标SHA后复用，后续复制仍使用原装配器；文件哈希改12路并发，归档前完整清单、路径/链接、逐文件SHA保护均保留。运行脚本为本次构建辅助，不修改发行源码。
- 归档性能回执：保留已完成的压缩条目并重建ZIP中央目录（先通过小样本恢复检查），剩余文件12路读取、按顺序压缩，整包解压逐条CRC检查；不把未关闭的中间ZIP交付。
- 包体实测：归档前每文件SHA校验、ZIP SHA-256、完整解压CRC/文件清单与关键入口/前端SHA校验、空data首次启动、首页及API/静态资源HTTP、真实浏览器入口跳转通过；独立副本停止→重新启动→停止通过，原7880工作台仍可访问。界面入口明细另见交付验收单；不将HTTP检查当作浏览器操作。
- 手册、checklist与验收单已更新，dist同目录提供当前手册；包内文档固定于构建源码。全新Windows机器和原生GUI双击尚未实测；其他平台真实投稿、付费生成及SMTP未扩展验证。小红书此前唯一授权投稿经用户App确认公开正确，自动网页读回仍未知，未重复发布。
- [x] 本轮全量前端检查、便携归档、空数据首启、隔离启停与浏览器入口验证完成。
- [x] 运营手册、用户checklist及dist交接文件同步完成；源码和交付文档的Git回执分别记录。

以下保留历史迭代记录；涉及旧候选或“尚未打包”的旧描述由本回执覆盖。

> 2026-10-10 本轮新包要求：迭代及原始main兼容检查完成后，更新运营交接手册并重新构建便携ZIP，实际解压/首启/菜单检查和SHA-256另取证。下文76bbaf6候选为历史版本，不包含本轮新增功能，不能作为新包交付回执。

# Windows x64 便携预览候选

更新：2026-10-09。对应 `codex/creator-workflow` 的 R24/R27/R28。

**当前状态：包含审核后核实功能的 R27 候选 `Easel-preview-76bbaf6-3fb7.zip` 已完成实际解压、归档前后 52,694 项完整文件 SHA 校验，以及新解压副本的隔离首启、HTTP、模块导入、包内 Chromium 与所列工作台浏览器入口验收。** 浏览器已走通欢迎引导、设置、技能和发布回执相关入口，测试草稿已清理。旧 `20a709c` / `0b56` 的 PDF、停止隔离和搬迁检查保留为历史证据，不代替新包验收。图形入口双击、全新 Windows 虚拟机、真实模型／平台、代码签名和公开 Release 尚未完成。已有的 **0.2.6 联网安装 EXE / ZIP** 保留原样，构建来源仍是 `38e728c`，与便携候选分别记录。Git 回执见 [持续交付清单](user-requirements-2026-10-08.md)。

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

## R28 当前候选补验（2026-10-09）

用户要求“继续测试”后，仍使用下文同一个 `76bbaf6-3fb7` ZIP 的实际解压副本；没有重新打包，也不继承旧 `20a709c` 包的测试结论。重复启动、停止/重启、中文空格目录搬迁与数据保持正在依次检查，浏览器已设置并刷新验证本轮专属未发送草稿和已选技能，搬迁后还需复核并清理。

包内 PDF 补验已通过。从 System32 使用该副本的嵌入 Python，pdfplumber、pdfminer.six 和 PDFium 均读到测试 PDF 的精确文本和 1 页；包内原生 PDFium 渲染得到 **612×792** PNG，像素检查和目视检查通过。Python、141 个实际导入文件及加载的 PDFium DLL 来源与分发 SHA 一致。仅复用通用的一页英文测试输入，结果在当前包重新取得；未覆盖 OCR、扫描件、复杂字体或大文件。

第一次预检因为先前 Chromium 运行生成的 `debug.log` 不是分发文件而停止，未开始解析 PDF；再次检查单独记录这个既有日志，未删除或修改它。分发目录前后文件清单、大小和修改时间一致；这不是重新执行整包字节校验。原始 PDF 回执及失败记录位于忽略的 `.scratch/portable-r28-qa/pdf/acceptance.json`。

准备通过 Explorer 打开图形入口时，原生窗口截图超时；刷新窗口清单、重新绑定后，激活操作仍失败。本次没有启动 `Easel.exe` 或进行图形输入，不能据此判断产品按钮通过或存在缺陷。主机为已有开发环境的 Windows 10 Pro 19045，当前未找到 Windows Sandbox 启动程序及可用的 Hyper-V/VMware/VirtualBox 管理命令；只读可选功能查询要求提升权限，未修改系统功能。因此尚未取得干净 Windows 验收环境，也不能把当前开发机当作全新系统验收。原生尝试与环境检查分别记录在忽略的 `.scratch/portable-r28-qa/native-gui-limitation.json` 和 `clean-windows-feasibility.json`。

## R27 补验与包版本边界

2026-10-09 使用同组件装配副本的嵌入 Python，从 System32 和隔离环境分别实际启动默认 headless shell、完整 Chromium 的 headless 模式，版本均为 **153.0.8010.12**。两种浏览器访问本地 HTTP 页面，完成按钮交互和截图，执行文件 SHA-256 与旧分发清单一致；这补齐了原来的“只能导入 Playwright”边界，仍不代表真实平台登录通过。

原生 `Easel.exe` 运行及其服务就绪已观测，但 Explorer 激活、Windows 桌面截图与坐标输入失败，界面文字仍观测为“正在启动工作台”。对相同源码的无窗口探针分别输入模拟成功、真实本地状态和模拟启动结果，回调在 197–395ms 内更新控件，未复现确定的产品缺陷；这些探针不能替代实际 GUI 交互，因此按钮、关闭窗口及双击流程仍未验收。当前主机是已有开发环境的 Windows 10，未取得干净 Windows 虚拟机验收条件。

上述补验没有修改旧 `20a709c-0b56` ZIP。R27 审核后核实代码已作为 `76bbaf690d224cf2c60496847402426a4619b5c3` 推送，最终前端 **700/700**、lint、TypeScript 和生产构建通过，Python 全量 **2070 passed / 7 skipped**；测试探针的编译输出编码修正后，该项以 `-W error` 通过。新包固定该源码，五组件与最终前端回执均按字节复核。旧包及 A65028／主7870保持原样，补验用 B 副本已停止。原始证据位于忽略的 `.scratch/portable-r27-qa/`。

## 当前候选文件与完整性校验

R27 归档与实际解压验收于北京时间 **2026-10-09 06:02:09** 完成。文件保存在构建机的 `dist/portable-preview/`，目前尚无公开 Release 下载入口。

| 项目 | 已核对结果 |
| --- | --- |
| 文件名 | `Easel-preview-76bbaf6-3fb7.zip` |
| 大小 | **1,133,615,933 字节**（约 1.06 GiB） |
| ZIP SHA-256 | `cf06f058767d004ed4d57e602949c30240b4809580fcc597653709de9f63577f` |
| 打包源码提交 | `76bbaf690d224cf2c60496847402426a4619b5c3` |
| 打包源码树 SHA-256 | `3fb71a9428c111bb763b104b36e5b27faadb700b6493691cd7fc9cea6b9c2799` |
| 打包时源码状态 | `sourceDirty=false`；后续文档提交不改变此身份 |
| 归档前及实际解压后完整校验 | 两次 **52,694 项文件 SHA**、**52,695 个分发文件**集合均通过，每次读取 **2,913,335,874 字节**；两份清单摘要一致 |
| ZIP 条目与初始数据 | **52,696 项**，包含唯一空 `data/`；实际解压后确认无运行数据 |
| 实际解压目录 | `C:\project\Easel\.scratch\便携 R27 76bbaf6`；没有复用旧装配副本 |
| 前端和运行组件 | 最终前端回执摘要一致；五个组件与已记录的输入逐字节一致 |

原始回执为忽略的 `.scratch/portable-r27-qa/build-76bbaf6/final-archive.json`，时间戳 `2026-10-08T22:02:09.586561+00:00`；构建进程退出码 0。ZIP 使用系统 bsdtar 的 Deflate6 / Zip64，附同名 `.zip.sha256`。归档后、实际解压与逐文件校验结束后再次计算 ZIP 摘要，结果一致；后续文档提交不改变包内的冻结源码身份。运行、浏览器交互和真实平台功能各自验收。

## R27 实际解压副本运行验收

以下记录均来自上述 `76bbaf6-3fb7` ZIP 的实际中文／空格目录解压副本，未继承 R24 的运行结果。2026-10-09 首次启动和检查完成后，新实例保留运行供页面验收：Web 为 [http://127.0.0.1:50636/](http://127.0.0.1:50636/)，Gateway 端口为 `49588`。这些是构建机本次实例的地址，不是所有安装的固定入口。

| 项目 | 本次 R27 新副本的实际结果 |
| --- | --- |
| 首次空数据与凭据隔离 | 实际解压完成、首启之前两次确认 `data/` 为空；没有提供模型凭据、平台登录态或 SMTP 配置 |
| 命令行隔离首启 | 从 `C:\Windows\System32` 运行包内 Python 和启动器；父环境 PATH 仅含 Windows 系统目录，使用独立空白 HOME。**160.51 秒完成，退出码 0**；返回 `reused=false`，Web／Gateway 均就绪且监听进程属于本副本 |
| 新实例身份 | `bundleId=f837c7a037bf403cac4a57e02a2bf4a1`；Web PID `43216`，Gateway 主进程／监听 PID `10440`／`25008`，创建时间及执行路径已保存。本轮结束时保留运行 |
| HTTP 首页、资源与 API | **12 项 GET 全部 200**：首页和 5 个资源与包内文件逐字节一致；`/api/status`、`/api/settings/models`、`/api/publish/receipts?limit=1`、`/openapi.json`、`/api/publish/receipts`、`/api/schedule` 均检查。状态包含 115 项技能、0 个角色、6 个模型渠道条目；未提供模型凭据 |
| 发布回执新路由 | **3 项 POST 校验通过，与上述 GET 合计 15 项 HTTP 检查**。OpenAPI 确认 `/api/publish/receipts/{receipt_id}/verify` 和 `/api/publish/receipts/{receipt_id}/verification` 已注册；使用无效测试回执 ID `route-smoke-invalid` 的两个请求分别返回 404「发布回执不存在」，缺少必填布尔字段 `automatic` 返回 422。检查后回执和计划仍为空，没有触发平台核实或发布 |
| 包内模块导入 | **12 项导入及来源核对通过，退出码 0**：9 项发布／回执／读回模块来自本副本 `app`；`playwright.sync_api`、`pdfplumber`、`pypdfium2` 来自包内 Python。仅导入模块，没有执行平台 CLI；PDF 解析、页面渲染和 `pip check` 未在本新副本重测 |
| 两种随包 Chromium | 默认 headless shell 与完整 Chromium 的 headless 模式均实际启动，版本均为 **153.0.8010.12**；包内 Python、Playwright 驱动与浏览器执行路径、文件 SHA 均核对。两者仅访问自有本机 HTTP 测试页，完成按钮交互和截图，**11.703 秒完成、退出码 0**；浏览器与测试服务器正常关闭。此结果不代表工作台 UI 或真实平台登录通过 |
| 原有实例保护 | 首启前与上述检查后，原主工作台 `7870`、旧 A 的 Web `65028`／Gateway `37289` 的监听归属和进程身份一致；`7870`、`65028` 两个主页的 HTTP 状态及内容摘要一致。旧 ZIP 仍保留，没有执行旧实例的启停操作 |
| 工作台真实浏览器验收 | 在本次新副本实际完成欢迎页 → 通用模式；设置 → 关闭演示数据 → 刷新保持关闭；模型配置 → 添加供应商表单 → 撤销空行；115 项技能入口 → 选择标签 → 本次补充要求编辑入口 → 取消；空回执 → 发布中心 → 全部回执 → 通知设置。没有填写凭据、调用模型、发帖或发信；技能选择与自动填入草稿已清理。最终 1280×720，页面宽度与滚动宽度均为 1280；本包没有重跑全部页面或窄屏矩阵 |
| 本包尚未验收的范围 | 原生 `Easel.exe` 双击、按钮及关闭窗口；干净 Windows 10/11；本包重复启动、停止、重启和搬迁；真实模型调用、平台登录／发布／审核结果读回及外部作品链接、SMTP 发送与送达。代码签名和公开 Release 仍未完成 |

本轮运行汇总为忽略的 `.scratch/portable-r27-qa/build-76bbaf6/acceptance-r27.json`，校验本次构建及运行的 10 份 JSON 后生成。原始运行证据位于同目录 `runtime/`，包括 `initial-data-check.json`、`start-command.json`、`new-instance-started.json`、`http-acceptance.json`、`imports.json`、`chromium-candidate-report.json` 和 `protected-unaffected-proof.json`。工作台浏览器另有 `runtime/browser/acceptance.json`、各入口截图与 `final-workbench.jpg`；使用内置浏览器实际操作新副本，和独立 Chromium 测试页分别记录。所有原始证据均为本地验收材料，不随源码提交。

## R24 历史候选文件（20a709c）

以下为 2026-10-09 02:36:18（北京时间）完成的归档与实际解压校验结果。文件保存在构建机的 `dist/portable-preview/`，目前尚无公开 Release 下载入口。

| 项目 | 已核对结果 |
| --- | --- |
| 文件名 | `Easel-preview-20a709c-0b56.zip` |
| 大小 | **1,133,545,960 字节**（约 1.06 GiB） |
| ZIP SHA-256 | `e48d056ca9a03fbaa26da903c4d0e039df329380d37b4e5e09137cc5666e2115` |
| 打包源码提交 | `20a709cad091002af0c2ec65d40fae9ebd052132` |
| 打包源码树 SHA-256 | `0b565921f20d4811628277448a60cac83dc69c94fe31aae810028a777c1df040` |
| 打包时源码状态 | `sourceDirty=false`；该身份固定记录于候选清单，后续文档提交单独追踪 |
| 冻结分发清单 | **52,690 项完整文件 SHA 记录**；**52,691 个分发文件**（包括 `checksums.sha256`） |
| 实际 ZIP 条目 | **52,692 项**，包括唯一的空 `data/` 目录；实际解压后确认 `data` 为空 |
| 归档验收完成时间 | 北京时间 **2026-10-09 02:36:18**；回执为 `2026-10-08T18:36:18.895705+00:00` |
| 实际解压验收目录 | `C:\project\Easel\.scratch\便携 验收`；后续停止并整体搬迁至 `C:\project\Easel\.scratch\便携 最终已搬迁20a709c` |

归档前与实际解压后分别对清单内 **52,690 个文件**读取全部字节并计算 SHA-256，再核对完整文件集合；另行核对 `checksums.sha256` 本身的摘要。两次完整校验均通过，`portable-manifest.json` 和校验清单摘要一致，实际解压后的 `data` 为空；ZIP 在解压及校验后再次计算 SHA-256，结果一致。ZIP 由 Windows 系统 bsdtar 生成，采用标准 Deflate、压缩级别 6 和 Zip64，并附同名 `.zip.sha256` 文件。

原始回执保存在忽略的 `.scratch/portable-r24-inputs/metadata/final-archive-20a709c-0b56.json`。上述结果确认该本地文件与实际解压内容的一致性；运行、真实浏览器和平台功能分别验收。

## 首包历史与本次修复

首个候选于 2026-10-09 01:17（北京时间）取得归档与实际解压回执；下列信息仅用于保留历史，不是当前交付文件：

| 历史项目 | 首个候选记录 |
| --- | --- |
| 文件名 | `Easel-preview-fefe9fe-ad69.zip` |
| 大小与 SHA-256 | 1,118,359,957 字节；`60586a1ba97aae304952fe5949b04f406dc4f416cafe40607ce6ef12571c6c0d` |
| 打包源码提交 | `fefe9fe8c712ff878cc9b3ae06c74e3f1dd0ad33` |
| 打包源码树 SHA-256 | `ad6925268e54c03113e5a2a77492e8e11232bc092c6138b16596600a9d6ec576` |
| 文件校验范围 | 52,397 项完整文件 SHA、52,398 个分发文件；ZIP 共 52,399 项，含唯一空 `data/` |
| 原始回执 | 忽略的 `.scratch/portable-r24-inputs/metadata/final-archive.json`，保留原记录 |

首包的完整文件校验、实际解压、隔离 PATH 基础启动、重复启动、停止和中文目录搬迁取得了通过记录，但后续环境自检发现论文 PDF 解析缺少 `pdfplumber`；此前的 31 项核心／媒体模块导入没有覆盖这一依赖。另一次双副本冷启动触及原有 60 秒配置校验上限，并按既有流程安全清理验证进程，因此不能以首包已通过的项目代替当前候选验收。

本次为准备好的 Python 输入新增 `pdfplumber==0.11.10`、`pdfminer-six==20260107`、`pypdfium2==5.14.0`，总计 **122 个非 editable 发行包**；原 119 个包的版本和文件字节保持不变。输入组件已通过 4/4 常用库导入、真实 PDF 文本提取与页面渲染、`pip check` 和构建器 Python 路径检查，新增许可文件同步保留。配置验证等待上限由 **60 秒调整为 120 秒**，仍保留超时清理，追加的 **39 项启动器回归通过**。这些是代码和输入组件的证据；新 ZIP 解压后的 Python 另行通过 4/4 导入、一页 PDF 文本提取和 612×792 原生渲染，未在最终解压副本上重跑 `pip check`。实际启动、双副本和一次 Gateway 超时的独立记录见下表。

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

`runtime` 和 `data` 相对于解压目录定位。运行时使用包内程序，服务端配置、日志、模型缓存和产出写入本副本的 `data`，避免依赖构建者的 Python venv 或工具安装位置。首次为每个副本分配独立本地 Web 端口，后续启动和目录搬迁优先保持该地址；端口被其他服务占用时才改用新端口并提示。浏览器保存的会话与草稿与地址绑定，不随 `data` 自动移到其他电脑或端口。会话历史可使用会话备份导出、导入；当前备份不包含未发送草稿、技能选择或补充要求，换电脑或端口前应手工保留这些内容。R28 已据实际备份字段更正此前对草稿迁移范围的描述。

候选归档只包含空的 `data/`；R27 与 R24 历史 `20a709c` 包各自的实际解压回执均已确认。后续本地运行产生的数据不属于分发包。构建输入不包含使用者的 `.env`、Cookie、浏览器 profile、模型凭据或个人产出。源码仍沿用本项目及上游的许可证，第三方组件各自的许可文件随包保留。

## 固定组件范围

以下版本记录于 R24 与 R27 的 `portable-manifest.json`；R27 装配时复核五组件与已验证的 R24 输入逐字节一致。两个候选的归档和实际解压结果各自记录，不相互替代。

| 组件 | 固定版本或修订 | 说明与公开来源 |
| --- | --- | --- |
| CPython | 3.12.10 embedded amd64 | [官方嵌入版 ZIP](https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip)；保留 `LICENSE.txt`，Python 依赖使用便携包实际包集的独立精确锁 |
| Node.js | 24.19.0 win-x64 | [官方发行目录](https://nodejs.org/dist/v24.19.0/)；保留 Node 及随附组件许可 |
| OpenClaw | 2026.9.2 | [公开 npm 包](https://www.npmjs.com/package/openclaw/v/2026.9.2)；采用与已审阅严格模型选择契约对应的版本，但这不证明用户模型凭据或真实推理有效 |
| FFmpeg | 9.0.1-full_build | [FFmpeg 项目](https://ffmpeg.org/)；Windows 二进制来自 [gyan.dev 构建](https://www.gyan.dev/ffmpeg/builds/)，组件清单记录版本、许可文件与相应源码来源 |
| Playwright 浏览器组件 | Chromium 153.0.8010.12 / r1243 | 取自本机公开程序缓存，包含匹配的 Chromium、headless shell、FFmpeg r1011 与 winldd r1007；与 Python 包内 Playwright 的 `browsers.json` 对照，不含浏览器用户 profile 或 `.links` |

`requirements/windows-portable-py312.lock` 对应**实际装入便携 Python 的包集**，与既有 `requirements/windows-py312.lock` 分开维护。它记录精确版本；原始下载摘要、逐文件校验与来源元数据分别保留，不用版本锁代替二进制校验。

组件来源和随附许可说明汇总在 `THIRD_PARTY_LICENSES.txt`，前端依赖说明位于 `app/THIRD_PARTY_FRONTEND_LICENSES.txt`，原许可文件仍在相应组件目录。Python 原始 ZIP 已与官方 Sigstore bundle 记录的摘要比对，**未执行签名和签名者身份验证**。浏览器程序来自本机已有的公开程序缓存，未在本轮重新从上游下载；**Chromium 再分发所需的完整许可审核尚未完成**。保留许可文件、版本和哈希记录不代表这些审核已经通过；对外再分发前仍需完成相应核验。

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

## R24 历史候选验收记录（20a709c）

下表区分代码与输入组件、ZIP、HTTP、真实浏览器及真实模型／平台证据。所有文件和运行记录均对应历史候选 `20a709c` / `0b56`，不含 R27 审核后核实代码；首包、此前 R16–R23 的源码和安装检查也不替代此候选验收。

运行验收中，**A 是新 ZIP 的实际解压副本**，后移至 `.scratch/便携 最终已搬迁20a709c`；**B 是刷新到同组输入与源码的 `.scratch/r24-portable-stage` 装配目录**，不是第二次 ZIP 解压。A 当前留在运行状态供本机验收，Web 为 [http://127.0.0.1:65028/](http://127.0.0.1:65028/)、Gateway 端口为 `37289`；B 的 Web／Gateway 端口为 `50656`／`51541`，已停止。这些端口属于本次验收副本，不是所有安装的固定入口。

| 项目 | R24 候选当时的状态 |
| --- | --- |
| 新 ZIP 文件名、大小、SHA-256 | 已生成、实际解压并重算 ZIP 摘要，和同名 `.zip.sha256` 一致；准确字节数及完整身份见上表。本地候选未公开发布 |
| 代码与运行组件定向检查 | 初版便携／发行、生命周期及明确 OpenClaw 路径合计 142 passed / 1 skipped；跳过项为主机不支持创建符号链接。冷启动校验时限调整后另跑启动器 39 项通过，不与历史计数相加。C# 编译、参数及未显示窗口的状态逻辑已测，未冒充真实双击点击验收 |
| 前端重新构建 | R25 合入后重新运行 697/697、lint、TypeScript 与生产构建；现有 Three.js 大块提示保留，构建回执核对源码及产物摘要 |
| 五组件及 Python 输入包集 | 固定组件范围见上表；Python 输入为 122 包，保留原 119 包，新增 3 个 PDF 依赖。输入 4/4 库导入、PDF 提取／渲染、`pip check` 及构建器路径校验已通过；不代替解压后包内测试 |
| 解压后包内依赖与 PDF 测试 | A 使用包内 Python 完成 4/4 常用库导入，真实 PDF 提取出文本，并以原生库读取 1 页、渲染为 612×792；未联网、未调用模型、未改动分发文件。最终副本未重跑 `pip check`，仅输入运行时有该项通过记录；全量 SHA 确认装入的文件一致 |
| 来源与许可核验边界 | 浏览器取自本机公开程序缓存；Python 原始 ZIP 仅完成摘要比对，未验证签名身份；Chromium 完整再分发许可审核尚未完成 |
| 归档前后完整 SHA、实际解压与空数据 | 归档前及实际解压后 52,690 项完整 SHA、52,691 个分发文件集合均通过，两次清单摘要一致；ZIP 共 52,692 项，含唯一空 `data/` |
| 首次启动、重复启动及停止 | A 从 `C:\Windows\System32`、仅保留 Windows 系统目录的隔离 PATH 启动，167.81 秒、退出码 0；重复启动复用同一组进程。停止后原受管 PID 退出；使用包内 Python／Node，未依赖主机开发工具的 PATH |
| 本次冷启动失败与重试 | B 首次启动时，正在并行进行大文件解压／校验，触及 Gateway 的 120 秒等待上限；命令总耗时 260.26 秒、退出码 1，报告 Gateway 启动失败或超时。大文件检查结束后另行重试，185.80 秒、退出码 0。保留两份回执，未据此认定 I/O 竞争是根因；此项与首包的 60 秒配置校验超时不同 |
| 首页、静态资源与 API 的 HTTP 检查 | 搬迁后 A 的首页、5 项静态资源和 4 项 API 共 10 项均返回 200，资源摘要已记录；逐项范围见下表。HTTP 结果不代替浏览器交互或真实模型／平台验证 |
| 中文／空格目录搬迁、不同当前目录 | 停止 A 后整体移动到 `.scratch/便携 最终已搬迁20a709c`，从 System32 再启动成功；副本身份、配置文件字节及摘要、Web 地址保留，受管路径已更新。真实浏览器刷新后，草稿、技能选择和禁用演示数据偏好保留；验收草稿及技能选择随后清理 |
| 双副本端口及停止隔离 | A 与 B 同时运行时，副本身份、根目录、Web／Gateway 端口独立，进程集合不重叠；停止 A 后 B 原进程不变，停止 B 后 A 原进程不变，两份被停止副本的原 PID 均退出。A 为实际解压副本，B 为刷新后的装配目录 |
| 真实浏览器首页、引导、技能及模型设置入口 | 在 A 实际完成欢迎页 → 通用模式；打开 115 项技能列表并选择技能、显示已选标签；进入模型设置 → 添加供应商表单 → 删除未保存行；空回执中心 → 发布中心 → 首页。搬迁后刷新并验证持久化，最终工作台截图已留存；未填写真实凭据、未执行真实推理或发布 |
| 环境自检 | 最终 `/api/env/tools` 显示 7/11；通过项为 Node、FFmpeg、Python、faster-whisper、Biliup、Playwright 包及常用库。其余项的实际含义见下文，不能合并报告为必需依赖全部缺失或浏览器登录已验证 |
| 图形入口双击、按钮及关闭窗口 | 尚未实际完成 GUI 操作验收；C# 编译和无窗口状态逻辑检查不能替代 |
| 模型、平台与通知 | 使用者需提供凭据，尚未完成该候选的真实模型推理、平台登录／发布或 SMTP 投递验收；模拟响应和入口可达不计为通过 |
| 全新 Windows 10/11 虚拟机 | 尚未完成完整验收 |
| 代码签名、公开 Release | 尚未完成；旧 0.2.6 安装包保持原样 |
| 本轮 Git 交付 | **已推送并核对远端 SHA**：功能交付 `4f899259b5c277406d9091cebf5ffa2cf25ecb57`，main 首页文档 `6fde86783132874ca1aa95b33ab4052786667fa3`；实际回执见 [持续交付清单](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/user-requirements-2026-10-08.md)。`main` 只同步中英文 README，功能代码留在 `codex/creator-workflow`；候选打包源码提交与后续文档提交分开记录 |

搬迁后实际发出的 HTTP 请求均以 A 的 `http://127.0.0.1:65028` 为基址：

| 路径 | 实际 HTTP 结果 |
| --- | --- |
| `/` | 200 |
| `/assets/index-BzHwUDya.js` | 200，记录资源 SHA-256 |
| `/assets/index-HA8wsSQ8.css` | 200，记录资源 SHA-256 |
| `/assets/jsx-runtime-Qy3n81sD.js` | 200，记录资源 SHA-256 |
| `/assets/localPersistence-Iro4yp47.js` | 200，记录资源 SHA-256 |
| `/static/easel-icon-transparent.png` | 200，记录资源 SHA-256 |
| `/api/status` | 200 |
| `/api/settings/models` | 200 |
| `/api/skills` | 200，返回 115 项技能 |
| `/api/env/tools` | 200，环境自检 7/11 |

**环境自检 7/11 的边界：** `model=missing` 指未打包的可选 Whisper large-v3 权重；`rmdeps=no_dir`、`shell=no_dir` 表示尚未选择 Remotion 项目目录，不能据此认定其依赖缺失。`cft=missing` 是现有检测器只检查主机 Chrome、默认 Playwright 缓存和 PATH，未识别便携启动器设置的 `PLAYWRIGHT_BROWSERS_PATH`。当前小红书、抖音、快手、视频号、知乎及微信公众号二维码登录路径使用 Playwright 默认 Chromium，Bilibili 二维码走 API；静态代码检查没有发现这些路径硬性要求 Chrome for Testing。`pw=ok` 仅证明 Playwright 包可以导入，**不证明随包浏览器已启动或真实平台登录通过**，本次仍未执行真实平台登录验收。

本地运行及 HTTP 回执位于忽略的 `.scratch/portable-r24-qa/final-20a709c-*`；最终浏览器截图为 `final-20a709c-workbench.png`。验收临时数据和截图不随源码提交。

整体状态以 [持续交付清单](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/user-requirements-2026-10-08.md) 和 [交付进度](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/secondary-development-progress.md) 为准。