/**
 * 爆款拆解 →《内容拆解报告》的报告契约与提示词构造（P0 纯正文版）。
 *
 * 契约来自 docs/viral-report-research-2026-10-15.md（报告骨架、深度最低标准、
 * 表现数据边界）与 docs/viral-breakdown-report-sample-2026-10-15.md（人工样稿）：
 * 默认结果 = 摘要 + 连续分析正文（定位/标题开头/结构转折/机制与替代解释/表达可信度）
 * + 创作方案 + 验证计划；每条结论写清原文依据、分析过程、可能作用、适用边界。
 * 没有表现数据时，报告只做内容拆解，不得判断“为什么火”。
 */

export const BREAKDOWN_REPORT_TITLE = '内容拆解报告';

/** 输入里只有一条链接时的如实提示（页面结果面板使用）。 */
export function isUrlOnlyInput(input: string): boolean {
  return /^https?:\/\/\S+$/i.test(input.trim());
}

/** 结果面板的材料与边界说明：页面能保证什么、缺数据时报告不做什么。 */
export function reportScopeNote(input: string): string {
  return isUrlOnlyInput(input)
    ? '你只提供了链接：报告按实际读取到的内容分析；若读取失败会说明材料不足，不会编造原文。'
    : '基于你提供的材料分析；缺少表现数据时，报告不会判断它为什么火。';
}

/** 存入选题库时的标题：取自报告首行标题；不截取链接或输入首行。 */
export function ideaTitleFromReport(result: string): string {
  for (const line of result.split('\n')) {
    const match = line.trim().match(/^#{1,2}\s+(.+)$/);
    if (match) return match[1].trim().slice(0, 60);
  }
  return BREAKDOWN_REPORT_TITLE;
}

/** 模型返回以这些前缀开头时是执行失败的通用文案（后端 run_agent_sync），不是报告。 */
export function looksLikeAgentFailure(text: string): boolean {
  return /^[\u274c\u23f1\u23f3]/.test(text.trim());
}

/** 输入面板的材料识别：只做本地文本判断，不联网、不评价内容质量。 */
export interface MaterialSummary {
  chars: number;
  paragraphs: number;
  links: number;
  shareCopy: boolean;
  kind: 'empty' | 'text' | 'link-only' | 'text-with-link';
}

const URL_PATTERN = /https?:\/\/[^\s，。、；：""''（）()【】<>]+/g;

export function summarizeMaterial(input: string): MaterialSummary {
  const text = input.trim();
  if (!text) return { chars: 0, paragraphs: 0, links: 0, shareCopy: false, kind: 'empty' };
  const links = (text.match(URL_PATTERN) || []).length;
  const withoutLinks = text.replace(URL_PATTERN, ' ').trim();
  const chars = withoutLinks.replace(/\s/g, '').length;
  const paragraphs = withoutLinks.split('\n').filter(line => line.trim()).length;
  const kind = chars === 0 ? 'link-only' : links > 0 ? 'text-with-link' : 'text';
  const shareCopy = /(复制|拷贝)[^\n]{0,12}(打开|app)/i.test(text)
    || /(打开|搜索)[^\n]{0,8}(抖音|小红书|快手)/.test(text)
    || /口令|分享给你/.test(text);
  return { chars, paragraphs, links, shareCopy, kind };
}

/** 材料识别卡文案（输入区实时展示，只说页面真正判断得出的东西）。 */
export function materialLine(summary: MaterialSummary): string {
  if (summary.kind === 'empty') return '还没有材料：粘贴正文、分享文案或作品链接，也可以导入文本文件。';
  if (summary.kind === 'link-only') return `识别到 ${summary.links} 条链接：能否读取以实际结果为准；同时粘贴正文，分析更完整。`;
  const parts = [`正文约 ${summary.chars} 字`, `${summary.paragraphs} 段`];
  if (summary.links > 0) parts.push(`含 ${summary.links} 条链接（分享文案与正文分开处理）`);
  if (summary.shareCopy) parts.push('检测到分享口令文案');
  return parts.join(' · ');
}

/** 示例素材：虚构短文，供首次试用；与用户历史材料分开标注。 */
export const EXAMPLE_MATERIAL = [
  '桌面越收越乱？我把桌子划成三个区，七天后不用每天大整理',
  '',
  '以前每到周日，我都会把桌子收得很空。可到了周三，充电线、杯子和没处理完的纸又堆回来了。这次我没再买收纳盒，而是先换了一个办法。',
  '',
  '我发现，自己总为了好看把东西塞进抽屉，第二天又全部翻出来。问题不是我不够勤快，是每样东西都没有固定的回家路线。',
  '',
  '第一个是工作区，只放今天正在用的东西；第二个是常驻区，给每天都会拿的东西留固定位置；第三个是空白区，收工时看它有没有重新空出来。',
  '',
  '试了一周，我不再每天把整张桌子翻一遍。整理不是让桌面一直像照片，而是明天不用重新找东西。',
].join('\n');

/** 文本文件导入的准入检查，返回 null 表示可以读取。 */
export function textFileProblem(file: { name: string; size: number }): string | null {
  if (!/\.(txt|md|markdown|srt)$/i.test(file.name.trim())) {
    return '目前只支持 .txt / .md / .srt 文本文件；图片、PDF 等后续版本支持。';
  }
  if (file.size > 512 * 1024) return '文件超过 512KB：请截取主要内容后粘贴，或换更小的文件。';
  return null;
}

/** 读取文本文件内容（仅本地读取文字，不上传服务器）。 */
export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('文件读取失败，请改为直接粘贴内容。'));
    reader.readAsText(file);
  });
}

