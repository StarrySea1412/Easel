---
name: xhs-note-creator
description: >
  小红书内容总入口：生成标题、正文、caption、hashtags，以及 默认 3 张图文卡片或短视频分镜，覆盖素材分析、卖点评估、去 AI 味和质检。
  当用户说“写/做小红书笔记、小红书图文/种草/文案、出一套卡片、小红书视频”时使用。
  整套笔记用本 SKILL；仅渲染卡片用 card-xiaohongshu；其他平台的通用文案用 social-content。
layer: produce
---

# 小红书笔记创作

把一个主题 + 可选素材，生成**图文卡片组**或**短视频分镜脚本**，按规范输出到 `outputs/`。

## 核心理念

小红书读者看的不是长文，是**卡片组**或**短视频**。长文原稿只是中间产物。

- **图文帖**：默认 3 张 3:4 竖版卡片（cover + content × N + ending），每张 ≤80 字
- **视频帖**：15-90 秒竖屏视频分镜 + 封面卡

### 爆款 5 大原则

1. **尊重出图要求**：未指定AI生图时可优先真实素材、截图和对比图；明确要求AI生图时按要求执行，不用素材或HTML替换。
2. **聚焦核心卖点**：用公式判断优先级（稀缺性 × 实用性 × 可感知）
3. **高级感视觉**：需要确定性卡片排版时使用 [card-design](../card-design/SKILL.md) 设计系统（选风格锁 spec、字大字细、填满画幅、禁大 emoji 廉价感）。用户要求AI生成图片时把审美要求用于生图提示词，不强制改为HTML。文案保持口语化和真实感。
4. **痛点导向**："能解决什么问题" > 堆砌功能列表
5. **先自检再交付**：发现缺图、乱码、主体失真或虚构事实先明确问题并处理，不把低质量初稿直接作为成品；用户反馈用于审美迭代。

详细方法论：`references/xiaohongshu-viral-methodology.md`


### 三图与质量交付协议（优先于下方通用流程）

制作图文三图时先读 [三图制作与审图](references/three-card-production.md)。它规定事实清单、共用视觉设定、逐图镜头和手机预览；避免三个独立海报拼起来、长文直接塞图和审图结果空泛。

- 默认且本轮明确要求恰好3张：①封面一句具体钩子+主体，②核心卖点/细节证据，③使用场景+自然行动引导。每图一个重点，避免三张重复口号；不堆满80字，手机上优先清晰短句。
- 明确统一主体描述、商品形状/颜色/数量、配色、光线、字体层级和安全边距。事实只用已有可核实信息，不编造价格、材质、认证、体验或销量；商品精确还原需真实参考，不将生成示意称实拍。
- 有 `easel_xhs_cards` 时用 `action=submit`，提供固定 `requestId`、统一 `style` 和依次对应封面/卖点/收尾的三个不同 `prompts`。有产品实拍时先用现有image_inputs参考图入口登记，三张传同一referenceId走图生图，以参考外观为准；不能拿文字想象替代商品还原。工具以3:4分别排队，禁止只用一个prompt的三种变体代替分镜。复查用同requestId的 `status`，排队不换标识、不反复调用生成。
- 工具回执queued不等于完成；后台逐张预览。登记后等待队列完成，用同requestId的status查看，不能以“已登记”结束成品任务。三张保存后使用图像读取工具逐张实际查看（不能只看文件名或提示词），检查：中文清楚无乱码/拼写错，主体和色彩一致，三张内容有递进差异，构图完整无裁切，手机尺寸文字可读，卖点真实。
- 只有全部通过才调用同requestId的 `review`：按顺序提交每张当前 `sha256`、具体看到的画面/文案与审图依据 `evidence`，以及 `readableText/consistentSubject/consistentStyle/distinctContent/truthfulClaims/safeMargins=true`。不会看图、任一项不通过或少图时保持“待质量验收”，明确问题；不能编写全true凑通过。修图/重生可能另收费，失败不自动改requestId重生。
- 文件门还会核对真实可读图片、至少720×960、3:4画幅、当前会话交付和像素去重；该门只保证文件要求，不能证明审美和文案质量。显示“助手审图通过”也不等于用户最终验收。
- 没有该工具时按专用图片流程做恰好3张，逐图审看后交付，准确说明来源及验收边界；不得以HTML、重复图片或占位图冒充AI生图。用户明确限定排版/真实素材时仍尊重要求，但也要交付3个可读取的独立图片文件。
- 最终交付三张预览/下载、caption与标签，并说明实际审图结果；准备发布和实际发布继续分别授权。

