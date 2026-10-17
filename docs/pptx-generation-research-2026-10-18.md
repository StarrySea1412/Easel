# 生成 PPT 的调研与方案（2026-10-18）

> 用户原话：“调研一下，，我们这个调用生成PPT，应该怎么办”。
> 前置：2026-10-17 已核查过“能否直接生成 word/ppt/Excel 并预览”（见 `docs/user-requirements-2026-10-08.md`）——产物登记与聊天气泡图片内嵌已具备，**Office 生成器与预览链路列为待实现（用户确认后排期）**；本轮的“生成 PPT”即该项的第一块。
> 调研方式：本机只读核查（依赖、技能、渲染管线）＋ ClawHub 公开检索 ＋ 参考实现阅读（ZCode 官方演示插件）。不改动任何本机应用。

## 1. 现状核查（本机）

| 项 | 状态 |
| --- | --- |
| 产物登记与对话内嵌 | ✅ 已有：ArtifactStore/`easel_present` 把真实文件登记进原对话；聊天气泡支持图片内嵌 |
| Office 文件识别 | ✅ 内容库与上传/媒体接口已识别 Word/PPT/Excel 类型 |
| **Office 生成器** | ❌ 无（本轮要补的） |
| 技能机制 | ✅ `skills/openclaw/*`（40+ 个）+ `skills/shared/scripts/*.py`；技能=SKILL.md＋脚本，Agent 正常写脚本→运行→登记产物 |
| HTML→PDF/PNG 渲染管线 | ✅ 已有：`skills/shared/scripts/doc_convert.py` 用 **Playwright + headless Chromium**（打印 PDF、页面截图）；venv 内 playwright 可用、ms-playwright 里 Chromium 已安装 |
| Node/npm | ✅ 可用（`C:\Program Files\nodejs`） |
| pandoc / LibreOffice(soffice) / pdftoppm(poppler) | ❌ 都没有 |
| python-pptx | ❌ 未安装（需新增这一条轻依赖） |
| ClawHub 公开技能 | ✅ 可检索到多个演示类技能：`pptx`（“PPTX · HTML 演示与可编辑文字导出”）、`md-to-slides`（Markdown To Ppt）、`claw-presentation-creator`、`minimax-ppt-slides`、`presentation` 等——可作为“安装即用”的备选路径 |

## 2. 参考实现

- **ZCode 官方 `presentations` 插件 → `pptx` 技能（Z.AI，v1.1）**：生产级做法——生成用 **pptxgenjs / python-pptx**；读旧稿用 markitdown；**转 PDF 用 LibreOffice、逐页 PNG 用 pdftoppm**；SKILL.md 内含一套设计规范（配色/版式/避免“AI 味”要点）。**许可证 Proprietary：架构可参考，内容不可照搬**（我们自研精简版文案）。
- **ClawHub 公开技能**：现成的社区实现，但依赖、许可证与维护不可控，适合作为“可安装”而不是“默认内置”。
- 我们自己的先例：`doc-convert`（Markdown→HTML/PDF/PNG）已证明 **Chromium 预览管线在本机可用**；`video-production` 有随技能 vendor 第三方 SDK 的先例（我们不采用重 vendor，见推荐）。

## 3. 方案矩阵

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A · 内置自研 `pptx-slides` 技能（推荐）** | 新技能＋`skills/shared/scripts/pptx_build.py`：**Markdown 大纲 → deck.pptx（python-pptx，内置主题常量）＋ deck.html → slide-N.png / deck.pdf（复用 doc-convert 的 Chromium 管线）**；产物按现有 ArtifactStore 登记，聊天内看缩略图、点开下载 pptx | 全本机、零付费、离线可跑；生成与预览同一份大纲；依赖最轻（只新增 python-pptx）；与我们脚本化技能体系一致 | 需要写自研生成脚本（一次成本）；模板/动画只做基础版 |
| B · 采用 ClawHub 公开技能 | 从技能库/ClawHub 安装现成演示技能 | 上手快、生态复用 | 第三方依赖与许可证不可控；预览与产物登记要另做适配；离线仓库不可控 |
| C · MCP 形态（pptx MCP 服务） | 把生成/转换做成 stdio MCP（同 conversation-share MCP 思路） | 跨 harness（ZCode/Claude 等）可复用 | 用户需安装 MCP；Easel 内部技能已覆盖本机调用，暂不必要 |
| D · 维持现状 | Agent 自写文件，无格式校验、无预览 | 零成本 | 不满足“调用生成 PPT”的一等体验，质量与可预览性都不可控 |

