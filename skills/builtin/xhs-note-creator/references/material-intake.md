# 素材驱动流程与卡片合成策略

当用户提供了已有素材(文字 / 图片 / 视频 / 音频)，笔记的写法要从"找参考 → 写原稿 → 拆卡"切换到"清点素材 → 从素材里提炼观点 → 反推卡片/分镜"。本文档给出素材处理流程、专用生图与取得图片后的局部合成方式。

制作小红书卡组、封面或配图时必须调用专用生图工具，保留已授权数量/费用。用户素材是商品与主体的事实参考，共用referenceId走图生图；素材处理和文字叠加不能替代生图。缺配置或失败明确未完成，不使用HTML截图兜底。

## 一、素材清点流程

### 1. 跑脚本生成 `materials.json`

```bash
python3 skills/builtin/xhs-note-creator/scripts/analyze_material.py input.jpg \
  --out <work-dir>/reference/materials.json \
  --frames-dir <work-dir>/reference/frames \
  --frames-per-video 6
```

脚本做确定性的事：

- 按扩展名分类 `text / image / video / audio / unknown`
- 图片：读 `width / height / aspect`
- 视频：读 `duration_sec`、抽 N 帧存到 `frames-dir/`
- 文本：截取前 400 字预览
- 输出 `{ "materials": [...] }`，每条含空字段 `caption`、`usage`、`strategy`

### 2. AI 用多模态能力补全

打开 `materials.json`，对每条 image 和每个 video 的抽帧：

- 用 Read 工具**目视**查看
- 填 `caption`：10-40 字客观描述画面，不加情绪词
- 填 `usage`：这张图打算用在哪(`cover` / `content-3` / `ending` / `reference-only` / `discard`)
- 填 `strategy`：见本文第二节

视频类素材的判断基于抽帧；如果抽帧不足以判断，跑 `ffmpeg` 加密抽帧或让用户补充。

### 3. 从素材反推观点

素材清点完后，再写长文原稿。**不要先写原稿再硬塞素材**——那会退化成纯文字帖 + 配图。正确顺序：

1. 素材里最强的 1-2 张/段 → 决定 `cover` 钩子
2. 其余素材按 `usage` 串成叙事线 → 决定 content 卡顺序
3. 缺口（没有素材支撑的论点）→ 不编造事实；必要时收窄论点或补充核实。视觉场景可用专用生图制作，但生成示意不作事实证据。

## 二、先生成图片，再按需局部合成

每张卡片在 `meta.json.cards[i].synthesis_strategy` 记录 `ai_generated` 或 `ai_generated_composite`，保留原始生图jobId与图片路径。旧 `html_card` 只可识别为历史渲染来源，不能用于新卡组的出图计划或完成证明。

### 必经步骤：专用AI生图

三图优先使用 `easel_xhs_cards`，同一referenceId保持商品主体；否则使用 `easel_generate_image` 或 [ai-image-gen](../../ai-image-gen/SKILL.md)。必须取得成功回执和真实图片后才进入以下局部合成。没有真实照片、中文较多、知识卡用途或风格要求都不能作为跳过生图的理由。

### 可选后期：文字叠加

**适用**：已取得真实生成图片，需要准确叠加一句短标题；记录 `ai_generated_composite`。不得只在原照片上叠字便宣称本轮生图完成。

**做法**：

```bash
python3 skills/builtin/xhs-note-creator/scripts/text_on_image.py input.jpg output.jpg \
  --text "一句钩子" \
  --position top \
  --fit 3x4 \
  --size 72 \
  --color "#FFFFFF" \
  --bg "#000000AA"
```

注意：

- `--position` = `top / center / bottom`；cover 推荐 top 或 center
- 文字长度 ≤18 字，更长先拆成两行(脚本已支持换行符 `\n`)
- 照片有水印先走 `crop_watermark.py`
- 字体优先使用本 SKILL 的 assets/fonts 下用户另行提供的 CJK 字体，也会尝试系统字体；该字体目录不是必备仓库资源，可用 `--font <字体绝对路径>` 显式指定。缺字体脚本会警告并用 PIL 默认字体(不推荐上线)

### 可选后期：局部拼贴

**适用**：已取得真实生成图片后，组合经过核实的细节素材；保留生成来源并记录 `ai_generated_composite`。不以纯素材拼贴替代专用生图。

**做法**：

```bash
python3 skills/builtin/xhs-note-creator/scripts/collage_3x4.py output.jpg \
  --layout 2v --inputs a.jpg b.jpg \
  --gap 12 --bg "#FFFFFF" --size 900x1200
```

布局选择：

| layout | 素材数 | 排列 | 常用场景 |
|---|---|---|---|
| `2v` | 2 | 上下 | 对比 before/after |
| `2h` | 2 | 左右 | 窄图配对(慎用) |
| `3` | 3 | 大图在上 + 两小图 | 主图 + 细节 |
| `4` | 4 | 2×2 | 步骤 / 多角度 |

拼贴出来的卡若还要叠一句标题，再串一次 `text_on_image.py`。

> 上述脚本只处理已经取得的真实生成图片，不是替代生图的出图路线；精确文字与数字可局部修正，不能先写HTML截图冒充卡组。

## 三、图文 vs 视频的分流判断

Step 0 问完后按如下判断：

- 用户明确说"视频" / "短视频" / "reels" → 走 5B(视频帖)
- 用户素材里 ≥1 段可用视频(> 5 秒) → 默认建议 5B，但由用户拍板
- 其余情况 → 走 5A(图文帖)

视频帖仍然需要一张 `cover` 卡(3:4)作封面，合成策略同上。

## 四、materials.json 示例

```json
{
  "materials": [
    {
      "id": "m001",
      "path": "reference/photos/spring_01.jpg",
      "kind": "image",
      "size_bytes": 2458912,
      "width": 4032, "height": 3024, "aspect": 1.333,
      "caption": "阳光下的樱花树近景，粉白色花瓣",
      "usage": "cover",
      "strategy": "reference-only"
    },
    {
      "id": "m002",
      "path": "reference/videos/hike.mp4",
      "kind": "video",
      "duration_sec": 42.5,
      "width": 1080, "height": 1920,
      "frames": [
        "reference/frames/hike_f01.jpg",
        "reference/frames/hike_f02.jpg"
      ],
      "caption": "登山小径，从山脚视角仰拍山顶",
      "usage": "content-2",
      "strategy": "use_original"
    }
  ]
}
```

注：视频素材如果要原样用在视频帖分镜里，`strategy` 填 `use_original`；在图文帖里只作为 `reference-only`；最终卡组仍须专用生图，随后才可局部叠字。
