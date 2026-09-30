# Easel 创作工作台

把想法、图片、内容和 AI 助手放在同一个本地工作空间里。

本仓库是基于 **[ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel)** 修改和持续开发的独立版本。我们保留原项目的创作流程与技能基础，重点改进日常工作台体验、Windows 使用体验、图片创作、内容复盘与可视化 Agent 工作室。它不是原项目的官方发行版。

[English](README_EN.md) · [查看开发分支](https://github.com/StarrySea1412/Easel/tree/codex/creator-workflow) · [反馈问题](https://github.com/StarrySea1412/Easel/issues) · [版本发布](https://github.com/StarrySea1412/Easel/releases)

> 当前功能开发位于 `codex/creator-workflow`。`main` 的首页说明用于介绍本仓库；体验定制功能请使用开发分支，并以对应版本的发布说明为准。源码中的新功能不代表已经包含在旧安装包里。

## 在这里可以做什么

| 工作区 | 用途 |
| --- | --- |
| 对话与创作 | 和 AI 讨论想法，附上素材，持续修改内容，保留会话与草稿 |
| 生图工坊 | 从文字生成图片，上传图片继续修改，提取图片描述，复用已有作品 |
| 热点与选题 | 浏览可用来源的热榜，把感兴趣的话题收进选题库，安排创作日历 |
| 内容库 | 按项目整理产物，预览图片、音视频和文本，下载后继续使用 |
| 内容分析 | 查看已采集或导入的作品数据，寻找问题和下一步改进方向 |
| Agent 工作室 | 观察任务、成员状态和工具记录，探索角色形象与不同岗位的工位体验 |
| 账号与画像 | 管理平台连接、创作定位、受众和风格，让创作有自己的上下文 |

图片生成和 AI 对话需要配置自己的模型服务。平台数据与发布能力取决于实际登录状态、接口可用性和相应权限。工作室中的演示数据与后台记录分别标注。

## 这份定制版本在改什么

- **操作更简单**：常用动作直接可见，专业参数按需展开，减少第一次使用时要理解的概念。
- **图片更重要**：围绕当前图片、修改描述和结果继续创作。
- **分析更容易看懂**：先说明发现和下一步，再查看作品表格、指标和依据。
- **工作室更有辨识度**：持续改进角色建模、工作动作、岗位工位和角色编辑。美术样板与真实任务执行分别验收。
- **本地体验更可靠**：改进草稿保留、历史备份、异常反馈、资源加载及 Windows 安装流程。

这些是本仓库的迭代重点，具体完成范围见[开发记录](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/secondary-development-progress.md)。不把演示画面当作真实模型执行，也不把可打开的页面当作所有功能均已验证。

## 从源码开始

获取定制版本：

```bash
git clone --branch codex/creator-workflow https://github.com/StarrySea1412/Easel.git
cd Easel
```

Windows 10/11：先准备 Git、Python 3.10+、Node.js 24.16+（24.x）和 FFmpeg，并加入 PATH，然后在 PowerShell 中运行：

```powershell
.\setup.ps1 -NonInteractive
.\.venv\Scripts\easel.exe web --port 7860
```

macOS / Linux：

```bash
bash setup.sh
source .venv/bin/activate
easel web --port 7860
```

打开终端显示的本地地址，在「设置」连接所需的模型服务。首次安装需要联网；Windows 安装、依赖与恢复步骤见[安装说明](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/windows-installer.md)。

## 开发者入口

前端使用 React、TypeScript、Vite 和 Three.js，位于 `web/frontend/`；后端使用 Python / FastAPI，入口为 `web/app.py`；命令行工具位于 `easel/`。

- [开发分支 README](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/README.md)
- [迭代计划](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/secondary-development-plan.md)
- [技能与功能映射](https://github.com/StarrySea1412/Easel/blob/codex/creator-workflow/docs/skill-function-mapping.md)
- [原项目](https://github.com/ZJU-REAL/Easel)

## 来源、致谢与许可证

本项目由 [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel) 二次开发而来。感谢原作者、贡献者以及 OpenClaw 和其他开源依赖的维护者。原项目的贡献与历史保留，原有致谢见 [ACKNOWLEDGMENTS](docs/ACKNOWLEDGMENTS.md)。本仓库的新改动由本仓库维护，不代表原作者或原机构的官方产品与承诺。

沿用 [Apache License 2.0](LICENSE)。第三方组件、素材和技能遵循各自的许可证与归属说明。