## 4. 推荐架构（方案 A：单一大纲，双产物）

```
Markdown 大纲（# 标题 / ## 每页 / - 要点 / 备注）
   └─ scripts/pptx_build.py
        ├─ deck.pptx      ← python-pptx（主题：深色封面 + 浅色内容页；配色常量；CJK 用主题字体名，pptx 只存文本不渲染）
        ├─ deck.html      ← 同一份规格渲染成整页幻灯片 HTML
        └─ slide-NN.png / deck.pdf ← 复用 doc-convert 的 Playwright+Chromium 打印与截图（CJK 由 Chromium 保证）
输出目录 outputs/<主题>/，随后由 Agent 按现有机制用 ArtifactStore 登记（pptx 可下载，PNG/PDF 直接在气泡与产物卡预览）
```

- **调用方式**：新增技能 `skills/openclaw/pptx-slides/SKILL.md`（自研文案，触发词：PPT／幻灯片／演示文稿／汇报材料），内含精简设计规范（配色三色、每页一个视觉焦点、避免“AI 味”条纹）与脚本用法；Agent 生成大纲 → 跑脚本 → 登记产物。用户输入一句“做一份关于 X 的 8 页 PPT”即可。
- **依赖**：仅新增 `python-pptx`（纯 Python 轻量包）；渲染复用已安装的 Playwright/Chromium；不引入 LibreOffice/pandoc/poppler（本机没有，也非必需）。
- **览预览边界**：我们走“从大纲到预览”的正向管线，不做 **pptx→PNG 的反向渲染**（那需要 LibreOffice）；已有 pptx 文件的预览后续按同一思路评估。

## 5. MVP 验收草案

1. `pptx_build.py -i 大纲.md -o outputs/<主题>/` 一条命令产出：`deck.pptx`（可被 python-pptx 读回校验：页数、每页标题与要点文本齐全）、`deck.html`、`slide-NN.png`（每页一张）与 `deck.pdf`。
2. 技能 SKILL.md：触发词、输入输出、用法示例、设计规范精简版、失败路径（缺依赖时给出安装指引，不裸错）。
3. 聊天侧：产物登记后气泡可预览 PNG/PDF、可下载 pptx（走现有 ArtifactStore/预览机制，不改前端协议）。
4. 测试：pytest 校验生成器（页数/文本/尺寸/异常输入）；预览渲染在无 Chromium 的 CI 场景下可跳过（显式标注），本机全量跑通。
5. 边界：离线与零付费模型（生成与渲染都在本机）；不调用任何模型服务。

**不做（MVP）**：模板市场与主题编辑器；切换动画/转场；PPT 内嵌视频/复杂图表（先支持要点、两栏、大数字、引用页）；从现有 pptx 反向编辑与预览（需要 LibreOffice，另评）。

## 6. 下一步（待一句“开做”即实施）

1. `pip install python-pptx`（记入技能的依赖声明）。
2. 写 `skills/shared/scripts/pptx_build.py`（主题常量、大纲解析、pptx 生成、HTML 渲染、Chromium 出 PNG/PDF）。
3. 写 `skills/openclaw/pptx-slides/SKILL.md`（自研设计规范，不含 ZCode Proprietary 文本）。
4. pytest 用例 + 本机端到端（大纲→pptx→预览）验收；文档与 Git 同步。
