import type { AnalysisCapability } from './contentAnalysis';
export interface PlatformResearch { label:string; source:string; sourceLabel:string; questions:string[]; focus:string; limitation:string }
export const ANALYSIS_RESEARCH:Record<string,PlatformResearch> = {
 xiaohongshu:{label:'小红书',source:'https://creator.xiaohongshu.com/',sourceLabel:'小红书创作者中心',questions:['标题与封面是否说明使用场景？','正文是否交付可收藏的步骤？','评论里哪些问题尚未回答？'],focus:'收藏与评论需求分开观察；仅有同龄、同形式的作品时比较表现。',limitation:'公开入口未提供可复现的推荐、搜索或初始分发权重，不能断言收藏权重最高。'},
 douyin:{label:'抖音',source:'https://creator.douyin.com/',sourceLabel:'抖音创作者服务中心',questions:['开头承诺是否在逐字稿里兑现？','逐字稿是否提供清晰的步骤和结尾？','评论追问能否形成下一条？'],focus:'后台实际提供完播次数、平均观看时长和视频长度后才能检查观看质量。',limitation:'平台未披露可复现的推流阈值和互动固定权重；不能从播放量推算完播。'},
 bilibili:{label:'哔哩哔哩',source:'https://member.bilibili.com/',sourceLabel:'哔哩哔哩创作中心',questions:['选题是否围绕清晰问题和章节？','评论或弹幕提出了哪些系列需求？','同形式同龄作品的收藏和投币如何？'],focus:'播放、收藏、投币、弹幕分开保存；缺留存曲线时不判断具体流失位置。',limitation:'平台未披露可复现的推荐权重，不能把投币或收藏写成固定流量因果。'},
 kuaishou:{label:'快手',source:'https://cp.kuaishou.com/',sourceLabel:'快手创作者服务平台',questions:['真实经验是否提供了操作细节？','评论和分享是否出现具体场景？','哪些已发布作品具备同窗比较条件？'],focus:'先核对作品状态、发布时间和稳定 ID，再观察评论、分享及归因关注。',limitation:'关系型需求是账号假设；管理列表不代表全量已发布历史。'},
 'weixin-channels':{label:'视频号',source:'https://channels.weixin.qq.com/',sourceLabel:'微信视频号助手',questions:['开头是否说明受众和用途？','分享对应哪些实际转发场景？','逐篇新增关注与播放是否同窗？'],focus:'仅使用实际作品详情；原生期间值、净增值与累计值分别解释。',limitation:'没有分发来源就不能断言分享来自私域；管理页入口不等于可信公开作品链接。'},
 zhihu:{label:'知乎',source:'https://www.zhihu.com/creator',sourceLabel:'知乎创作者中心',questions:['回答是否直面问题并给出条件？','论证与引用是否支撑结论？','评论暴露了哪些尚未回答的追问？'],focus:'文章、回答与想法分组；赞同、阅读和收藏沿用原生定义。',limitation:'平台未披露赞同或收藏的固定推荐权重；热榜排名不能证明因果。'},
 'wechat-oa':{label:'微信公众号',source:'https://developers.weixin.qq.com/doc/service/guide/product/analysis_data/analysis_data.html',sourceLabel:'微信官方数据统计文档',questions:['标题承诺与正文是否一致？','正文是否交付读者能带走的方法？','文章主题与真实分享场景是否对应？'],focus:'保留 msgid、stat_date、延迟与统计边界；每日人数合计不当作区间独立读者。',limitation:'接口字段依赖账号权限；完成率和时长未返回时不计算或推断，未知权重不宣传为规则。'},
};
export const RESEARCH_CHECKED_AT = '2026-10-09';
export function emptyCapabilities(platform:string):AnalysisCapability[] {
 const research = ANALYSIS_RESEARCH[platform] || ANALYSIS_RESEARCH.xiaohongshu;
 return [
  {id:'promise',question:research.questions[0],required:['真实标题','正文 / 视频逐字稿','封面文字（可选）'],limitation:'仅检查提供的文字；无图像时不能评价构图或配色。'},
  {id:'questions',question:research.questions[1],required:['对应作品材料','实际评论 / 弹幕（如适用）'],limitation:'材料诊断与评论需求为编辑观察，不证明推荐因果。'},
  {id:'reach',question:'曝光之后有多少次阅读 / 观看？',required:['同窗口曝光次数','同窗口阅读 / 播放次数'],limitation:'没有曝光分母不能推断封面点击率；观看次数不代表独立人数。'},
  {id:'watch',question:'视频观看是否完成，平均看了多久？',required:['完播次数','平均观看秒数','视频长度秒数','同窗口播放次数'],limitation:'缺视频长度不做观看质量优劣排名；未读取画面或逐秒留存。'},
  {id:'interaction',question:'同条件作品的互动需求有何线索？',required:['赞、藏、评、分享的原生次数','稳定作品 ID','发布时间','观察时间','窗口','投放状态'],limitation:'同平台同账号同形式同龄比较；每百次观看互动事件不是独立人数转化率。'},
  {id:'followers',question:'哪些作品带来平台明确归因的新关注？',required:['单篇归因新增关注','对应阅读 / 播放分母','统计窗口'],limitation:'账号净增粉不能归因到单篇作品。'},
  {id:'topics',question:research.questions[2],required:['至少两篇同标签作品，或实际评论问题','证据作品与反例','可对齐的指标窗口'],limitation:'无比较条件时只给编辑候选；题材建议是待验证假设。'},
 ].map(item=>({...item,available:0,total:0,status:'needs_data'}));
}
