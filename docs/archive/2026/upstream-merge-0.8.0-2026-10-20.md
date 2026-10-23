# 上游 main 合并回执（0.8.0，2026-10-20）

> 本轮按用户指令执行 `docs/upstream-merge-plan-2026-10-20.md` 的整批合并。只改源码、文档与构建，不动 138、不发布安装器。

## 引用

| 引用 | SHA |
| --- | --- |
| 合并前基线（0.7.6） | `3c5ef721` |
| 上游 `origin/main`（v0.3.0） | `8d08b216` |
| 共同祖先 | `3fe2d99`（v0.2.1） |
| 回滚标签 | `backup/pre-upstream-2026-10-20` |
| 合并分支 | `codex/upstream-merge-0.8.0` |

`git merge --no-ff origin/main`，保留祖先关系；启动时 `git merge-tree` 预演为 57 个冲突文件，实际合并结果一致。

## 冲突处理原则

- 本分支的产品行为优先：设计系统与拆分样式、对话进度胶囊/子 agent/实时浏览器/问答卡片、账号状态机、供应商流程、Windows 启动器、发布回执。
- 吸收上游缺陷修复：聊天锁/快照状态机、登录墙识别、发布草稿去重、doctor 循环保护、发布生命周期、文档路径校验。
- 高风险文件逐 hunk 合并，未整文件取一侧：`web/app.py`、`SettingsPanel.tsx`、`ChatPage.tsx`、`styles/index.css`。
- 新子系统（`easel/harnesses/*`、`easel/direct_api.py`、`easel/local_agents.py`、`easel/manual_publish.py`、`ManualPublishPage.tsx`、`HarnessSettings.tsx`、`ArtifactGallery.tsx`）随代码进入，但未接导航/默认入口。人工发布策略通过 `EASEL_PUBLISH_MODE` 生效，默认 `automated` 保持原行为。
- 上游安装器 nightly CI / PSScriptAnalyzer 未采用；`agents/sync.sh` 采用上游版本但不自动执行。

## 合并期修正

- `_model_channels()` 补回上游 body 依赖的 `direct` 判定，恢复 OpenAI/Responses 直连模式路径。
- `_sync_openclaw_chat()` 补回 `old_model`（模型名迁移判断）。
- 技能目录切换到上游 `skills/builtin/`，同时保留 `skills/openclaw/` 兼容；`get_skills`、`_skill_md_path`、clawhub 导入与上下文统计按两处扫描去重。
- 技能脚本保留本分支的登录反馈、审核后只读核实、发布回执与统计口径，同时吸收上游 QR 抓取、登录墙、草稿去重、并发锁。

## 新能力开关

| 能力 | 状态 |
| --- | --- |
| 上游聊天锁/快照修复 | 已生效 |
| 登录墙与发布去重 | 已生效 |
| 人工审核发布 | 代码与 API 在位，默认 `automated`，不改变现有流程 |
| 多 harness / 直连 API / 本机 agent | 代码在位，未接入导航 |
| ArtifactGallery / ThemeToggle | 文件在位，未接线 |

## 验证

- 前端：`tsc -b --noEmit`、`vite build` 通过；定向测试（模型菜单、设置/导入、模型选择）通过。
- 后端：`tests/test_model_import.py` 53 项、`test_model_health.py` 30 项、`test_chat_model_selection.py`/`test_office_controls.py`/`test_office_model_guidance.py` 81 项通过。
- 2026-10-21完整复跑：合并前前端1232/1232、合并后1252/1252通过；构建与lint通过。后端基线3151通过/8失败/9error/4跳过，合并后3901通过/236失败/54error/82跳过，尚未满足A=0。完整清单及当前分诊见[本机验证与待办](local-acceptance-0.8.1-2026-10-21.md)，不把上游存在当成已验收。
- 未做真实模型推理、真实平台发布、手机扫码；138 未部署。

## 回滚

在合并分支执行 `git reset --hard backup/pre-upstream-2026-10-20`；不 force push。`starry/main` 未改动。
