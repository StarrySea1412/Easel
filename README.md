# Easel 创作工作台

面向本地使用的专业创作工具。将对话、素材、内容项目与小动物 Agent 办公室放在一个工作空间，能看见任务、操作记录和工作区产出。

[English](README_EN.md) · [当前源码](https://github.com/StarrySea1412/Easel/tree/codex/creator-workflow) · [本仓库反馈](https://github.com/StarrySea1412/Easel/issues) · [更新记录](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/CHANGELOG.md)

> 本项目由 [StarrySea1412/Easel](https://github.com/StarrySea1412/Easel) 仓库维护，基于 [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel) 二次开发。本文更新于 **2026-10-04**，介绍 `codex/creator-workflow` 的当前源码；`main` 首页同步展示项目说明，功能代码仍在开发分支。已有 0.2.6 EXE / ZIP 来自 `38e728c`，不包含后续工作台与办公室改动，尚未发布包含这些功能的新安装器。

## 这一版有什么

| 工作区 | 当前能力 |
| --- | --- |
| 小动物办公室 | Three.js / WebGL 3D 工位；猫、兔、狐狸和熊的连续角色表面；在办公室原位预览、保存或取消外观编辑；真实 Agent 显式绑定 |
| 大团队与岗位 | 完整成员名单搜索、每区最多 8 个场景工位、选中成员自动定位分区；六类岗位的设备、坐姿与动作差异 |
| 看得见的工作 | 阅读、书写、绘图与键鼠动作；持笔取放和阶段过渡；电脑显示已观测任务和工具名，可查看清晰屏幕与工作过程；演示支持定位、暂停和重播 |
| 过程与反馈 | 点击状态查看精确会话、轮次对应的可见思考与工具回执；完成、错误和停止分别反馈；中断更新时明确保留旧快照 |
| 产出监控 | 办公室查看整个工作区近期文件，筛选类型、预览媒体、下载并跳转内容库；不猜测文件属于哪位员工 |
| 模型与执行 | 读取已配置渠道，在网关能力与身份通过核验时为目标 Agent 会话设置后续调用模型；主会话和单独子 Agent 停止范围分开 |
| 对话与素材 | 按会话保存文字草稿，保护晚到的上传结果；提供历史备份与只读副本导入，损坏存储不会被静默覆盖 |
| 图片工作台 | 围绕上传图片、编辑描述和画布组织界面，高级参数按需展开；页面切换保留编辑草稿，实际生成需要配置图片模型 |
| 视频创作 | 生图工坊内一键切换图片/视频：文生视频与图生视频、画幅与时长选择、参考图可复用上传或图库图片；任务由本地脚本执行，同时最多两个，仅发布通过 MP4 结构与首帧解码校验的成品；需在设置中配置视频通道，生成按服务商计费，OpenAI 官方已下线的 Videos 入口会被明确拒绝 |
| 协作工作流 | 办公室新增工作流面板：按状态分四个泳道展示成员与任务，按显式上级关系绘制协作连线；演示模式叠加脚本化交接与动态时间线，只展示当前模式已上报的记录 |
| 模型身份 | 成员详情与名单展示调用记录观测到的模型品牌、型号、渠道和时间；配置不改变已观测身份，无法核验的别名显示通配形象；演示员工明确标注未调用真实模型 |
| 厂商形象审核 | 内置 14 家厂商与通配角色的设计清单，首批三款（豆包、DeepSeek、通配）提供可旋转、可导出参考图的 3D 审核样板；样板尚未替换办公室员工，其余仍在设计方向 |
| 内容分析 | 面向新手的分析入口与独立示例，支持筛选、排序、依据展开和行动勾选；示例作品明确标为虚构，真实分析需要用户数据 |
| 热点与运行记录 | 热点按来源展示内容、错误、更新时间与重试入口；运行记录页内顶部导航支持会话、搜索和状态筛选 |
| 其他创作流程 | 保留选题、日历、账号、画像、内容库及发布入口，持续改进本地体验 |

办公室角色由本地 Three.js 曲面与蒙皮生成，无需 Meshy 账号或模型生成额度。本轮细化四物种的体型、脸型、耳壳与狐狸尾巴，修正拇指方向、握笔/持纸接触与工位朝向，并按状态切换眼睛、眉形和嘴部神态；保留外观换色与角色卡。方案与验收范围见 [本地建模优化](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/local-character-modeling-2026-10-02.md)。

下一轮按模型厂商重建办公室角色：14 家与通配角色的设计清单和识别方案已定稿（[设计审核稿](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/model-provider-characters-2026-10-02.md)）；办公室成员已按调用记录显示观测到的模型身份；首批豆包、DeepSeek 与通配三款 3D 审核样板可在办公室内旋转预览并导出参考图。正式 3D 资产仍在审核，尚未替换当前角色。

视频创作的接口、协议与验证边界（六类适配器、参考图安全上传、MP4 校验、任务恢复与取消）见 [视频生成说明](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/video-generation-2026-10-01.md)。适配器代码存在不代表服务商已配置或已通过真实生成验收；本轮未发起付费生成。

动物外观卡只改变展示，不修改提示词、权限或员工执行行为。真实模式只显示取得的证据；未上报的思考、工具输出和远程桌面不会被补写。演示模式中的角色、任务和画板始终标为模拟。

模型控制依赖已配对的本地网关、准确的会话/运行身份以及相应权限。模型保存影响该 Agent 会话后续调用，不会重跑已完成任务。独立停止可能停止该员工派生的任务；不停止父级或同级。网关未核验时按钮保持不可用。完整边界见 [专业办公室实现与验证](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/professional-office-2026-10-01.md)。

角色自然持物、完整动作与任务交接仍在迭代；职责/能力配置、真实任务产出归属、逐帧碰撞与性能尚未完整验收。热点最近一轮真实 HTTP 检查有 7 个来源取得内容，知乎与头条返回限流，界面会分别提示；这不代表来源长期可用。逐项状态见 [工作台整改与验收](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/workspace-experience-validation-2026-10-01.md)。

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
- [工作台体验整改清单](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/workspace-experience-action-plan-2026-10-01.md)：已完成内容、用户反馈与待办。
- [本轮验收](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/workspace-experience-validation-2026-10-01.md)：区分真实浏览器、隔离 HTTP、模拟记录和网关协议测试。
- [开发计划](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/secondary-development-plan.md)：剩余真实模型链路与安装升级验收。
- [技能功能映射](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/skill-function-mapping.md)：保留的技能与脚本能力。

CI 覆盖 `main` 与 `codex/**` 开发分支。Windows 安装器构建仍为手动工作流，构建不会自动发布 Release。新版安装器的发现与下载元数据指向本仓库；没有已发布版本时不会回退安装上游包。

当前本地验证不等于真实模型推理、多 Agent 联动、所有平台发布或新安装包升级已经验收。本轮没有自有管理员账号系统。

## 来源与许可证

本项目基于 [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel)，感谢原作者及贡献者。原有功能、历史提交和必要资源保留；本仓库维护独立的创作工作台、办公室交互和可靠性改进，不代表上游官方发行。

采用 [Apache License 2.0](LICENSE)，保留[原有致谢](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/ACKNOWLEDGMENTS.md)。OpenClaw、前端库及技能中的第三方组件继续遵循各自许可证；发布包保留所需许可证信息。
