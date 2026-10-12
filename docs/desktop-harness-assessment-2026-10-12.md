# Easel 桌面应用、性能与 Agent 执行能力评估

日期：2026-10-12。对应需求 R82–R83。本文是独立评估与待实施路线图，不修改既有 Codex 接入计划。

用户已明确：新便携包、安装器及重打包等待后续指令。本轮只检查源码、历史 ZIP 清单和官方资料，不安装竞品、不迁移框架、不生成发行包。

后续 R84 已补充 [Codex 执行体验对标报告](codex-execution-experience-assessment-2026-10-12.md)，细化思考/工作进度、终端、文件差异、操作事件与恢复的展示规划；该报告未开始 UI 实现，也不改变本文的桌面选型和暂停打包边界。

## 建议

桌面应用值得做；现在不建议把“换 Electron”作为包体和速度的主要解决方案。

当前优先级是：把可靠执行和产物交付做成系统机制，拆分重型运行组件，缩短界面被后台初始化阻塞的时间，再验证桌面窗口。Windows 优先验证现有 C# 入口配合 WebView2 的可行性；需要正式跨平台产品时再评估 Tauri。只有内置多标签浏览器、统一 Chromium 行为和复杂桌面集成成为明确核心需求时，才优先采用 Electron。

ZCode 和 DeepSeek Harness 的官方桌面实现都使用 Electron。这说明 Electron 适合它们的桌面组织方式，不证明它能替 Easel 消除 Python、媒体库、独立网关和自动化浏览器的成本。

## 已核实的依据与边界

- 检查源码 `scripts/portable_entry.cs`、`scripts/portable_launcher.py`、`scripts/build_windows_portable.py`、`pyproject.toml` 和 Web/会话实现。
- 只读统计本地历史 `Easel-preview-2f1818d-c38a.zip` 的 ZIP 中央目录，未重新打包或启动该副本。固定源码 `2f1818d4d11d0ea09968fb1e83af76a90a30a1c1`，ZIP 1,169,390,503 字节；这些数字不代表当前所有未压缩候选。
- 当前源码 OpenClaw 2026.9.6 的随附文档列出浏览器操作、下载回执、独立 profile 和指定 Chromium/Edge 路径。当前用户配置没有显式 browser 设置；这不能推断关闭，也不能当作本机浏览器已可用。本轮未让 OpenClaw 控制真实用户网页。
- 查阅 Z.ai 官方 ZCode 仓库/文档和 DeepSeek 官方 Harness 仓库/架构。仅核实公开实现与声明，未安装运行竞品，也没有同模型、同任务的速度或成功率对比。
- ZCode 仓库 README 为 v3.15.1，官网所列下载为 v3.14.5；资料可能存在版本差异。DeepSeek Harness 明确处于 developer preview，插件机制丰富不等于生产稳定性已经验证。

## 包体主要在哪里

以下按未压缩文件汇总，MiB = 1,048,576 字节，四舍五入；ZIP 内各组件压缩贡献不含中央目录等总包开销。

| 组件 | 未压缩 MiB | ZIP 压缩贡献 MiB | 文件数 |
| --- | ---: | ---: | ---: |
| Python 与依赖 | 1,100 | 412 | 16,067 |
| 自动化浏览器 | 706 | 312 | 609 |
| OpenClaw 与 Node 依赖 | 528 | 150 | 38,802 |
| FFmpeg/FFprobe | 424 | 165 | 4 |
| 独立 Node | 89 | 33 | 3 |
| Easel 源码、前端和素材 | 41 | 27 | 1,450 |

所有文件合计约 2.83 GiB，ZIP 约 1.09 GiB。应用自身只占很小部分，换前端框架不能解决主要体积。

具体可验证的优化候选：

1. 浏览器同时包含完整 Chromium（432 MiB）与 headless shell（270 MiB，ZIP 贡献约 115 MiB）。可以评估只保留一个：完整 Chromium 支持有界面与无头模式，但所有 Python Playwright/OpenClaw 调用必须显式指向同一受支持程序，不能直接删 headless shell。
2. ZIP 中有独立 Node 89 MiB，同时 Python Playwright driver 自带另一份 Node 89 MiB。Playwright 提供 `PLAYWRIGHT_NODEJS_PATH`，因此存在复用候选；需要验证 Node 版本、驱动兼容、所有子进程环境和搬移，验证前不删除。
3. Python 较大的包包括 llvmlite 115 MiB、cv2 111 MiB、Playwright 105 MiB、scipy 83 MiB、av.libs 64 MiB、ctranslate2 59 MiB。多数属于转写、音视频、分析等能力，适合按功能包拆分。共享依赖和原生动态库必须按真实导入闭包处理，不能把以上大小相加当作可全部删除的空间。
4. FFmpeg 使用 full build；评估实际用到的编码器/滤镜后才能选择较小构建，保留字幕、合成、音频和现有产出格式。
5. OpenClaw 近 3.9 万个文件增加解压、文件扫描和模块加载成本。区分可选 provider、平台原生模块、文档与运行依赖；动态 import、原生 ABI、许可证及 pinned 版本都要验证，不能按文件名随意裁剪。

