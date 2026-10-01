import type { AnalysisContent, MetricKey } from './contentAnalysis';

// Fictional, in-memory teaching data. Never passed to an import or capture API.
const samples = [
  ['夜景总是拍糊？手机拍清楚的 3 个设置', '实用教程', '图文', 18600, 1210, 86, 920, 112, '拍夜景先别急着按快门。第一步：靠稳手机；第二步：降低曝光；第三步：锁定对焦。', '读者能马上照做，收藏后方便下次拍摄时查看。', '下一篇继续回答一个具体问题，用三步讲清楚，并补上前后对比。'],
  ['周末不踩雷：3 家适合独处的咖啡店', '清单推荐', '图文', 12400, 880, 52, 640, 75, '想一个人安静坐一下午？这三家店分别适合阅读、办公和发呆，文末附交通方式。', '清单说明了使用场景，还给出了到店方式，便于收藏备用。', '在下一份清单里补上预算与开放时间，让读者更容易做选择。'],
  ['普通周二，也要好好吃早餐', '日常记录', '图文', 7200, 430, 23, 76, 18, '今天起早了一点，煎了鸡蛋，烤了面包。阳光刚好照在桌子上。', '画面记录了生活，但文字还没有告诉读者能带走什么。', '保留生活感，补充这份早餐的用时与做法，试试是否有人愿意收藏。'],
  ['一扇窗就够：在家拍出柔和的产品光', '实用教程', '视频', 15200, 990, 67, 780, 84, '把杯子放在离窗半米处，另一侧立一张白纸。关掉室内顶灯，先拍一张看看阴影。', '方法只用窗户和白纸，准备门槛低，读者容易尝试。', '下一次只换一个条件，展示白纸放置前后的区别。'],
  ['第一次城市漫步，这条 2 小时路线直接抄', '清单推荐', '图文', 13800, 930, 61, 710, 98, '从地铁口出发，先逛旧书店，再到河边，最后在咖啡馆休息。全程步行约两小时。', '时间、顺序和出发地点具体，适合留到周末使用。', '补一张路线图和雨天备选，让路线更完整。'],
  ['下雨的下午，在窗边坐一会儿', '日常记录', '图文', 6100, 390, 19, 58, 12, '雨一直没停。泡了一杯热茶，翻了几页书，今天没有安排。', '评论更适合围绕情绪交流，目前没有明显的收藏理由。', '试着问一个容易回答的问题，例如“下雨天你喜欢做什么？”'],
  ['拍咖啡别只会俯拍，试试这 3 个角度', '实用教程', '图文', 16800, 1080, 73, 850, 96, '第一个角度拍杯沿，第二个角度带上窗框，第三个角度加入拿杯子的手。每张图只留一个重点。', '具体角度让读者有可复用的方法，主题也能接着做系列。', '下一篇用同一杯咖啡拍三组对照，保持其他条件一致。'],
  ['小桌面也舒服：我的 5 件办公好物', '清单推荐', '视频', 10900, 750, 44, 510, 61, '桌面小，不代表只能堆东西。我留下灯、支架、收纳盒、杯垫和一个计时器，其他全部收起。', '清单有明确的空间问题，适合正在整理桌面的读者。', '为每件物品补充占地尺寸，并说明哪件可以不买。'],
  ['没有计划的周末，沿河走到日落', '日常记录', '视频', 8200, 520, 35, 94, 27, '下午出门，沿着河走，路上买了一杯咖啡。走累了就在长椅上看日落。', '记录有轻松的氛围，但缺少地点和路线，读者不容易照着走。', '如果希望增加收藏，可以补上起点和日落时间；先只改这一项。'],
] as const;

export const DEMO_ACCOUNT = '小夏的日常灵感';
export const DEMO_NOTICE = '演示数据 · 账号、作品、指标和分析均为虚构示例';
export const demoContents: AnalysisContent[] = samples.map((row, index) => {
  const [title, theme, format, views, likes, comments, collects, shares, body, observation, action] = row;
  const publishedAt = new Date(Date.UTC(2026, 8, 15 + index, 4)).toISOString();
  const snapshotAt = new Date(Date.UTC(2026, 8, 22 + index, 4)).toISOString();
  return { id: `demo-content-${index + 1}`, title, tags: [theme], format, publishedAt, snapshotAt,
    period: '7d', body, metrics: { views, likes, comments, collects, shares },
    diagnostics: [{ id: `demo-note-${index + 1}`, dimension: '创作线索', observation, action,
      evidence: body, limitation: '这是解释方法的虚构示例。收藏较多只提供线索，不能证明某种写法造成了增长。' }],
  };
});

export function demoTotal(metric: MetricKey): number {
  return demoContents.reduce((total, content) => total + (content.metrics[metric] || 0), 0);
}

export function demoThemes(metric: MetricKey) {
  return ['实用教程', '清单推荐', '日常记录'].map(tag => {
    const works = demoContents.filter(content => content.tags.includes(tag));
    return { tag, count: works.length, average: Math.round(works.reduce((sum, content) => sum + (content.metrics[metric] || 0), 0) / works.length) };
  });
}

export const demoTrend = [0.22, 0.40, 0.57, 0.72, 0.84, 0.93, 1].map((fraction, index) => ({
  day: index + 1, views: Math.round(demoTotal('views') * fraction / demoContents.length),
  collects: Math.round(demoTotal('collects') * fraction / demoContents.length),
}));

export type DemoSort = 'publishedAt' | 'views' | 'likes' | 'collects' | 'comments';
export function filterDemoContents(query: string, theme: string, sort: DemoSort, ascending: boolean) {
  const needle = query.trim().toLocaleLowerCase();
  return demoContents.filter(content => (!theme || content.tags.includes(theme))
    && `${content.title} ${content.tags.join(' ')} ${content.format}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => {
      const left = sort === 'publishedAt' ? Date.parse(a.publishedAt!) : a.metrics[sort] || 0;
      const right = sort === 'publishedAt' ? Date.parse(b.publishedAt!) : b.metrics[sort] || 0;
      return (left - right) * (ascending ? 1 : -1);
    });
}
