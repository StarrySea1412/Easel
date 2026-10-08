# Easel 创作工作台

面向本地使用的专业创作工具。将对话、素材、内容项目与小动物 Agent 办公室放在一个工作空间，能看见任务、操作记录和工作区产出。

[English](README_EN.md) · [当前源码](https://github.com/StarrySea1412/Easel/tree/codex/creator-workflow) · [本仓库反馈](https://github.com/StarrySea1412/Easel/issues) · [更新记录](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/CHANGELOG.md)

> 本项目由 [StarrySea1412/Easel](https://github.com/StarrySea1412/Easel) 仓库维护，基于 [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel) 二次开发。本文更新于 **2026-10-08**，介绍 `codex/creator-workflow` 的当前源码；`main` 首页同步展示项目说明，功能代码仍在开发分支。已有 0.2.6 EXE / ZIP 来自 `38e728c`，不包含后续工作台与办公室改动，尚未发布包含这些功能的新安装器。

## 这一版有什么

| 工作区 | 当前能力 |
| --- | --- |
| 小动物办公室 | Three.js / WebGL 3D 工位；猫、兔、狐狸和熊的连续角色表面；在办公室原位预览、保存或取消外观编辑；真实 Agent 显式绑定 |
| 大团队与岗位 | 完整成员名单搜索、每区最多 8 个场景工位、选中成员自动定位分区；六类岗位的设备、坐姿与动作差异 |
| 看得见的工作 | 阅读、书写、绘图与键鼠动作；持笔取放和阶段过渡；电脑显示已观测任务和工具名，可查看清晰屏幕与工作过程；演示支持定位、暂停和重播 |
| 过程与反馈 | 点击状态查看精确会话、轮次对应的可见思考与工具回执；完成、错误和停止分别反馈；中断更新时明确保留旧快照 |
| 产出监控 | 办公室查看整个工作区近期文件，筛选类型、预览媒体、下载并跳转内容库；不猜测文件属于哪位员工 |
| 模型与执行 | 读取已配置渠道，在网关能力与身份通过核验时为目标 Agent 会话设置后续调用模型；主会话和单独子 Agent 停止范围分开 |
| 对话与导航 | 参考 Codex 的工具栏 + 会话列表双列结构；工具栏可切换图标/图标加名称，会话列表独立展开/收起并分别记忆；默认窄工具栏和展开会话列，次要页面从“更多”进入；按会话保留草稿、上传归属与历史备份 |
| 技能选择 | 输入区显示已选技能标签和数量；悬停或键盘聚焦查看本机技能导读，点击编辑、保存或清除“本会话补充要求”；选择与要求按会话保留，之后发送采用当次快照，不修改全局技能或历史消息；目录失败不清空选择，保存失败保留草稿并提示 |
| 平台账号预览 | 悬停、聚焦或点击账号图标，查看七平台本地登录快照，沿用各品牌原图标；明确区分未登录、待读取与待在线校验，并提供账号中心入口 |
| 图片工作台 | 页面显示当前模型，可编辑并保存已连接生图服务的模型 ID，生成任务记录实际选用型号；支持剪贴板图片、视频文件及本地素材预览，视频在浏览器提取首帧作为参考图，原片不上传；实际生成仍需有效模型服务 |
| 局部图片编辑 | 在参考图上直接用画笔选择修改区域，支持橡皮、笔刷大小、清空、取消和应用；按原图尺寸上传 PNG 蒙版，取消保留原草稿，应用后仍需填写描述并主动生成；实际编辑取决于模型服务支持 |
| 视频创作 | 生图工坊内一键切换图片/视频：文生视频与图生视频、画幅与时长选择、参考图可复用上传或图库图片；任务由本地脚本执行，同时最多两个，仅发布通过 MP4 结构与首帧解码校验的成品；需在设置中配置视频通道，生成按服务商计费，OpenAI 官方已下线的 Videos 入口会被明确拒绝 |
| 协作工作流 | 四个状态泳道、显式上级关系与演示交接时间线；“需要处理”摘要区分报告问题、已停止和状态未知，并定位成员过程；等待单独展示，不猜测为审批，实时/演示/旧快照分开 |
| 模型身份 | 成员详情与名单展示调用记录观测到的模型品牌、型号、渠道和时间；配置不改变已观测身份，无法核验的别名显示通配形象；演示员工明确标注未调用真实模型 |
| 厂商形象审核 | 内置 14 家厂商与通配角色的设计清单，首批三款（豆包、DeepSeek、通配）提供可旋转、可导出参考图的 3D 审核样板；样板尚未替换办公室员工，其余仍在设计方向 |
| 内容分析 | 七平台分别展示编辑重点与材料要求，单篇 AI 显式接收平台背景；同平台同账号跨作品 AI 使用最多 12 篇材料、32 张程序事实卡，最多返回 6 条建议，每条关联至少两篇作品的有效事实卡；可保存、导出并预填验证实验，真实模型与平台链路尚未验收 |
| 统一控件与配色 | 页面下拉复用共享自定义 Select，图片/视频切换及蒙版绘制工具复用 RadioGroup；双列侧栏、弹出菜单与正文共用全局底色、边框、选中态和焦点颜色；验收范围单独记录 |
| 热点与运行记录 | “我的热榜”展示九个来源的平台图标；增删来源后显式“保存热榜”，支持保存空列表、恢复默认和刷新恢复，浏览器存储失败不伪报已保存；来源错误、获取时间与重试分别展示，运行记录支持会话、搜索和状态筛选 |
| 其他创作流程 | 保留选题、日历、账号、画像、内容库及发布入口，持续改进本地体验 |

办公室角色由本地 Three.js 曲面与蒙皮生成，无需 Meshy 账号或模型生成额度。本轮细化四物种的体型、脸型、耳壳与狐狸尾巴，修正拇指方向、握笔/持纸接触与工位朝向，并按状态切换眼睛、眉形和嘴部神态；保留外观换色与角色卡。方案与验收范围见 [本地建模优化](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/local-character-modeling-2026-10-02.md)。

下一轮按模型厂商重建办公室角色：14 家与通配角色的设计清单和识别方案已定稿（[设计审核稿](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/model-provider-characters-2026-10-02.md)）；办公室成员已按调用记录显示观测到的模型身份；首批豆包、DeepSeek 与通配三款 3D 审核样板可在办公室内旋转预览并导出参考图。正式 3D 资产仍在审核，尚未替换当前角色。

视频创作的接口、协议与验证边界（六类适配器、参考图安全上传、MP4 校验、任务恢复与取消）见 [视频生成说明](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/video-generation-2026-10-01.md)。适配器代码存在不代表服务商已配置或已通过真实生成验收；本轮未发起付费生成。

对话、生图模型与剪贴板素材的阶段记录见 [2026-10-05 实现与验收](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/chat-studio-analysis-2026-10-05.md)，当前双列侧栏、技能选择和蒙版改进见 [2026-10-08 最新记录](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/analysis-platform-orca-2026-10-08.md)。剪贴板能否提供视频取决于浏览器和复制来源；视频链接不会被当作视频文件读取，必要时使用文件选择。内容分析的实时概览与持久归档分别受采集字段约束；目前其余六平台缺少可核验的稳定账号标识，应使用规范导入，不宣称七平台自动归档全部可用。

动物外观卡只改变展示，不修改提示词、权限或员工执行行为。真实模式只显示取得的证据；未上报的思考、工具输出和远程桌面不会被补写。演示模式中的角色、任务和画板始终标为模拟。

内容分析的针对性来自不同问题与材料：小红书关注使用和收藏用途，B站关注长视频承诺与追问，抖音关注开场推进，快手关注经验边界，知乎关注问题与论证，公众号关注长文交付，视频号关注分享情境。这些是编辑视角，不是平台算法结论；没有画面或留存数据时不会宣称已完成视觉或流失分析。单篇 AI 逐字核验所引原文；跨作品 AI 核验每条建议的事实标识（factId）存在且覆盖至少两篇作品，不核验原文 quote。跨作品数字由程序事实卡展示，解释仍需人工判断；相关材料变化后旧结果失效，请求期间发生变化则拒绝保存。实施与验收范围见 [2026-10-08 平台分析与组件统一](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/analysis-platform-orca-2026-10-08.md)。

本轮参考 [stablyai/orca](https://github.com/stablyai/orca) 的关注事项与过程定位，改善办公室“现在需要看哪里”；另参考 LinkedIn Orca 的问题驱动分析。未引入这些项目为运行依赖，真实任务调度、人工等待协议、产物归属和交接回执仍待继续。源码对照与许可边界见 [Orca 调研](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/orca-research-2026-10-08.md)。

另对照 [画境 AI Image Studio](https://gitee.com/starry-sea-1412/ai-image-studio)，本轮优先独立实现参考图上的蒙版绘制，复用现有上传与生成链路。风格模板库、持久图片队列和多渠道对照仍是后续工作；未引入其服务或运行依赖。功能对照、实施次序与 MIT 许可边界见 [生图工坊比较](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/image-studio-comparison-2026-10-08.md)。

模型控制依赖已配对的本地网关、准确的会话/运行身份以及相应权限。模型保存影响该 Agent 会话后续调用，不会重跑已完成任务。独立停止可能停止该员工派生的任务；不停止父级或同级。网关未核验时按钮保持不可用。完整边界见 [专业办公室实现与验证](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/professional-office-2026-10-01.md)。

角色自然持物、完整动作与任务交接仍在迭代；职责/能力配置、真实任务产出归属、逐帧碰撞与性能尚未完整验收。10 月 1 日热点 HTTP 抽查中，7 个来源取得内容，知乎与头条限流；10 月 8 日知乎主来源抽查恢复并返回 30 条问题热榜，不能据此保证长期可用。历史逐项状态见 [工作台整改与验收](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/workspace-experience-validation-2026-10-01.md)。

知乎备用适配通过启动环境变量 `EASEL_ZHIHU_DAILYHOT_URL` 显式启用，默认关闭；可配置自部署或获准使用、兼容 DailyHotApi-Go 的完整问题热榜接口，重启后端后仅在主来源失败或冷却时尝试。公开演示实例只做过核验，没有设为默认依赖；这不是搜索关键词 API，也不以响应生成时间冒充榜单更新时间。配置方式、实际 HTTP 证据与限制见 [知乎热榜修正记录](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/zhihu-trends-2026-10-08.md)。

## 从本仓库源码开始

```bash
git clone --branch codex/creator-workflow https://github.com/StarrySea1412/Easel.git
cd Easel
```

Windows 10/11 使用 PowerShell：

```powershell
.\setup.ps1 -NonInteractive
.\.venv\Scripts\easel.exe web --port 7860
```

安装脚本会检查工具、建立本地环境和前端，并配置隔离的 OpenClaw profile。缺少系统工具时先按提示安装；只有显式使用 `-AllowWinget` 才允许脚本通过 winget 安装缺失工具。`-NonInteractive` 将模型配置留到网页设置。首次安装仍需网络，不能当作离线便携包。

macOS / Linux 保留原有安装入口：

```bash
bash setup.sh
source .venv/bin/activate
easel web --port 7860
```

打开终端输出的本地地址，在「设置」配置自己的模型渠道；进入「Agent 办公室」选择成员后可原位编辑外观。Windows 构建、数据目录与恢复说明见 [安装器文档](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/windows-installer.md)。不要把密钥、平台登录态或个人产出提交到 Git。

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

- [当前交付进度](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/secondary-development-progress.md)：源码、预览、安装包分别记录。
- [本次用户要求清单](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/user-requirements-2026-10-08.md)：逐项对应实现、验收与剩余工作。
- [工作台体验整改清单](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/workspace-experience-action-plan-2026-10-01.md)：已完成内容、用户反馈与待办。
- [本轮验收](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/workspace-experience-validation-2026-10-01.md)：区分真实浏览器、隔离 HTTP、模拟记录和网关协议测试。
- [开发计划](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/secondary-development-plan.md)：剩余真实模型链路与安装升级验收。
- [技能功能映射](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/skill-function-mapping.md)：保留的技能与脚本能力。

2026-10-08 本轮自动检查：前端 **555/555**，Python **1417 passed / 6 skipped**，lint、TypeScript 与生产构建通过。自动测试数不代表同数量的真实服务验证。

真实浏览器已完成桌面与 **390×844** 窄屏的侧栏、技能补充要求、热榜来源保存和蒙版操作检查；办公室问题跳转使用演示数据，**640×480** 二值 PNG 蒙版已实际上传至本地后端。技能导读的键盘入口已验证，独立鼠标悬停仅有模拟 DOM 覆盖。逐项范围见 [本轮验收记录](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/analysis-platform-orca-2026-10-08.md)。

CI 覆盖 `main` 与 `codex/**` 开发分支。Windows 安装器构建仍为手动工作流，构建不会自动发布 Release。新版安装器的发现与下载元数据指向本仓库；没有已发布版本时不会回退安装上游包。

当前本地验证不等于真实模型推理、多 Agent 联动、所有平台发布或新安装包升级已经验收。本轮没有自有管理员账号系统。

## 来源与许可证

本项目基于 [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel)，感谢原作者及贡献者。原有功能、历史提交和必要资源保留；本仓库维护独立的创作工作台、办公室交互和可靠性改进，不代表上游官方发行。

采用 [Apache License 2.0](LICENSE)，保留[原有致谢](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/ACKNOWLEDGMENTS.md)。OpenClaw、前端库及技能中的第三方组件继续遵循各自许可证；发布包保留所需许可证信息。