拆分建议为“核心桌面/对话 + 浏览器操作 + 音视频/转写 + 高级分析”能力包。基础安装先提供核心能力，需要时在应用里启用对应包；安装失败可重试、显示下载大小与来源、未安装时明确不可执行。完整离线版本仍可保留，但它天然比联网按需版本更大。

不承诺固定缩减比例或最终 MB，先在同功能验收集下测量；当前打包暂停，也没有产出所谓轻量版。

## 速度需要分别治理

“更快”至少包括界面出现、后台就绪、模型首字、整项任务四类，不能用其中一项代替其它项。

当前源码启动器先启动一次完整 OpenClaw `config validate`，再启动并等待 Gateway，之后才启动 Web。前两步存在重复加载 Node 模块的候选，且界面被网关等待阻塞。历史便携记录的冷启动约 168–186 秒；默认分支记录另一修复副本复用运行中服务约 4.4 秒。这些来自不同历史状态，不能合并为当前版本的性能基准，也不能直接认定杀毒软件或磁盘是唯一根因。

建议先记录每阶段时间：配置检查、workspace 同步、网关首次就绪、Web 首屏、浏览器首次启动、模型连接/首字、工具执行。再实现：

- 本地窗口/已构建界面先展示，后台异步启动网关；明确“界面可用”“引擎就绪”，离线时可查看历史与内容，不提前把未就绪引擎标为可对话。
- 对未变化配置评估复用验证结果或通过常驻网关验证，缓存绑定版本和配置摘要；配置变化立即失效，不能跳过所有校验。
- 保留进程复用与按需浏览器/媒体启动，避免每次打开窗口重新跑整条 CLI 冷启动。
- 运行依赖打平/构建优化须与 OpenClaw 的受支持发行方式兼容，按真实 tracing 决定，不凭推测改原生模块。
- 模型延迟、上游 502、额度和限流另算。Electron 不会修好 aihub 源站 502；“自适应最高”可能增加推理时间，手动档位继续在对话框选择。

候选验收目标：参考 Windows 机器上界面可交互 p95 ≤ 3 秒、已有引擎复用到聊天可用 p95 ≤ 5 秒；冷启动先降低基准 p95 50%，再根据瓶颈定绝对值。这是规划目标，不是本次实测结果。

## 桌面窗口选型

| 方案 | 收益 | 成本与限制 | 当前判断 |
| --- | --- | --- | --- |
| 现有浏览器工作台/PWA | 复用 React 与本机浏览器，壳体开销低 | 标签页/服务生命周期分离，浏览器存储与 origin 绑定，原生菜单/文件集成有限 | 保留源码/Web 入口，不能独自满足完整桌面体验 |
| 现有 C# 入口 + WebView2 | 原生窗口、托盘、文件打开和生命周期；可复用 Windows WebView2 | 需独立管理后端、持久数据和消息桥；不是 OpenClaw 的 Chromium CDP 浏览器 | Windows 桌面原型首选候选，暂无原型 |
| Tauri + 系统 WebView | 复用前端，较小壳体，跨平台路线 | 增加 Rust 构建；Python/Node 仍为 sidecar；不同系统 WebView 行为要测试 | 明确跨平台后评估，不能宣称整包只有几 MB |
| Electron | Chromium 一致，多窗口/内置浏览器、Node 和 IPC 生态成熟 | 增加 Chromium 与内存；现有 Python、OpenClaw 和媒体依赖仍要治理 | 复杂内置浏览器优先时采用，当前不是减重首选 |

本机检测到 WebView2 运行时，不能据此保证其它电脑已有。Tauri 官方文档列出 WebView2 下载/离线/fixed-version 策略；离线安装器和固定 runtime 仍有额外体积。完全离线与借用系统 runtime 是不同交付条件。

Electron 的 Node 与当前独立 Node 24 不可直接互换：Easel 检查 Node/SQLite 支持，OpenClaw 及原生依赖也有运行约束。把 OpenClaw 放进 Electron Node mode 需要正式兼容验证；桌面 renderer 不加载业务密钥或后端执行环境。

## OpenClaw 能操作浏览器，Easel 缺的是产品接线

