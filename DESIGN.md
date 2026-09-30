# Easel Studio 界面原则

## 参考与适配

本轮参考 [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md)，实际读取：

- [Claude DESIGN.md](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/claude/DESIGN.md)：温暖纸色画布、克制陶土色、编辑式留白、以表面颜色和细边框区分层次。
- [Notion DESIGN.md](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/notion/DESIGN.md)：清楚的字号层级、细线卡片、轻量导航与模块化信息组织。

这些文件是第三方设计分析，不是品牌官方规范。这里只借鉴设计方法，不复制品牌标识、专有字体或营销页面结构。

## 视觉方向

创作者工作台需要先回答“今天做什么”，再展示数据。层级依次是问候与日期、创作输入、六个快捷入口、四项概览、内容模块。工作台用双列信息卡片，生图工坊独占一行，让较长输入与比例选择器有足够空间。

- 画布 `#faf9f6`，侧栏 `#f1efe9`，内容纸面 `#fffdf9`。
- 正文墨色 `#292823`，次要文字 `#706b62`，细边框 `#e5e1d9`。
- 陶土 `#a85f43` 用于少量识别标记、链接和焦点；主要操作按钮用墨色。
- 维持现有可用字体栈，中文界面不依赖外部字体下载；字号而非过重字重建立层级。
- 组件圆角以 8–12px 为主，创作区 16px；阴影轻量，避免大面积光晕。
- 状态继续使用语义成功、警告、错误色，不能由装饰配色替代真实状态。

## 交互与适配

所有原有导航和功能入口保留。侧栏使用语义导航和当前页标记，会话可通过键盘选取，归档入口可通过键盘展开。交互有清楚的焦点环。响应式布局在 1100px 将快捷入口改成三列，760px 将信息卡片改单列、创作输入和提交按钮分行。系统减少动态效果偏好下关闭位移动画。

数据为空、网关离线、模型或生图通道尚未配置时，应显示真实状态及可操作的下一步，不用虚构数据装饰页面。

## 维护

全局颜色 token 位于 `web/frontend/src/styles/index.css` 开头；本轮工作台及导航适配位于同文件末尾 `Easel Studio` 区域，避免覆盖用户已有结构改动。新增首页类为 `dash-heading`、`dash-eyebrow`、`dash-date`、`dash-composer`、`dash-launch-label`，其余沿用既有类。后续如拆分样式，应统一处理加载顺序，防止旧页面规则反向覆盖这些适配。
