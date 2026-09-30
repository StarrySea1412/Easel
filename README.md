# Easel 创作工作台

面向本地使用的专业创作工具。将对话、素材、内容项目与小动物 Agent 办公室放在一个工作空间，能看见任务、操作记录和工作区产出。

[English](README_EN.md) · [当前开发分支](https://github.com/StarrySea1412/Easel/tree/codex/creator-workflow) · [迭代计划](docs/secondary-development-plan.md) · [更新记录](CHANGELOG.md)

> 本仓库维护基于 [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel) 的定制版本。当前开发分支为 `codex/creator-workflow`。下面介绍的是本仓库的新源码，已有 0.2.6 EXE / ZIP 来自 `38e728c`，不包含后续办公室与可靠性迭代；尚未发布包含这些功能的新安装器。

## 这一版有什么

| 工作区 | 当前能力 |
| --- | --- |
| 小动物办公室 | 真正的 Three.js / WebGL 3D 工位；小猫、兔子、狐狸和小熊角色卡；服装、毛色、配饰与真实 Agent 显式绑定 |
| 看得见的工作 | 阅读资料夹、书写与绘图板等动作由已观测操作驱动；电脑显示任务和工具名，选中工位可查看清晰屏幕与工作过程 |
| 过程与反馈 | 点击状态查看精确会话、轮次对应的可见思考与工具回执；完成、错误和停止分别反馈；中断更新时明确保留旧快照 |
| 产出监控 | 办公室查看整个工作区近期文件，筛选类型、预览媒体、下载并跳转内容库；不猜测文件属于哪位员工 |
| 模型与执行 | 读取已配置渠道，在网关能力与身份通过核验时为目标 Agent 会话设置后续调用模型；主会话和单独子 Agent 停止范围分开 |
| 对话与素材 | 按会话保存文字草稿，保护晚到的上传结果；提供历史备份与只读副本导入，损坏存储不会被静默覆盖 |
| 创作流程 | 保留上游的热点、选题、日历、生图、账号、画像、内容库及发布入口，持续改进本地体验 |

动物外观卡只改变展示，不修改提示词、权限或员工执行行为。真实模式只显示取得的证据；未上报的思考、工具输出和远程桌面不会被补写。演示模式中的角色、任务和画板始终标为模拟。

模型控制依赖已配对的本地网关、准确的会话/运行身份以及相应权限。模型保存影响该 Agent 会话后续调用，不会重跑已完成任务。独立停止可能停止该员工派生的任务；不停止父级或同级。网关未核验时按钮保持不可用。完整边界见 [专业办公室实现与验证](docs/professional-office-2026-10-01.md)。

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

打开终端输出的本地地址，在「设置」配置自己的模型渠道；在「设置 → 员工角色卡」更换动物形象。Windows 构建、数据目录与恢复说明见 [安装器文档](docs/windows-installer.md)。不要把密钥、平台登录态或个人产出提交到 Git。

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

- [当前交付进度](docs/secondary-development-progress.md)：源码、预览、安装包分别记录。
- [专业办公室验证](docs/professional-office-2026-10-01.md)：区分真实浏览器、隔离 HTTP、模拟记录和网关协议测试。
- [开发计划](docs/secondary-development-plan.md)：剩余真实模型链路与安装升级验收。
- [技能功能映射](docs/skill-function-mapping.md)：保留的技能与脚本能力。

CI 覆盖 `main` 与 `codex/**` 开发分支。Windows 安装器构建仍为手动工作流，构建不会自动发布 Release。新版安装器的发现与下载元数据指向本仓库；没有已发布版本时不会回退安装上游包。

当前本地验证不等于真实模型推理、多 Agent 联动、所有平台发布或新安装包升级已经验收。本轮没有自有管理员账号系统。

## 来源与许可证

本项目基于 [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel)，感谢原作者及贡献者。原有功能、历史提交和必要资源保留；本仓库维护独立的创作工作台、办公室交互和可靠性改进，不代表上游官方发行。

采用 [Apache License 2.0](LICENSE)。OpenClaw、前端库及技能中的第三方组件继续遵循各自许可证；发布包保留所需许可证信息。
