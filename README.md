> **最新便携交付（2026-10-10）**：`Easel-preview-2f1818d-c38a.zip` 已生成于 `dist/portable-20261010/`，来源 `2f1818d4`。全量前端916通过，包体完整校验、空data首启、真实浏览器入口及隔离启停/重启通过。全新Windows与原生GUI双击仍待验；[运营手册](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/operator-handoff-2026-10-09.md)记录SHA256与边界。旧76bbaf6候选仅为历史记录。

> **最新收口**：当前模型厂商icon、超过3轮显示节点、紧凑工具执行、自动匹配可用思考档位/黄色info已完成；修正登录有效性缓存、B站失效回正、公众号会话区分，并在发布前逐平台在线检查。定向前端98项、后端250通过1跳过；真实小红书只读检查有效，无重复投稿。按最新授权开始生成dist新便携包，包的全量前端/启停回执单独记录。

> **2026-10-10 最新验收**：真实提问卡片→回答→续跑→刷新通过；引用说明已实测鼠标悬停、移出隐藏与展开面板互斥。用户在小红书 App 确认唯一一次授权图文已公开且内容正确，网页自动读回仍待核实，不重复投稿。上游 main 78 路径已逐项审计并补齐画像创建校验、凭据镜像回归、workspace 硬链接保护和字体非阻塞加载；相关后端385通过/1跳过、兼容前端19通过，非最终全仓全量。办公室/技能/多平台390px证据另记。最新程序包与干净Windows验证单独跟踪。
>
> [运营手册](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/operator-handoff-2026-10-09.md) · [功能验收单](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/functional-acceptance-2026-10-09.md) · [上游兼容报告](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/upstream-compatibility-2026-10-10.md)

# Easel 创作工作台

面向本地使用的专业创作工具。将对话、素材、内容项目与小动物 Agent 办公室放在一个工作空间，能看见任务、操作记录和工作区产出。