## 工作流

按顺序执行，**不要跳步**。

### Step 0 — Intake（先用已有上下文，仅缺关键事实时询问）

1. **主题 / 目标读者 / 核心观点**
2. **输出形态**：图文 or 视频？（默认图文）
3. **素材**：有无现成文字/图片/视频？
4. **风格**：优先已有品牌、参考图和用户偏好；缺省按主题选一个合适方案并说明，不强制列选项等用户确认。用户主动要求选择或视觉方向互相矛盾时再询问。三张共用主体、配色和字体层级，分镜构图不同。
5. **卡片数量 / 视频时长**：图文默认固定 3 张；只有用户明确另指定数量才调整；视频默认 30-60 秒

### Step 0.5 — 卖点/亮点分析（推广/分享/测评类必做）

1. 列出所有功能/特性/亮点
2. 根据已知事实内部评估，不要求用户逐项打分；存在关键事实缺口再询问：
   - 稀缺性（1-5）：别人有吗？
   - 实用性（1-5）：解决多大问题？
   - 可感知（1-5）：用户能直接看到吗？
3. 得分 = 稀缺性 × 实用性 × 可感知
4. 选 Top 1-2 作为核心卖点

### Step 1 — 素材清点（有素材才做）

如果用户提供了素材，先用脚本生成清单：

```bash
python3 skills/builtin/xhs-note-creator/scripts/analyze_material.py <path>... \
  --out <work-dir>/reference/materials.json \
  --frames-dir <work-dir>/reference/frames
```

素材价值排序：对比图 > 功能演示 > 数据图表 > 品牌素材

### Step 2 — 采集外部参考（观点类/资讯类必做）

按 `references/reference-search.md` 执行，核心数据 ≥2 个来源交叉验证。

### Step 3 — 写卡片文案；长文按需

直接制作卡组时先写三张分镜与100–300字caption，有足够上下文就继续出图。用户要求深度稿时可写2000–4000字原稿；只有用户要求分阶段确认或存在实质歧义才停下确认。

### Step 4 — 去 AI 化（强制）

去 AI 感规则统一走 text-polisher 权威源，不在本 SKILL 维护副本：

- 中文规则（含小红书素人感/闺蜜语气/emoji 节奏特化）→ `../text-polisher/references/zh-ai-markers.md`
- 通用填充短语 → `../text-polisher/references/phrases-to-remove.md`
- 公式化结构 → `../text-polisher/references/structures-to-avoid.md`

按其五层原则完整扫描重写，质量评分满分 50。

### Step 5 — 分发：图文 or 视频

#### 5A. 图文帖：拆成 默认 3 张卡片

- cover（第 1 张）+ content（中间）+ ending（最后 1 张）
- 每张 ≤80 字
- 一张卡只讲一个论点
- 全套配色/字体/风格保持一致（由 card-design 选中的那一套贯穿整组）

**先尊重本轮出图要求**：制作卡组、封面、配图等图片成品时，在本轮数量和费用授权内主动调用easel_generate_image或ai-image-gen，不必等用户补说“AI”；不能只交提示词。明确限定纯文字/参数排版或真实素材时遵从约束。AI图片先取得实际产物，必要时再精确排版；缺配置或失败如实反馈，不静默换成HTML截图。以下html_card只用于明确的排版需求或图片取得后的文字合成。

**文字卡片排版走 card-design 管线。** 按有无真实照片选择渲染路径（策略写入 `meta.json`，枚举与 `references/meta-schema.md` 一致）：

| 策略 | 适用 | 渲染路径 |
|------|------|----------|
| `html_card` | 未指定AI生图的纯文字卡 / 知识卡 / 数据卡 | **走 [card-xiaohongshu](../card-xiaohongshu/SKILL.md)**：读 [card-design](../card-design/SKILL.md) 选风格锁 spec → 写 HTML → `render_card.py` 出图 → `card_audit.py` 硬门禁 |
| `text_on_photo` | 有真实照片 + 钩子文字（真实素材最佳） | Pillow `scripts/text_on_image.py`（小红书真实素材路径，保留） |
| `collage` | 有 2-4 张互补照片 | Pillow `scripts/collage_3x4.py` |

