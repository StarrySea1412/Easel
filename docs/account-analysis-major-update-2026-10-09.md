# R42 账号分析重大更新实施契约

计划先于本阶段代码修改，2026-10-09。依据：[七平台公开资料与指标边界](platform-algorithm-research-2026-10-09.md)。

## 交付目标

页面先回答“能分析作品的什么问题”，再显示当前账号实际证据、平台机制的资料边界和下一篇可验证的题材。平台、账号、作品、指标、导出和实验保持同一上下文。规则生成的建议不冒充模型分析或算法因果。

## 顺序与并行分工

1. 保留已完成的旧面板自动读取修复及竞态测试；核对持久工作台的响应身份与异步保存范围。
2. 后端扩展可选 `advancedMetrics`，保留原五指标及历史记录兼容。支持曝光、完播次数、平均观看秒数、视频长度秒数、归因新增关注、投币与弹幕。所有数字必须非负有限；单位明确，缺失为 null，不从账号净增粉推算单篇关注，不从播放推算完播。随现有 snapshotAt、period、identity 保存，模板与导出同步。
3. report 增加 `professional`：scope、能力矩阵、数据质量、指标说明、可比组、事实及待验证题材；该对象由程序生成，无需调用模型。按同账号/平台/形式/窗口/投放状态/作品观测年龄分组；未知窗口、发布时间或投放状态不参与效果比较。累计值只允许相同整日年龄比较，缺少视频长度时不能输出观看质量的优劣排名。显示排除原因、有效 N、样本范围与更新时间。
4. 题材来源限定为真实标签与实际评论问题。标签候选最少 2 篇，并显示比较组/反例/缺失，数据不齐时只列编辑候选；互动计算使用合计事件数除以合计播放/阅读，称“每百次观看互动事件”，不当作独立人数转化率。显示证据作品 ID、窗口、样本 N/总 N、局限、单变量行动、7 天后观察日期与停止规则，不给爆款分数。选题保存和实验预填固化这些证据。
5. 前端复用共享 Select；新增能力卡、资料边界卡、证据与题材面板，并放入持久工作台。无账号/无作品也展示平台专属可诊断问题和所需材料。所有来源使用明确官方 URL 与核对日期，公开事实、资料未披露、账号假设和编辑建议分别标识。切换时立即清空；报告身份不匹配视为错误。
6. 聚焦验证：跨平台/同名账号隔离、旧响应、未知/混合窗口、零分母、缺失值、异龄/投放混杂、无数据/小样本、题材证据和实验引用。再做真实浏览器菜单/切换/导入/导出/证据定位、键盘与 390px 布局。最后更新双语 README/CHANGELOG/进度，Git 推送和最终包审计分别记录。

## 数据契约（前后端共同使用）

`advancedMetrics` 可选字段：`impressions`, `completions`, `averageWatchSeconds`, `durationSeconds`, `followersAttributed`, `coins`, `danmaku`。缺失字段读为 null。不得输入百分比代替次数；不自动映射平台未核验字段。

`professional` 包含 `scope: {platform, accountId}`，`capabilities: [{id, question, required, available, total, status, limitation}]`，`quality: {total, comparable, excluded: [{id, reasons}], observedFrom, observedTo}`，`metricDefinitions: [{key,label,unit,formula,limitation}]`，`cohorts: [{id,label,contentIds,period,ageDays,format,paid}]`，`topics: [{id,label,kind,status,evidenceIds,counterexampleIds,sampleCount,totalCount,metric,metricLabel,value,baselineValue,period,comparison,missingCount,observation,hypothesis,action,reviewAt,stopRule,limitations}]`。`value`/`baselineValue` 可为 null；topics 不声称因果，status 使用 `exploratory`/`needs_data`/`editorial`。

前端只显示返回的本账号证据，能力静态说明在无报告时仍可见。旧报告没有 professional 时显示升级/补齐提示并保留原功能；不得临时生成虚构统计。

## 当前验收边界

本计划不自动调用收费模型、发布内容或向平台发送验证请求。真实登录、真实后台字段、真实模型效果、最终 ZIP 与干净 Windows 仍需独立验收；用户手机扫码是外部依赖，不阻塞可独立完成的代码工作。