[English](README_EN.md) · [当前源码](https://github.com/StarrySea1412/Easel/tree/codex/upstream-compat-2026-10-10) · [本仓库反馈](https://github.com/StarrySea1412/Easel/issues) · [更新记录](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/CHANGELOG.md)

> 本项目由 [StarrySea1412/Easel](https://github.com/StarrySea1412/Easel) 仓库维护，基于 [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel) 二次开发。本文更新于 **2026-10-10**，介绍 `codex/upstream-compat-2026-10-10` 的当前源码；`main` 首页同步展示项目说明，功能代码仍在开发分支。已有 0.2.6 EXE / ZIP 来自 `38e728c`，不包含后续工作台与办公室改动，尚未发布包含这些功能的新安装器。
>
> Windows x64 历史便携候选为 `Easel-preview-76bbaf6-3fb7.zip`（约 1.06 GiB），已完成实际解压、完整文件校验、包内启动、两种 Chromium 运行和指定工作台入口的浏览器验收。尚未公开发布；图形双击和全新 Windows 环境仍待验收。使用步骤、SHA-256 和逐项边界见 [便携预览说明](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/windows-portable.md)。
>
> 此候选固定源码 [76bbaf69](https://github.com/StarrySea1412/Easel/commit/76bbaf690d224cf2c60496847402426a4619b5c3)，包含五平台审核后核实、暂停/恢复和发布完成提醒。后续文档提交独立追踪，不改变 ZIP 的源码身份；旧 `20a709c` 包保留为历史版本。

准备验收时，按 [功能验收清单](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/functional-acceptance-2026-10-09.md) 检查界面、技能、办公室、发布提醒和便携运行；基础操作与需要自己配置账号/模型的真实业务分别列出。

**10 月 9 日源码迭代**：账号分析新增七平台诊断能力、数据质量与指标口径、同条件比较组、真实标签/评论题材及七天实验；平台切换自动刷新并隔离迟到响应。输入框支持模型/思考强度选择和实测状态；设置提供自定义文本与随机四色图片测试、默认关闭的定时测活（滚动 60 秒最多 2 次、同渠道最多 2 个自动模型）。侧边刻度支持预览定位，会话重命名可请求 Agent 标题建议并由用户保存。CC Switch 导入和小红书人工浏览器登录也已修复。操作及完成度见 [运营交接指南](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/operator-handoff-2026-10-09.md)。这些新功能尚未进入旧便携 ZIP 或公开 0.2.6 安装器；真实扫码身份、发布/SMTP 和最终新包仍待验收；三种模型短回复、Kimi长回复及排队续写已取得。

**追加整改**：模型选择、保存和导入集中同页，厂商图标自动适配，模型项默认折叠。思考浮层保留九档，仅Ultra使用紫色与粒子动画。默认折叠导航、技能依赖图标与hover说明、视觉反推配置、账号状态显隐已接入。最新源码7880已取得三种模型真实短回复、Kimi长回复与排队续写、真实工具写改回执；成本与速度的计算和缺失数据提示已验。平台人工身份、非空采集、发布/SMTP及新运营包仍待验，详见[checklist](docs/user-feedback-checklist-2026-10-09.md)。

## 这一版有什么

| 工作区 | 当前能力 |
| --- | --- |
| 小动物办公室 | Three.js / WebGL 3D 工位；猫、兔、狐狸和熊的连续角色表面；在办公室原位预览、保存或取消外观编辑；真实 Agent 显式绑定 |
| 大团队与岗位 | 完整成员名单搜索、每区最多 8 个场景工位、选中成员自动定位分区；六类岗位的设备、坐姿与动作差异 |
| 看得见的工作 | 场景前直接查看任务、承接成员、已上报步骤和最近回执，打开过程或定位产出文件；阅读、书写、绘图与键鼠动作对应已观测状态，演示支持定位、暂停和重播 |
| 过程与反馈 | 点击状态查看精确会话、轮次对应的可见思考与工具回执；完成、错误和停止分别反馈；中断更新时明确保留旧快照 |
| 产出监控 | 办公室查看整个工作区近期文件，筛选类型、预览媒体、下载并跳转内容库；不猜测文件属于哪位员工 |
| 模型与执行 | 办公室可新建任务、继续当前主会话、查看结果和中断本轮；每次提交可指定渠道及对应模型，严格核验后才执行，失败不静默换用默认或备用模型；成员后续模型配置与已核验子 Agent 停止分别提供 |
| 对话与导航 | 参考Codex的工具栏+会话列表双列结构；首次/刷新默认窄工具栏和折叠会话列，忽略旧展开偏好；本次可独立手动展开，功能页收起、回聊天不自动展开，次要页面从“更多”进入；按会话保留草稿、上传归属与历史备份；归档最后会话不补同名空占位 |
| 技能选择 | 工作台快捷创作与对话共用技能选择、常驻标签和详情组件；悬停或键盘聚焦查看导读，点击编辑、保存或清除补充要求；工作台的“本次创作要求”随成功接收的提交带入新会话，对话要求按会话保留；目录失败或发送被拒绝保留选择与草稿，不修改全局技能 |
| 平台账号预览 | 悬停、聚焦或点击账号图标，查看七平台本地登录快照，沿用各品牌原图标；明确区分未登录、待读取与待在线校验，并提供账号中心入口 |
| 图片工作台 | 页面显示当前模型，可编辑并保存已连接生图服务的模型 ID，生成任务记录实际选用型号；支持剪贴板图片、视频文件及本地素材预览，视频在浏览器提取首帧作为参考图，原片不上传；实际生成仍需有效模型服务 |
| 局部图片编辑 | 在参考图上直接用画笔选择修改区域，支持橡皮、笔刷大小、清空、取消和应用；按原图尺寸上传 PNG 蒙版，取消保留原草稿，应用后仍需填写描述并主动生成；实际编辑取决于模型服务支持 |
| 视频创作 | 生图工坊内一键切换图片/视频：文生视频与图生视频、画幅与时长选择、参考图可复用上传或图库图片；任务由本地脚本执行，同时最多两个，仅发布通过 MP4 结构与首帧解码校验的成品；需在设置中配置视频通道，生成按服务商计费，OpenAI 官方已下线的 Videos 入口会被明确拒绝 |
| 协作工作流 | 四个状态泳道、显式上级关系与演示交接时间线；“需要处理”摘要区分报告问题、已停止和状态未知，并定位成员过程；等待单独展示，不猜测为审批，实时/演示/旧快照分开 |
| 模型身份 | 成员详情与名单展示调用记录观测到的模型品牌、型号、渠道和时间；配置不改变已观测身份，无法核验的别名显示通配形象；演示员工明确标注未调用真实模型 |
| 厂商形象审核 | 内置 14 家厂商与通配角色的设计清单，首批三款（豆包、DeepSeek、通配）提供可旋转、可导出参考图的 3D 审核样板；样板尚未替换办公室员工，其余仍在设计方向 |
| 内容分析 | 七平台分别展示编辑重点与材料要求，单篇 AI 显式接收平台背景；同平台同账号跨作品 AI 使用最多 12 篇材料、32 张程序事实卡，最多返回 6 条建议，每条关联至少两篇作品的有效事实卡；可保存、导出并预填验证实验，真实模型与平台链路尚未验收 |
| 统一控件与配色 | 页面下拉复用共享自定义 Select，图片/视频切换及蒙版绘制工具复用 RadioGroup；双列侧栏、弹出菜单与正文共用全局底色、边框、选中态和焦点颜色；验收范围单独记录 |
| 响应式布局 | 设置分区与模型通道自动换行；工作台、创作页、分析与办公室按侧栏展开后剩余的实际容器宽度调整列数和操作布局；长表单和过程弹层保留可滚动内容，宽表格在自身区域滚动；设备及入口验收逐项登记 |
| 演示数据开关 | 设置首页的「通用设置 → 显示演示数据」统一控制内容分析和 Agent 办公室；关闭后只显示已保存作品、实时观测或空状态，刷新与同地址标签页保持一致，保留真实记录和角色卡 |
| 热点与运行记录 | “我的热榜”展示九个来源的平台图标；增删来源后显式“保存热榜”，支持保存空列表、恢复默认和刷新恢复，浏览器存储失败不伪报已保存；来源错误、获取时间与重试分别展示，运行记录支持会话、搜索和状态筛选 |
| 发布回执与提醒 | Web 发布任务保留跨页/刷新可读的结果，区分已发布、已提交、草稿、待核实与失败；小红书、视频号、B站、抖音和快手支持只读审核后核实，可手动核实、暂停或恢复自动核实，最多 24 小时/12 次；确认公开后提醒，有可信地址才附链接，视频号暂不提供公开链接。成功邮件需在通知设置中开启；真实平台与 SMTP 仍待验收，见 [平台范围与验收](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/publish-receipts-2026-10-08.md) |
| 其他创作流程 | 保留选题、日历、账号、画像及内容库入口，持续改进本地体验 |

办公室角色由本地 Three.js 曲面与蒙皮生成，无需 Meshy 账号或模型生成额度。本轮细化四物种的体型、脸型、耳壳与狐狸尾巴，修正拇指方向、握笔/持纸接触与工位朝向，并按状态切换眼睛、眉形和嘴部神态；保留外观换色与角色卡。方案与验收范围见 [本地建模优化](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/local-character-modeling-2026-10-02.md)。

下一轮按模型厂商重建办公室角色：14 家与通配角色的设计清单和识别方案已定稿（[设计审核稿](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/model-provider-characters-2026-10-02.md)）；办公室成员已按调用记录显示观测到的模型身份；首批豆包、DeepSeek 与通配三款 3D 审核样板可在办公室内旋转预览并导出参考图。正式 3D 资产仍在审核，尚未替换当前角色。

视频创作的接口、协议与验证边界（六类适配器、参考图安全上传、MP4 校验、任务恢复与取消）见 [视频生成说明](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/video-generation-2026-10-01.md)。适配器代码存在不代表服务商已配置或已通过真实生成验收；本轮未发起付费生成。

对话、生图模型与剪贴板素材的阶段记录见 [2026-10-05 实现与验收](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/chat-studio-analysis-2026-10-05.md)，双列侧栏、对话技能选择和蒙版改进见 [10 月 8 日平台分析与组件记录](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/analysis-platform-orca-2026-10-08.md)。剪贴板能否提供视频取决于浏览器和复制来源；视频链接不会被当作视频文件读取，必要时使用文件选择。内容分析的实时概览与持久归档分别受采集字段约束；小红书/B站自动读取需稳定账号身份，其余五平台保留规范导入，不宣称七平台自动归档全部可用。

动物外观卡只改变展示，不修改提示词、权限或员工执行行为。真实模式只显示取得的证据；未上报的思考、工具输出和远程桌面不会被补写。演示模式中的角色、任务和画板始终标为模拟。

内容分析的针对性来自不同问题与材料：小红书关注使用和收藏用途，B站关注长视频承诺与追问，抖音关注开场推进，快手关注经验边界，知乎关注问题与论证，公众号关注长文交付，视频号关注分享情境。这些是编辑视角，不是平台算法结论；没有画面或留存数据时不会宣称已完成视觉或流失分析。单篇 AI 逐字核验所引原文；跨作品 AI 核验每条建议的事实标识（factId）存在且覆盖至少两篇作品，不核验原文 quote。跨作品数字由程序事实卡展示，解释仍需人工判断；相关材料变化后旧结果失效，请求期间发生变化则拒绝保存。实施与验收范围见 [2026-10-08 平台分析与组件统一](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/analysis-platform-orca-2026-10-08.md)。

本次已实现默认“我的数据”和“账号与作品 → 问题 → 结论行动”三步分析。稳定身份小红书/B站读取最近20并缓存、标数量/时间/总量是否已知；其他五平台保留规范导入。正常身份时间重写误判登录变化已修，联合后端109/同步28及专业前端15通过，旧100/33重叠不相加。三步/加载真UI已验，真实非空采集仍待确认；有限样本不等于全历史。

本轮参考 [stablyai/orca](https://github.com/stablyai/orca) 的关注事项与过程定位，改善办公室“现在需要看哪里”；另参考 LinkedIn Orca 的问题驱动分析。未引入这些项目为运行依赖，真实任务调度、人工等待协议、产物归属和交接回执仍待继续。源码对照与许可边界见 [Orca 调研](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/orca-research-2026-10-08.md)。

办公室进一步参考腾讯 [Marvis 官方公开资料](https://marvis.qq.com/docs/agent-system)，将任务、承接成员、已上报步骤、回执和产出位置前置。没有记录时显示缺失状态，不推算完成百分比；工作区文件也不自动归属于选中成员。本轮没有安装或登录 Marvis 客户端，不宣称两者体验已全面等同；具体依据与边界见 [Marvis 调研及落地记录](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/marvis-office-2026-10-08.md)。

另对照 [画境 AI Image Studio](https://gitee.com/starry-sea-1412/ai-image-studio)，本轮优先独立实现参考图上的蒙版绘制，复用现有上传与生成链路。风格模板库、持久图片队列和多渠道对照仍是后续工作；未引入其服务或运行依赖。功能对照、实施次序与 MIT 许可边界见 [生图工坊比较](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/image-studio-comparison-2026-10-08.md)。

办公室的「新建任务 / 继续当前会话」复用对话执行链路，停止操作等待后台确认并保留已收到结果。未指定模型时沿用原会话配置；明确指定渠道模型时，支持已核验严格语义的 **OpenClaw 2026.9.2、2026.9.6**，并检查实际网关版本、权限和本次选择，其他版本仍需独立核验。2026.9.6已在本机完成只读CLI/HTTP能力检查，没有推理、增权或写入配置；当前新界面浏览器验收仍待。能力或模型核验失败会拒绝该任务，不静默回退。界面保留本轮指定值，实际执行型号仍以运行记录为准；已登记配置、API连通与真实推理是不同的验证层次。

成员模型保存另行影响该 Agent 会话后续调用，不会重跑已完成任务。单独子 Agent 停止依赖准确的会话、轮次与运行身份，可能同时停止其派生任务，不停止父级或同级；没有可核验身份时不提供假成功。当前环境已完成三个配置模型的真实短回复；真实多 Agent 制作与上游输出质量仍分别验收。新链路与检查范围见 [响应式、技能与办公室任务记录](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/responsive-office-skills-2026-10-08.md)，既有控制边界保留于 [专业办公室记录](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/professional-office-2026-10-01.md)。

角色自然持物、完整动作与任务交接仍在迭代；职责/能力配置、真实任务产出归属、逐帧碰撞与性能尚未完整验收。10 月 1 日热点 HTTP 抽查中，7 个来源取得内容，知乎与头条限流；10 月 8 日知乎主来源抽查恢复并返回 30 条问题热榜，不能据此保证长期可用。历史逐项状态见 [工作台整改与验收](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/workspace-experience-validation-2026-10-01.md)。

知乎备用适配通过启动环境变量 `EASEL_ZHIHU_DAILYHOT_URL` 显式启用，默认关闭；可配置自部署或获准使用、兼容 DailyHotApi-Go 的完整问题热榜接口，重启后端后仅在主来源失败或冷却时尝试。公开演示实例只做过核验，没有设为默认依赖；这不是搜索关键词 API，也不以响应生成时间冒充榜单更新时间。配置方式、实际 HTTP 证据与限制见 [知乎热榜修正记录](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/zhihu-trends-2026-10-08.md)。

## Windows 便携预览候选

Windows x64 便携候选包含应用、前端、CPython 3.12.10、Node 24.19.0、OpenClaw 2026.9.2、FFmpeg 9.0.1 与匹配 Chromium 153.0.8010.12 / r1243。完整解压到较短可写目录后，通过 `Easel.exe` 或启动命令文件使用包内运行环境；配置和产出保存在同目录的 `data`。图形控制窗口关闭时停止本副本服务，另有检查和停止用的 `.cmd` 入口。

模型服务需要使用者自己的 API Key；可选 Whisper、rembg 等模型权重未预装。当前候选在中文空格目录实际解压，两轮完整文件校验通过；从 System32、隔离 PATH 首启耗时 160.51 秒，包内 Python、Node 及两种 Chromium 已实际运行。欢迎引导、模型表单、技能标签/补充要求、演示开关及回执/发布/通知设置入口已在真实浏览器检查；没有填写凭据或执行真实发布。旧候选的 PDF 解析、搬迁与双副本隔离记录保留在文档中。图形双击、全新 Windows、真实模型/平台/SMTP、签名和公开 Release 仍待验收；**已有 0.2.6 联网安装包保持原样**。详见 [Windows 便携预览说明](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/windows-portable.md)。

## 从本仓库源码开始

Windows 首先准备 Git、Python 3.10+（建议 3.12）、Node.js 24.16+（24.x）或 26.1+、FFmpeg，并确认终端能找到这些命令。安装脚本会指出缺少的工具。

```bash
git clone --branch codex/upstream-compat-2026-10-10 https://github.com/StarrySea1412/Easel.git
cd Easel
```

Windows 10/11 使用 PowerShell：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -NonInteractive -DeferBrowser -DataDir .\data
.\.venv\Scripts\python.exe .\scripts\start_workspace.py --data-dir .\data --port 7860
```

这条快速启动路径明确把平台登录/发布用的独立浏览器留待稍后安装，先打开基础工作台。安装记录会标明“浏览器已延后”，不会把它算作已安装；依赖该浏览器的平台操作需要补装后再使用。补装时运行下面的命令，已完成阶段会保留：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -NonInteractive -DataDir .\data
```

如果希望首次就安装全部组件，直接使用不带 `-DeferBrowser` 的命令。官方浏览器下载需要能访问相应 CDN；慢网络默认等待 120 秒，仍失败时可先选择上述快速启动路径。

第一条只需首次安装或更新依赖时运行；以后在 Easel 目录运行第二条即可。安装和启动必须使用同一个 `data` 目录，启动器会恢复该目录保存的网关配置和本地工具路径。不要改用裸 `easel web` 命令替代这一步。`ExecutionPolicy Bypass` 只作用于这次安装进程，不修改系统执行策略。

安装脚本会检查工具、建立本地环境和前端，并配置隔离的 OpenClaw profile。缺少系统工具时先按提示安装；只有显式使用 `-AllowWinget` 才允许脚本通过 winget 安装缺失工具。`-NonInteractive` 将模型配置留到网页设置。首次安装需要联网下载依赖，终端显示安装成功后再启动；失败时按错误提示处理并重跑同一安装命令，可续接已完成阶段。不要关闭仍在安装的窗口，也不能把它当作离线便携包。

macOS / Linux 保留原有安装入口：

```bash
bash setup.sh
source .venv/bin/activate
easel web --port 7860
```

启动器会打开浏览器，也可访问终端输出的本地地址（默认 `http://127.0.0.1:7860/`，端口被占用时以输出为准）。成功后服务在后台运行，可以关闭启动终端；下次运行同一命令会复用当前工作台。首次欢迎页可选「先用通用模式」，再进入「设置 → 模型配置 → 对话」：同页添加服务或展开CC Switch/OpenClaw导入，预览后确认；选择主模型并点击「保存并使用」。获取模型列表只读列表，真实回复需在模型测活中手动验证，可能计费；自动测活默认关闭。尚未配置时可以浏览工作台、选择技能、管理本地选题和日历，不能据此认为AI已能生成内容。

上述基础启动路径已用独立源码、空数据、新 Python 环境和重新安装的前端依赖实际验证：安装与新终端启动成功，浏览器首页、首次引导和模型配置表单可用。测试机器已有上述系统工具；官方 Chromium 下载仍超时，完整平台浏览器安装未通过。首装中发现的 biliup 源码编译问题已通过与发行锁一致的 1.2.9 wheel 解决；模型密钥模板默认留空，不会误报“已配置”。详见[新用户验收记录](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/responsive-office-skills-2026-10-08.md#新用户首次运行)。

工作台快捷输入可先选技能、查看导读并保存本次创作的补充要求；提交被接收后，正文、技能与要求一起移交新会话。拒绝发送或本地保存失败时保留草稿；接收提交不代表模型任务已成功完成。进入「Agent 办公室」可新建或继续主会话任务，也可选择成员原位编辑外观。Windows 构建、数据目录与恢复说明见 [安装器文档](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/windows-installer.md)。不要把密钥、平台登录态或个人产出提交到 Git。

不需要内置样例时，进入「设置 → 通用设置」，关闭「显示演示数据」。成功后立即生效并保存在当前浏览器，无需重启服务；存储失败会提示且保留原开关状态。重新开启即可恢复演示入口，不会删除已导入作品、会话或员工角色配置。

## 开发与验证

前端位于 `web/frontend`，使用 React、TypeScript、Vite 和 Three.js；本地后端入口是 `web/app.py`，Python CLI 位于 `easel/`。使用项目要求的 Node.js 24.16+（24.x）或 26.1+。

```bash
cd web/frontend
npm ci
npm test
npm run lint
npm run build
```

在项目根目录、已安装测试依赖的 Python 环境中运行：

```bash
python -m pytest -q
```

- [当前交付进度](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/secondary-development-progress.md)：源码、预览、安装包分别记录。
- [本次用户要求清单](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/user-requirements-2026-10-08.md)：逐项对应实现、验收与剩余工作；每次用户打断追加，先记录原话要点、验收条件和优先级，再继续修改并同步并行分工。
- [响应式、快捷技能与办公室任务验收](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/responsive-office-skills-2026-10-08.md)：本轮页面矩阵、请求链路与真实模型边界。
- [工作台体验整改清单](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/workspace-experience-action-plan-2026-10-01.md)：已完成内容、用户反馈与待办。
- [本轮验收](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/workspace-experience-validation-2026-10-01.md)：区分真实浏览器、隔离 HTTP、模拟记录和网关协议测试。
- [开发计划](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/secondary-development-plan.md)：剩余真实模型链路与安装升级验收。
- [技能功能映射](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/skill-function-mapping.md)：保留的技能与脚本能力。

2026-10-08 响应式、工作台技能与办公室任务已通过前端 **639/639**、Python **1449 passed / 6 skipped**，以及 lint、TypeScript 和生产构建。16 个主页面完成 390/768/1280px 的入口与布局检查；运行记录会话条和日历长标题的最后修正已在浏览器复核。首次安装追加修正及其独立环境结果单列于[最新验收文档](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/responsive-office-skills-2026-10-08.md)，不以旧环境运行替代新用户启动，也不把未核验的外部平台和真实模型标记为通过。

此前 R15 演示开关阶段：前端 **572/572**，lint、TypeScript 与生产构建通过。更早同日 Python 全量为 **1417 passed / 6 skipped**；R15 只改前端，未重跑后端测试。这些历史结果不替代最新追加实现的完整验收，自动测试数也不代表同数量的真实服务验证。

此前阶段的真实浏览器已完成桌面与 **390×844** 窄屏的侧栏、对话技能补充要求、热榜来源保存和蒙版操作检查；办公室问题跳转使用演示数据，**640×480** 二值 PNG 蒙版已实际上传至本地后端。技能导读的键盘入口已验证，独立鼠标悬停仅有模拟 DOM 覆盖。逐项范围见 [该阶段验收记录](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/analysis-platform-orca-2026-10-08.md)。

演示开关已完成真实浏览器鼠标和 Space/Enter 操作、刷新恢复、设置分区导航及 390×844 布局检查。另一标签页关闭时，已打开的模拟过程、团队、时间轴和产出预览退出；内容分析保留已导入记录。该验证未调用真实模型。

CI 覆盖 `main` 与 `codex/**` 开发分支。Windows 安装器构建仍为手动工作流，构建不会自动发布 Release。新版安装器的发现与下载元数据指向本仓库；没有已发布版本时不会回退安装上游包。

当前本地验证不等于真实模型推理、多 Agent 联动、所有平台发布或新安装包升级已经验收。本轮没有自有管理员账号系统。

## 来源与许可证

本项目基于 [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel)，感谢原作者及贡献者。原有功能、历史提交和必要资源保留；本仓库维护独立的创作工作台、办公室交互和可靠性改进，不代表上游官方发行。

采用 [Apache License 2.0](LICENSE)，保留[原有致谢](https://github.com/StarrySea1412/Easel/blob/codex/upstream-compat-2026-10-10/docs/ACKNOWLEDGMENTS.md)。OpenClaw、前端库及技能中的第三方组件继续遵循各自许可证；发布包保留所需许可证信息。