当前随附 OpenClaw 官方文档提供：打开/关闭标签、导航、读文本和快照、点击/输入/拖动、截图/PDF，以及支持场景下的下载 metadata。它支持独立托管 Chrome/Edge/Chromium profile，也有显式接入既有会话或远端 CDP 的方案。浏览器设置、插件、运行程序与权限需要实际就绪，不能看到 README 就声称本机能执行。

因此，引入 Electron 不是获得浏览器操作的前置条件；反过来 Electron 或 WebView2 窗口也不会自动让 OpenClaw 接管其中网页。

Easel 应提供统一“浏览器任务”能力：展示真实网址/标签、Agent 的操作和截图，允许用户接管/停止；每个任务拥有标签和 profile；下载回执自动转入当前产物库，验证后挂到任务。正文里显示“访问了网站”还不够。不能用普通 iframe 直接承载任意网站并假设可控，网站的嵌入限制与跨源限制仍在。

如果选 Electron，需要单独设计 OpenClaw ↔ 受控 Chromium/桌面面板连接与标签所有权。如果选 WebView2，可让应用界面使用系统 WebView，浏览器工具仍使用独立托管 Chromium/Edge；先验证截图/事件流或独立窗口展示，不混用登录 profile。无需更改既有 Codex 接入规划。

## 相比 ZCode / DeepSeek Harness 的不足

ZCode 官方定位为编程工作台：Goal、多 Agent、任务与文件、终端/Git/Review、内置浏览器、Plugin/Skill/MCP/Hooks 和执行模式。DeepSeek Harness 侧重可组合执行框架：model/tool/agent/session 作为可替换插件，持久 session events、工具执行流水线、sandbox/approval policy、多运行 profile、SDK 与可重复测试入口。

Easel 已有创作技能、渠道管理、内容库、账号/发布流程、事件回放/续流、停止、用量与办公室；差距不是“完全没有 Agent”。优先补齐的地方如下：

| 维度 | 官方竞品可核实参考 | Easel 现状及不足 | 规划 |
| --- | --- | --- | --- |
| 任务完成判定 | ZCode Goal 基于工具/文件/测试证据验收并有额度上限 | 有长对话、排队和运行记录；未见等价的统一 Goal/验收/预算状态机 | 可暂停的目标任务，显式验收项、预算与实际回执，停机不擅自续跑 |
| 产物交付 | ZCode 文件/Review；DSH 持久事件和工具结果 | 已修复本地路径与保存脚本，但格式核验仍主要靠指令，不存在文件不可能靠渲染补出来 | artifactId、任务归属、格式/大小/hash、来源与状态登记；工具成功后才能生成交付卡片 |
| 浏览器可观察与接管 | ZCode 内置操作面板；OpenClaw 有浏览器工具 | 自有平台脚本和工具活动已有，统一浏览器任务面板/下载关联缺少闭环 | 受控 profile、标签所属、步骤/截图、下载自动入库、接管和停止 |
| 可组合工具/配置 | ZCode 插件聚合 Skills/MCP/Hooks；DSH 核心接口可替换 | 技能是说明与脚本，配置判定/运行环境分散，曾出现“已配 Key 仍说缺” | 能力注册与结构化配置校验，统一工具输入/输出/诊断，提供 scoped 配置引用 |
| 权限与环境边界 | ZCode 可见执行模式；DSH guarded tool pipeline 和 sandbox | 已有发布前检查、路径校验/会话锁；这些不等于统一 shell/fs/network 许可层 | 每任务权限、目录/工具边界；读取和可逆操作低打扰，发布/删除/付费等精确确认与审计 |
| 会话/恢复 | DSH 日志构建上下文与恢复，ZCode 目标状态保存 | 已有 JSONL 事件、SSE eventId 续流和后台任务；浏览器历史/草稿仍主要 localStorage，生图运行表含内存状态 | 产品持久存储、引擎结果对账、检查点；区分网络重连和进程重启，不重复已发生的发布/付费步骤 |
| 引擎/模型能力 | DSH adapter seam；ZCode GLM 深度适配 | 多渠道能力与真实响应边界仍可能错位；UI/引擎事件需要统一 | 单独外层适配输出 task/run/tool/artifact/error 事件，实际档位/工具能力与请求值区分，不改既有 Codex 接入方案 |
| 效果评估 | DSH 专门 benchmark/SDK 与分工作区任务入口 | UI/后端回归较多，缺少持续记录的端到端 Agent 任务成功率 | 固定创作/下载/恢复任务集，同模型同成本比较；区分模拟、真实后端和真实模型 |
| 桌面/发行 | 两家有正式桌面架构与运行资源管理 | 当前本地入口主要开浏览器，体积大，启动等待多；跨机器和 GUI 验收仍有缺项 | 桌面生命周期、稳定数据路径、能力包升级/回滚/诊断；安装包依旧等待授权 |

