# 贡献指南

感谢参与 [StarrySea1412/Easel](https://github.com/StarrySea1412/Easel)。这是我们基于 [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel) 维护的二次开发仓库，沿用 Apache-2.0 许可证；第三方来源见 [ACKNOWLEDGMENTS](docs/ACKNOWLEDGMENTS.md)。

当前定制功能在 [`codex/creator-workflow`](https://github.com/StarrySea1412/Easel/tree/codex/creator-workflow) 分支。`main` 的代码仍是上游基线；开发、验证和提交本版本的改动时，请使用 `codex/creator-workflow`，并将 PR 的目标分支设为该分支。

```bash
git clone --branch codex/creator-workflow https://github.com/StarrySea1412/Easel.git
cd Easel
```

## 反馈 Issue

- 在本仓库的 [Issues](https://github.com/StarrySea1412/Easel/issues) 反馈问题；提交改动见 [Pull requests](https://github.com/StarrySea1412/Easel/pulls)。
- **环境问题**：附上 OS、Python、Node.js、`openclaw --version` 版本、`easel doctor` 输出和 `easel gateway logs` 相关片段。先查 [已知问题](docs/known-issues.md)。
- **功能建议 / 新技能**：先开 Issue 说明场景与预期产物，确认方向后再动手，避免大改撞车。

## 提交前必跑

```bash
python scripts/validate_skills.py            # SKILL frontmatter、目录结构、发布契约
python scripts/validate_skill_commands.py    # 文档中的 python 命令与脚本真实 argparse 对齐
python -m pytest -q                          # 根目录全量，包含 skills 内的测试
```

前端有改动时，在 `web/frontend` 运行 `npm test`、`npm run lint` 和 `npm run build`。交付时同步项目说明与进度，提交并推送本仓库后核对远端 SHA；首页介绍需与开发分支的实际功能和安装包边界一致。

## Skill 约定

- 遵循 [SKILL 接口规范](docs/SKILL-SPEC.md)：frontmatter 含 `name / description / layer`，SKILL.md 精简（< 200 行），领域知识进 `references/`，可执行脚本进 `scripts/`。
- 产物统一写入 `outputs/<项目>/`，路径经 `skills/shared/scripts/output_paths.py` 校验；不要在技能里散落写其他目录。
- 发布类技能保持门禁语义：先预览与发布前检查，真实发布由用户确认后执行。
- 技能内的账号画像只从 `profiles/<画像>/` 读取，不写全局 `MEMORY.md`（见 [提示词分层](docs/prompt-stack.md)）。

## 代码约定

- Python ≥ 3.10；Web 为 FastAPI + React（`web/`），CLI 入口在 `easel/`。
- 超时只改 [`easel/timeouts.py`](easel/timeouts.py) 单一真相源，不要在调用处各写各的。
- OpenClaw 的缺陷跟随上游修复，不在本仓库内置补丁；环境问题沉淀到 `easel doctor` 或 [known-issues](docs/known-issues.md)。
- 凭证不进仓库：`.env` 不入库；测试不得调用真实模型、真实平台或外部消息渠道。

## PR 约定

- 一个 PR 只做一件事；标题用 `feat: / fix: / docs: / chore: / polish:` 前缀。
- 描述里写清动机与验证方式；涉及技能行为改动时附上触发示例。
- 第三方素材或技能引入需在 [ACKNOWLEDGMENTS](docs/ACKNOWLEDGMENTS.md) 登记来源与许可。
