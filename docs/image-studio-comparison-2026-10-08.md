# 画境 AI Image Studio 与 Easel 生图工坊对照

- 日期：2026-10-08（Asia/Shanghai）。
- 用户指定仓库：[starry-sea-1412/ai-image-studio](https://gitee.com/starry-sea-1412/ai-image-studio)。
- 已核对分支：`main`；参考提交：`f39c7697957433b1453cbe865ccdfa018a934960`，提交时间为 2026-10-06 08:04:50 +08:00。
- 读取方式：Gitee 仓库页面 HTTP 200，公开 API 的 README、目录树、分支和源码内容可读；`raw/main/README.md` 返回 451，因此使用官方 contents/readme API，没有绕过登录或访问权限。
- 验证边界：本次仅阅读 README、许可证与指定源码；未运行画境、未安装其依赖、未调用模型、未验证其浏览器交互或真实生成。README 中的历史测试与成功记录是该项目自述，不作为 Easel 的验收结论。

## 1. 判断

画境有可直接提升 Easel 的产品能力，尤其是**画布涂抹局部重绘、可复用的风格模板与变量、批次和模型对比**。Easel 已经有文生图、参考图、蒙版接口、图片反推和视频生成，继续添加这些同名入口并不构成实质增量。

本轮已完成优先项：画布蒙版编辑，复用 Easel 已有图生图接口；模板资产和批次对比保留为后续独立交付项。画境是 Node.js HTTP 服务加 React，Easel 是 Python 后端加 React，适合迁移交互和数据契约，不需要再嵌套一套服务。

## 2. 已核实的功能差异

| 能力 | 画境源码证据 | Easel 当前情况 | 依赖与迁移判断 |
|---|---|---|---|
| 画布局部重绘 | [InpaintCanvas.jsx](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/client/src/components/InpaintCanvas.jsx) 提供画笔、橡皮、笔刷大小和清空；[CreateView.jsx](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/client/src/components/CreateView.jsx) 导出蒙版提交；[server.js](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/src/server.js) 有 `/api/generations/inpaint` | 支持 `referenceId + maskId`，但界面需用户自行上传同尺寸透明 PNG；没有内置画笔 | 画笔与预览仅需浏览器 Canvas；生成仍要求所选服务支持 Images edits/蒙版。最适合小范围实现 |
| 反推“复现/同类变体” | [DiscoverView.jsx](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/client/src/components/DiscoverView.jsx) 在变体模式替换 `{SUBJECT}`，支持主体建议和保存模板；[provider-service.js](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/src/provider-service.js) 使用不同视觉提示词和结构化输出 | 已有元数据优先或重新看图、中文/英文输出、填回描述；没有专门风格模板模式 | 图像风格归纳需要视觉模型；手工模板与变量替换无需模型。必须继续区分作者元数据和 AI 推测 |
| 自定义灵感库 | [prompt-library.js](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/src/prompt-library.js) 单独持久化用户模板，支持搜索、保存、删除，与外部导入库分开 | 当前生图页只有固定示例和当前标签页草稿，没有工坊专用模板资产库 | 可在现有本地持久化层实现，不需要外部模型、GPU 或新服务器；预设包需另核对其内容许可 |
| 变量矩阵与批量 | [BatchView.jsx](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/client/src/components/BatchView.jsx) 展开 `{SUBJECT}` 等变量并预览提示词，矩阵上限 12 条；[server.js](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/src/server.js) 限制总任务数、每批并发和全局并发 | 前端一次提交一张，后端 `n` 最多 4 张但不等于多提示词批次；图片任务为进程内任务表 | 必须先有持久化图片任务队列、取消、提交快照及并发上限；不能通过循环点击生成来模拟安全批次 |
| 多渠道模型对比 | [CompareView.jsx](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/client/src/components/CompareView.jsx) 提示词变体与渠道/型号组合，支持重复样本；后端限制一次最多 50 个任务 | 生图工坊使用一组专用图片通道，可编辑型号，没有多渠道对照矩阵 | 需要可用的多个图像服务、逐任务型号/渠道固定和费用数量预览；模型随机性意味着单张不能判定模型优劣 |
| 提示词润色与高级参数 | [CreateView.jsx](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/client/src/components/CreateView.jsx) 有润色、负面提示词、Seed/Guidance；[provider-service.js](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/src/provider-service.js) 区分协议与实际参数 | 无独立润色入口；反推负面词可复制，但明确提示当前生成通道只接收正向描述 | 润色需文本模型或明确标记的本地规则；Seed/Guidance 取决于服务能力，不能只加输入框就宣称生效 |
| 持久任务步骤与恢复 | [execution-trace.js](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/src/execution-trace.js)、[server.js](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/src/server.js) 与 README 展示排队、请求、下载、保存、错误和远端任务编号 | 图片任务主要是 running/done/error 与等待时长；浏览器可恢复当前任务 ID，但后端重启后任务可能不可查。视频有自己的持久任务机制 | 图片队列需要单独补齐，不能把视频恢复能力当成所有图片任务已可恢复；结果不明时不自动重复收费提交 |
| 图库规模与资产管理 | [thumbnail-service.js](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/src/thumbnail-service.js) 生成 640px WebP 缩略图；[server.js](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/src/server.js) 包含分页、收藏、ZIP 导出及 `/api/gallery/auto-tag` | 工坊最近作品显示原图前 8 项并跳内容库；已有内容库预览/下载，但不是同一套可检索生图资产库 | 缩略图可复用 Python Pillow，无需引入 sharp；自动标签需额外视觉模型调用，应按用户选择的图片执行 |

Easel 代码依据：[ImageStudioPage.tsx](../web/frontend/src/components/ImageStudioPage.tsx)、[useImageStudio.ts](../web/frontend/src/hooks/useImageStudio.ts)、[ImageReversePanel.tsx](../web/frontend/src/components/ImageReversePanel.tsx)、[imageReferences.ts](../web/frontend/src/lib/imageReferences.ts)、[image_inputs.py](../web/image_inputs.py)、[image_reverse.py](../web/image_reverse.py)、[app.py](../web/app.py) 的 `/api/imagegen`、引用上传和图库接口。本表描述调研时源码，后续实现应以交付记录为准。

## 3. 优先建议

### 优先一：在参考图上直接涂抹修改区域

使用方式：选择本地/图库参考图 → 打开“涂抹修改区域” → 画笔选择范围、橡皮修正、清空 → 应用蒙版 → 用已有描述和生成按钮提交。

本轮可控制在前端交互与对应验证：不改模型协议、不引入新依赖、不自动生成。继续调用 `uploadReference(file, true)`，由既有前后端验证保证尺寸、透明区域与文件上限；支持蒙版的服务才执行实际编辑。用户不用再到外部软件制作蒙版，能直接修改海报局部背景、物件或构图区域。

实施要点：

- 独立维护选区数据和半透明红色视觉提示。内部选区导出时形成原图尺寸的 PNG：修改区 alpha=0，保留区 alpha=255。
- **不要原样搬画境导出实现。** 所读 `InpaintCanvas.jsx` 使用 alpha=0.5 的笔迹，再通过 `destination-out` 导出；初次笔迹可能仅形成半透明区域。Easel 前后端明确要求至少存在完全透明像素，直接移植可能拒收或产生不一致选区。
- 空选区不能应用；更换参考图时清空选区；载入失败提供重试或退出，取消不覆盖原蒙版。
- 指针坐标按实际显示尺寸映射到原图；限定像素及内存开销；缩放、手机触摸和笔刷大小需实测。
- 不承诺模型绝对保留未涂区域。蒙版定义编辑意图，实际结果取决于服务；只读预览不代表生成成功。

最小验收：真实浏览器涂抹/擦除/清空/取消、窄屏交互；检查导出 PNG 与原图同尺寸、alpha 包含 0 和 255；通过真实本地上传和后端蒙版校验；未配置真实服务时明确保留实际生成未验收状态。

### 优先二：风格模板库与主体替换

把常用提示词保存为有名称的模板，允许 `{SUBJECT}` 等可见变量，在应用前展示展开后的完整描述。先做保存、搜索、删除、单条复用；之后让图片反推产生可编辑的“同类变体”模板并明确标记 AI 推测。

模板只带提示词、用途、尺寸建议等公开生成参数，不保存 API Key、账号登录态或自动跟随旧渠道。模板存储独立于外部风格包，导入升级不能覆盖用户内容。必须遵守 Easel 现有 2000 字上限，不能直接采用画境的 12000 字契约。

### 优先三：持久图片队列，再做小规模对比

为图片任务补充排队/运行/取消/结果不明状态、实际执行步骤和可靠保存，再允许用户显式提交少量提示词变体。每项保存模板展开文本、型号、尺寸、参考图和蒙版快照；失败不会自动重投。模型对比应显示每组样本和所用参数，让用户挑选适合当前创作的结果，不生成无依据排行榜。

此项涉及后端队列、重启行为、费用和多渠道路由，不建议在本轮靠前端并发循环匆忙接入。可先补任务记录，为后续批量和办公室产物交接提供可靠基础。

## 4. 技术与许可边界

已读取 [LICENSE](https://gitee.com/starry-sea-1412/ai-image-studio/blob/f39c7697957433b1453cbe865ccdfa018a934960/LICENSE)：MIT，Copyright (c) 2026 AI Image Studio contributors。许可证允许按条件复用；如以后复制实质代码，应保留版权和 MIT 全文。本次完成对照与独立实现，没有复制其实现或执行第三方代码。

画境 README 将 InvokeAI、cc-switch、ai-picture-editor 列为参考，并声明未复制其代码；这不自动代表所有外部提示词包和素材都具有同一许可。Easel 继续保留自己的 Apache-2.0 与上游归属，不因参考画境而修改许可证。

不建议迁移其整套 Node 服务、后台自动启动或外部模型默认地址。现有 Python 后端、持久化、模型设置和内容库应该继续作为 Easel 的统一入口。MCP、PWA 和多渠道网络配置是可选的后续集成方向，不能替代当前生图创作体验的实质完善。

## 5. 本轮实际交付与验证

已新增 [InpaintMaskEditor](../web/frontend/src/components/InpaintMaskEditor.tsx) 与 [inpaintMask](../web/frontend/src/lib/inpaintMask.ts)，直接使用现有图片引用上传链路。画笔、橡皮、大小、清空、取消、应用分别可操作，空选区不可应用；原图预览和选区分开保存，修改区 alpha=0、保留区 alpha=255，输出严格保持原图尺寸。预览尺寸有上限，载入后释放原图资源，逐行压缩输出、分块检查透明度，避免额外的整幅像素缓冲。

图片/视频上传返回实际引用对象或 `null`；素材预览绑定引用 ID。失败上传保留原素材，换用图库图片或移除引用后不会残留上一段视频预览。此处是媒体来源一致性修正，不代表已完成持久图片任务队列。

- 真实浏览器：使用明确标记的 640×480 合成网格图，完成文件选择、绘制、擦除、清空、取消和应用；本地后端接受蒙版上传，读回 PNG 仅包含 alpha 0/255，透明像素 452 个。
- 390×844 断点：编辑面板、画笔点击与共享笔刷下拉可用；发现并修正“标准”两字折行，最终截图复查通过。未验证物理手机的触控笔或多指手势，不将桌面视口仿真当作真机测试。
- 图片/视频切换的实际键盘与鼠标操作、独立草稿保留已检查；媒体引用丢失/替换/失败行为由自动测试覆盖。
- 本轮前端全量 555/555、Python 1417 passed / 6 skipped，lint、TypeScript、生产构建通过；这些为整个交付的数字，不是全部针对蒙版，也不是实际生成次数。
- 没有运行画境服务、付费生图或真实模型局部编辑。服务是否严格保留未涂区域仍需使用用户配置的模型单独验证。

完整浏览器、HTTP 与模拟测试的区分见 [本轮验收](analysis-platform-orca-2026-10-08.md)，未完成项保留于 [用户指令清单](user-requirements-2026-10-08.md)。
