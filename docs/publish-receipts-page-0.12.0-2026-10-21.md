# 发布回执页、素材补充指引与知乎登录预检 · 0.12.0

日期：2026-10-21。源码基于已交付的 0.11.2；新增独立模块，minor 升至 0.12.0。交付分支：`codex/publish-receipts-0.12.0`。本轮源码交付，不自动部署138或发布安装器。

## 问题与根因

138的三次知乎尝试在北京时间17:51:17、17:52:27、17:54:48均以退出码6结束，回执记录 `submissionAttempted=false`。最后一次前两秒已有账号校验成功记录。已有 `easel:account-state` 全局事件正常连接账号中心、侧栏和发布界面；问题在发布脚本独立使用旧版页面选择器判断登录。

只读实测中，知乎身份接口 `/api/v4/me` 返回有效身份，`https://zhuanlan.zhihu.com/write` 返回200并保留写文章页面，标题输入和编辑器可见。当前头像位于 `.ColumnPageHeader-profile` / `.AppHeader-profileEntry`，旧的严格选择器只包含 `.AppHeader-profile` / `.AppHeader-userInfo`，因此误判掉线。诊断使用临时复制的登录资料并拦截浏览器写请求，临时副本已清理；没有提交文章。

## 实现

- 知乎发布预检复用账号中心的 `_authenticated_account` 身份检查，只在可信HTTPS知乎域名上采信，并补充当前专栏页头像选择器。明确登录页面或可见登录浮层仍拦截。
- 无法确认身份与明确要求登录分别返回 `auth_check_unavailable` / `login_required`，写入安全、具体的失败原因及 `submissionAttempted=false`。无法确认时停止提交，不把页面改版一律说成账号已掉线。
- 发布准备区明确显示缺少视频、误选图片、缺少封面图或缺少图片/视频。抖音、视频号、B站需要视频；公众号需要图片封面；小红书、快手需要图片或视频；知乎支持纯文字。点击缺素材状态会展开素材选择区、滚动定位并转移键盘焦点；空素材库有“前往内容库”入口。账号状态待确认时动作与文字一致，执行账号检查。发布中平台可进入当前回执，其他平台继续显示待处理项。
- 新增完整“发布回执”页，从侧栏、创作工具导航、发布中心“查看全部发布回执”以及事件通知进入；读取现有回执API，复用后台任务和存储，不迁移或重写历史结果。
- 支持标题/平台/原因搜索、平台筛选、状态筛选、刷新、已读处理、通知设置；保留作品链接、只核实已有发布的操作、自动核实控制、短信输入及邮件状态。明确区分已发布、已提交、草稿、待核实与失败，处理入口不自动重试发布。
- 地址为 `#/publish-receipts`，单条为 `#/publish-receipts/<32位回执ID>`；刷新保留页面并定位记录。通知目标经前后端白名单清理，不接受任意页面或无效回执ID。

## 验证分层

| 层级 | 证据与结果 | 边界 |
| --- | --- | --- |
| 真实平台只读诊断 | 138有效知乎身份、当前写文章页面和旧选择器误判已核对 | 不是修复后真实发布验收 |
| 后端回归 | `test_publish_receipt_scripts.py`、`test_publish_receipts.py`、`test_publish_account_lifecycle.py`、`test_login_scan_progress.py`、`test_notification_cleanup.py`：216通过，2项依赖弃用警告 | 发布和平台响应由测试替身控制 |
| 前端相关回归 | 回执逻辑/组件、侧栏、更多菜单、通知同步：128通过；最终补充的回执组件、创作工作区、版本、懒加载组合：57通过 | 两组有重复，不相加；不声称全量测试通过 |
| 构建与静态检查 | `npm.cmd run build`、`npm.cmd run lint`、`git diff --check`通过 | lint有既有警告；构建有大块体积提示 |
| 本地真实浏览器 | 隔离后端 `127.0.0.1:7882` 与最终0.12.0前端：侧栏/创作导航/发布中心入口、搜索、状态键盘筛选、账号处理入口、通知设置、缺视频定位/焦点及空库跳转、回执深链接/刷新、窄屏布局 | 回执是3条明确标注“隔离验证”的测试数据；浏览器窄屏实测页面无横向溢出 |
| 本地账号读取 | 账号页自动读取了本机已有平台资料，只做状态检查 | 回执数据隔离不代表平台登录资料模拟；未清除/注销登录资料 |
| 正式运行 | 诊断时138仍为0.11.2 / `5b6e8177c5a2`；本机QA为0.12.0 development / revision=null | 未切换138；未重试用户文章；未做真实平台写入、邮件发送或安装器发布 |

历史失败回执保留原记录，无法从旧通用错误自动补出当时未保存的精确原因。新预检失败才会保存本次新增的具体状态。原有其他任务清单和后端全量历史失败继续保留。

当前工作台没有管理员认证系统，本次不新增管理员登录；隔离QA入口不需要管理员账号。138已有入口认证保持原状。

## 后续按授权部署

固定本分支的已交付提交，同时更新后端、共享发布脚本和前端构建；只替换前端无法修复知乎预检。使用[现有138发布流程](deploy-138-quick-start.md)，保留账号资料、登录配置、输出目录及 `_publish/receipts.json`，不把本地QA数据打入生产镜像。

先备份并在隔离实例核对运行版本、构建SHA、静态资源、已有回执读取、全部新增入口和知乎只读身份检查，再按授权切换正式服务。真实发布需单独选择用户确认的内容与平台进行验收；核实历史回执只查询已有结果，不能用重新发布代替核实。回滚使用原0.11.2固定镜像及相应备份，不回写测试回执。

## English

Version 0.12.0 adds a dedicated receipts page with safe deep links, search, shared platform/status selectors and recovery navigation. It keeps existing submission, moderation, SMS and notification controls without replaying historical publish requests. Preparation explains the precise media requirement and focuses the picker, with a library link when empty. Zhihu preflight now shares the account identity proof and recognizes the current column-editor header, while still blocking explicit login prompts and reporting uncertain authentication separately.

Validation includes 216 backend tests, 128 focused frontend tests and a final 57-test navigation/receipt group (overlapping), build/lint and an actual local browser using synthetic receipts. The production diagnosis was read-only. Host138 remains on0.11.2; no production deployment, installer release or real article submission was performed in this delivery.

## Git交付回执

- 功能提交：`7312535c3242465ff4d2d661acf38297ec05ce71`，已推送 `starry/codex/publish-receipts-0.12.0`，本地与远端SHA一致。
- 默认分支双语首页：`230388e95a865da1552c69a60b67d0ce94fc5610`，仅修改README.md / README_EN.md，已推送并核对远端SHA，保留main其余源码树。
- 本节和清单为后续文档提交；产品版本仍为0.12.0。本机构建为development，138运行版本仍是0.11.2，不能以Git推送代表服务生效。