/**
 * 构造《内容拆解报告》的一次性生成提示。
 * persona 只影响第 7 章（选题与创作简报），不改变正文分析范围。
 */
export function buildBreakdownReportPrompt(input: string, persona?: string): string {
  const material = input.trim();
  const personaLine = persona
    ? `【创作者画像】第 7 章结合画像「${persona}」：选题与创作简报要贴合这位创作者的领域与受众；画像里没有的信息按通用处理，不要编造画像内容。`
    : '【创作者画像】未提供：第 7 章按通用创作者给方向，并注明“未做个人化”。';
  return `你是中文内容研究编辑，为创作者完成一次专业的内容拆解：直接交付一份可连续阅读的《内容拆解报告》，不是聊天式回答，全程使用中文。

【本次材料】
"""
${material}
"""

【报告结构】Markdown 输出，标题层级与顺序固定：
# 内容拆解报告：<作品标题，或按内容主题概括>
## 报告摘要
## 1. 研究对象与材料范围
## 2. 内容定位与价值承诺
## 3. 标题与开头的具体写法
## 4. 全文结构与关键转折
## 5. 关键发现与替代解释
## 6. 表达方式与可信度
## 7. 可迁移方法与创作方案
## 8. 验证计划

【各章要求】
- 报告摘要：白话写清三件事——这篇内容最值得借鉴的是什么、主要缺口或限制是什么、如果要写自己的版本优先借什么；不超过三段，结论先行。
- 1. 研究对象与材料范围：用清单或紧凑表格写明：标题；作品形式（按实际材料判断，判断不了就写“无法确定”）；已读材料（如“标题＋全文，未截断”）；未提供材料（封面、评论、发布时间、播放/互动数据、账号背景等按实写）；可分析范围；暂不能判断什么。再写一句本次研究问题。
- 2. 内容定位与价值承诺：面向谁、什么情境、回应什么问题（区分材料中明确写出与你的推断）；核心角度是什么；如有标题，用“承诺—正文对应内容/位置—兑现程度”表核对承诺兑现。
- 3. 标题与开头的具体写法：标题用了哪些真实存在的手法（反差、具体数字、场景、结果前置等）；开头怎样承接标题、建立继续读下去的理由；这种写法的风险或误用后果。材料里没有标题或开头就写明缺失并跳过对应分析。
- 4. 全文结构与关键转折：逐段（按材料自然分段）输出“| 段落/部分 | 实际内容 | 在全篇承担的功能 | 需要注意的地方 |”表；一句话概括主线；指出钩子（具体场景、冲突、反差、悬念、结果前置）出现在哪里、起什么作用、有没有兑现；指出关键转折发生在哪里、转折前后立场或标准如何变化；必须覆盖中后段与结尾。
- 5. 关键发现与替代解释：给 2–4 条最有价值的发现，每条严格按四要素展开：
  ### 发现N：<一句话结论>
  - **原文依据**：逐字引用材料原句（一字不差，并注明出现在标题/开头/第几段/结尾）。
  - **分析过程**：怎样从依据推出结论；列出至少一种其他可能解释，并说明现有证据更支持哪一种、或为什么不足以区分。
  - **可能作用**：对目标读者可能意味着什么——这是基于文本的解释，不是已证实的事实。
  - **适用边界**：什么条件下成立、什么情况不适用、还缺什么证据会削弱或推翻它。
  本章末尾用一小节“能否解释它为什么火”收口：把“文本里有什么写法”（观察）、“可能带来什么理解效果”（解释）、“它带来了播放增长”（需要独立数据）三者分开，绝不混写。
- 6. 表达方式与可信度：具体用词、举例、动作描写等表达做法及其与内容目的的匹配；可信度分层——哪些是作者自述、哪些是描述、哪些是分析解释；指出承诺未兑现、证据缺口、夸大或含混之处（如有）；材料中没有的（图片、声音、画面）明确写“未提供，不评价”。
- 7. 可迁移方法与创作方案：①“| 可以保留 | 必须换成自己的材料 | 不宜直接迁移 |”对照表；②可直接套用的结构模板，用【槽位】表达，并注明哪些槽位必须有真实材料、没有时怎么写；③一份创作简报（换一个与原文不同、但结构可迁移的题材）：目标读者情境、文章目标、核心角度、首选标题方向、开头素材、方法正文、必备证据、结果段、结尾；④2–3 个具体选题（目标读者、具体问题、独特角度、需要准备的材料）。
- 8. 验证计划：“| 待验证问题 | 需要的材料或行动 | 结果能支持到什么程度 |”表，优先给真正能检验方法或写法的问题；最后一句说明本报告最有把握与最需要补的部分。

【必须遵守的边界】
1. 不得声称这篇内容“火了”“是爆款”，不得给“为什么会火”的结论；没有表现数据时至少明确写一次“没有表现数据，不能判断它为什么火”，传播原因只能作为待验证假设。
2. 材料里没有的数字不得出现；材料里有的（例如原帖自述数据）只能标注“用户提供/原帖声称、未经核实”，只作背景，不能用来推导传播原因；不得输出“爆款概率”、评分或预测。
3. 不编造封面、配图、评论、发布时间、播放/点赞/收藏、账号背景；材料没有的写“未提供/不适用/无法判断”。
4. 引用必须逐字来自材料，不得改写或拼接；分享文案（如“快来看”“分享给你”这类导流语）不是作品正文，要单独说明。
5. 只给链接时：先尝试读取链接实际内容；成功就按读到的内容分析并注明“已读取链接内容”；失败就写明“仅拿到链接、未取得正文”，只做有限的如实说明，绝不编造链接里的内容。
6. 材料包含多篇不同作品时不要混拆：说明检测到多篇，按其中最主要的一篇分析（写明是哪一篇），其余建议分开提交。
7. 必须读到材料结尾；失败、例外、限制等不支持“成功故事”的内容要保留；不要用“情绪价值”“共鸣”“认知冲突”等标签代替具体分析；同一句原句不要支撑多个不同结论；材料单薄时，短而完整的报告优于通用话术扩写。
8. 只输出 Markdown 报告正文：不调用工具下载或保存文件、不写脚本、不给文件链接、不反问问题（一次性生成，中途没有人可以回答）；不确定就如实写“未核实/无法判断”。

${personaLine}`;
}
