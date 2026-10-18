# Easel SKILL 元数据

| 字段 | 值 |
|------|-----|
| **SKILL 名称** | pptx-slides |
| **所属层** | produce |
| **来源类型** | 自研 |
| **原始来源** | Easel 自研（2026-10-18，依据 `docs/pptx-generation-research-2026-10-18.md` 方案 A） |
| **参考项目** | ZCode 官方 presentations/pptx 技能（架构参考：大纲→生成→预览分层；许可证 Proprietary，文案与代码均为 Easel 自研，未照搬） |
| **许可** | 随 Easel 项目许可 |

## 脚本

| 脚本 | 说明 | 依赖 | 自研 |
|------|------|------|------|
| `skills/shared/scripts/pptx_build.py` | Markdown 大纲 → `deck.pptx`（python-pptx，深色封面+浅色内容页，CJK 字体名写入 latin/ea/cs）＋ `deck.html`（16:9 整页幻灯）＋ `slide-NN.png`（逐页截图）＋ `deck.pdf`（Chromium 打印）。子命令 `build` / `selftest`；缺 playwright/Chromium 时 `--skip-render` 降级只出 pptx/html。 | python-pptx（必需）；playwright + chromium（PNG/PDF，可降级跳过） | 是 |

## 变更记录

- 2026-10-18 **首版**：新增本技能与 `pptx_build.py`。大纲格式确定性解析（`#` 封面 / `##` 页 / `-` 要点 / `###` 两栏 / `!` 大数字 / 普通段落引用 / `—` 署名 / `>` 备注）；一命令产出 pptx+html+逐页 PNG+PDF；selftest 全链路（含 pptx 读回校验）通过；pytest `tests/test_pptx_build.py` 覆盖解析/生成/异常输入，无 Chromium 时渲染用例显式跳过。不做模板市场/转场动画/pptx 反向渲染。

> 整理时间: 2026-10-18
> 用途: 来源溯源与致谢

## 致谢

PPTX 生成基于 python-pptx（开源），预览渲染复用 Playwright + headless Chromium
（与 `skills/shared/scripts/doc_convert.py` 同一管线）；大纲解析与生成脚本为 Easel 自研。