> 图片成品任务先按card-xiaohongshu的出图路由执行，不能因“知识卡”用途直接跳到HTML。明确的文字/数据排版可渲染；真实照片卡按需使用Pillow，所有路径均交付图片文件并准确说明来源。

#### 5B. 视频帖：写分镜脚本

- 6-12 个分镜，每镜 2-8 秒
- 每镜含：narration（≤30 字）、on_screen_text（≤15 字）、visual、material_ref
- 出一张 cover 卡作为封面

### Step 6 — caption + hashtags + 标题

**标题**：从公共源 `skills/shared/references/hook-title-formulas.md` 选标题公式（痛点+方案 / 提问式 / 发现式 / 热点词 / 身份共鸣等），产 2-3 个备选。

**caption**：100-300 字，hook 开头 → 关键信息 → CTA，闺蜜语气 + 少量 emoji（点缀节奏，不当图标）

**hashtags**：5-8 个，4 核心（热点词 + 核心功能 + 差异化 + 目标人群）+ 4 辅助（场景 + 品类）

### Step 7 — 落盘

```
outputs/主题名/{YYYY-MM-DD}/{短标题}_{时间戳}/
├── {完整标题}.md        # 长文原稿
├── meta.json            # 元数据（卡片/分镜/caption/hashtags）
├── images/              # 最终卡图 / 封面
└── reference/           # materials.json / 搜索结果
```

目录名走脚本标准化：`python3 skills/builtin/xhs-note-creator/scripts/normalize_slug.py "标题" --with-ts`

> **审图顺序：** 自行渲染或保存的图片必须先easel_present登记到当前会话，再view_image审图；登记仅代表预览和归属，不代表质量通过。遇到EASEL_IMAGE_NOT_DELIVERED先登记现有文件，不能原样重复读取或重新生图；识图服务超时与文件归属错误分开，未经实际看图不得说审核通过。

### Step 8 — 校验（强制，两道门）

**① 文本/结构门**（标题/caption/hashtag/卡片字数与结构）：

```bash
python3 skills/builtin/xhs-note-creator/scripts/validate_meta.py outputs/主题名/meta.json
```

**② 视觉门**（仅 `html_card` 路径，渲染后跑；死空白/密度硬门禁）：

```bash
python skills/builtin/card-design/scripts/card_audit.py audit -f "outputs/主题名/card_*.png"
```

任一非 0 退出 → 修改后重跑，直到通过。不交付未校验的产物。

## 不要做的事

- 不写 H1；标题只放 `meta.json.title`
- 不在正文末尾写参考来源
- 不在 `.md` 里留 `【插入图片】` 占位符
- 不跳过 Step 4（去 AI 化）和 Step 8（validate）
- 不手算目录名，一律走 `normalize_slug.py`

## Profile 感知

- **有 Profile**：读取赛道、目标受众、内容风格，对齐笔记语气和标签策略
- **无 Profile**：结合已有主题选择合适风格并说明，缺必要事实才询问

## 工具依赖

- Python 3.8+、Pillow（必需，真实照片卡路径）
- playwright + chromium（`html_card` 路径渲染卡片，走 card-xiaohongshu；首次 `pip install playwright && playwright install chromium`）

## 参考资料

- **卡片视觉** → [card-design](../card-design/SKILL.md)（设计系统/风格库，出图前必读）+ [card-xiaohongshu](../card-xiaohongshu/SKILL.md)（HTML→截图渲染管线）
- `references/xiaohongshu-viral-methodology.md` — 文案/卖点/标题/情绪方法论（视觉部分已交 card-design）
- 去 AI 化 → `../text-polisher/references/zh-ai-markers.md`（权威源，含小红书特化）
- 钩子/标题公式 → `skills/shared/references/hook-title-formulas.md`（公共源）
- `references/material-intake.md` — 素材处理流程
- `references/image-sourcing.md` — 图片来源处理
- `references/meta-schema.md` — 元数据字段定义
- `references/output-spec.md` — 输出目录规范