不要优先追齐完整 IDE、LSP、远程 SSH、所有插件市场或多 Agent 外观。Easel 的优势应放在“对话到可打开的创作产物，再到可核实的发布/分析工作流”。3D 办公室是可选观察界面，当前已经按页 lazy load；继续保证不阻塞聊天，不能把重复增加动画当作执行可靠性改进。

可见推理仅展示 provider 实际返回的摘要/内容，工具与浏览器日志单独呈现，不虚构内部思考。任务面板最关键的内容是已执行的动作、真实结果、待处理事项和完成证据。

## 分阶段规划与验收

| 顺序 | 工作 | 为什么先做 | 验收/退出条件 |
| --- | --- | --- | --- |
| P0-A | 统一能力、配置与产物登记 | 当前 Key 误判、虚构/丢失文件直接影响信任 | 结构化配置检查不泄密；缺失文件/格式错/下载失败均无成功卡片；真实产物预览、下载、搬移后打开 |
| P0-B | 恢复与错误处理 | 上游 502 和断线不能变为丢会话/重复操作 | 上游阶段/错误保留，重连不重发；重启标明中断并对账；重试只针对明确可重试且未完成的步骤 |
| P1-A | 包体/启动基准与能力包设计 | 知道瓶颈才能减重 | 至少10次冷/热样本分阶段记录；组件依赖闭包与回归矩阵完成；缺少可选组件时说明准确。用户未授权前不组装新发行包 |
| P1-B | 统一浏览器任务与下载闭环 | 底层已有能力，用户目前看不到完整动作/产物 | 本地 fixture 覆盖读页→点击→下载→入库→打开，显示真实标签/截图，可暂停/接管；普通网页不能冒充工具指令 |
| P2-A | Windows 桌面原型与同机对比 | 桌面壳需要数据与生命周期先稳定 | 用户同意后验证 WebView2/C# 最小窗口，退出/托盘策略、后端重用、文件打开、升级保留会话；再对比 Electron/Tauri，不凭下载大小替代完整运行成本 |
| P2-B | 目标任务与预算 | 从反复“继续”变为可检查的持续执行 | 目标、验收清单、暂停/恢复、成本上限、产物证据持久；无证据不得自动标完成 |
| P3 | 插件扩展与持续效果评估 | 扩展应建立在可复用契约上 | 插件版本/依赖/配置/权限清楚；可停用/回滚；固定任务集记录成功率、首字/总时长和成本 |

交叉工作：至少建立 20 个固定任务场景，优先覆盖网页下载、Word/图片交付、Key 已配置/缺项、502、断线/重启、窄屏、路径搬移、重复发送和发布确认。前半可用受控 fixture 验证工具链；模型能否正确选工具和完成目标需另行真实模型实验，必须单独标费用和结果。以上为规划，未报告这些新增目标已经通过。

本轮已完成的是 R79–R81 的定向修复/真实浏览器与受控下载验收，以及本文评估；桌面迁移、减重、Goal/新插件架构与新版包均未实施。

## 来源

- [ZCode 官方仓库](https://github.com/zai-org/ZCode)，README 的 Desktop/CLI/仓库结构。
- [ZCode 目标模式](https://zcode.z.ai/cn/docs/goal)、[浏览器自动化](https://zcode.z.ai/cn/docs/browser-use)、[插件](https://zcode.z.ai/cn/docs/plugin)、[安全操作确认](https://zcode.z.ai/cn/docs/safety-confirm)。浏览器文档明确桌面端面板、当时不能上传文件及 Windows 登录态导入限制，未把这些能力当作已全面支持。
- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)、[架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)、[benchmark 入口](https://github.com/deepseek-ai/deepseek-harness/blob/master/BENCHMARK.md)。
- [Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)、[性能建议](https://www.electronjs.org/docs/latest/tutorial/performance)。
- [Tauri Windows / WebView2 发行策略](https://v2.tauri.app/distribute/windows-installer/)。
- [OpenClaw 浏览器文档](https://docs.openclaw.ai/tools/browser)。本次具体能力以项目 pinned 2026.9.6 的 `docs/tools/browser.md`、`browser/agent-tools.md`、`browser/configuration.md` 为依据，未把线上更新后文档当作本机实测。
- Easel 的源码定位：`scripts/portable_launcher.py`、`scripts/portable_entry.cs`、`scripts/build_windows_portable.py`、`pyproject.toml`、`web/app.py`；历史验收：`docs/windows-portable.md`。

只读体积 JSON、公开资料响应摘录和浏览器证据保存在本地 Codex outputs，不提交用户配置、密钥或实际作品。
