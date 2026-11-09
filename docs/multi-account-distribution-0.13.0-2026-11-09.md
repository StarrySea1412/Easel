# 七平台独立账号与按账号分发 · 0.13.0

日期：2026-11-09。功能分支：`codex/multi-account-distribution-0.13.0`。基于 `46797b65` 的 0.11.0 发布线独立开发，不代表其他并行分支、138 运行版本或安装器已升级。

## 用户入口

- 账号中心：按平台筛选、搜索与状态筛选，选择一个账号查看连接详情和登录记录；支持同一平台创建多个独立账号。每平台最多 20 个账号。
- 发布中心：选择平台后，只显示这些平台下的账号；同平台可多选账号，按账号标签切换编辑标题、正文、话题和素材。一次只显示一份编辑器，方向键与 Home/End 可以切换账号。
- 发布前显示实际目标平台和账号，逐账号确认；最多 20 个目标。取消一个平台会取消其目标选择，编辑内容单独缓存，之后明确重选账号时可以恢复。
- 公众号只保存草稿。未核验、未登录或被占用的账号不能新增为目标；提交时后端重新检查全部目标，任一目标不符合受理要求则整批拒绝。
- “默认发布通道”保留原每平台一个默认账号的连接入口，旧 `/api/publish/batch` 流程继续使用默认账号，与独立账号分开管理。
- 长账号 ID、尝试编号和回执编号默认折叠；隐私开关隐藏昵称和平台身份。平台入口使用响应式网格，窄屏完整分排。
- 可见界面不使用“01、02”等装饰性编号。已清理发布区、内容分析页、协作工作流及角色预览中的相关标签与样式，保留实际数量、日期和业务编号。

## 平台能力与验收边界

下表描述本版代码能力与限制，**不是七个平台均已真实登录或发布成功**。平台页面及身份解析仍需日后逐平台真实校准。

| 平台 | 独立账号资料 | 本版发布内容 | 结果核实 |
| --- | --- | --- | --- |
| 小红书 | 独立浏览器资料 | 多张图片或一个视频 | 绑定原账号的手动只读核实 |
| 抖音 | 独立浏览器资料 | 一个视频 | 绑定原账号的手动只读核实 |
| 快手 | 独立浏览器资料 | 一张图片或一个视频 | 绑定原账号的手动只读核实 |
| 视频号 | 独立浏览器资料 | 一个视频 | 绑定原账号的手动只读核实 |
| 知乎 | 独立浏览器资料 | 纯文字文章 | 暂不支持，需在本人后台查看 |
| B站 | 独立 Cookie 文件 | 一个视频 | 绑定原账号的手动只读核实 |
| 公众号 | 独立浏览器资料 | 封面与正文图片，保存草稿 | 暂不支持，需查看本人草稿箱 |

## 账号与登录记录

`accountId` 是本地账号档案标识，`externalAccountId` 是核验得到的平台身份，两者分开保存。首次绑定后，不允许静默替换身份或把同一个平台身份重复绑定到同平台两个档案。

登录、核验、退出和排队发布按账号互斥，使用 generation/attemptId 忽略迟到结果。扫码成功仅进入待核验状态，可靠的在线身份核验通过后才可分发。登录 watcher 在页面关闭后继续记录进展，最长 270 秒；旧操作不能覆盖新尝试。

每个账号最多保存最近 200 条登录活动，包含时间、尝试、受控状态及结果。默认通道的登录、轮询、取消、核验、退出也从本版本开始记录，历史数据不补造。数据库及接口不保存密码、Cookie、验证码或原始平台响应；实际浏览器资料和运行日志在本地隔离目录保留。

| 数据 | 路径（相对于应用实际数据根目录） |
| --- | --- |
| 注册表、登录审计、分发账本 | `DATA_DIR/social-accounts/registry.sqlite` |
| 独立浏览器资料 | `DATA_DIR/social-accounts/<accountId>/browser-profiles/` |
| B站独立 Cookie | `DATA_DIR/social-accounts/<accountId>/cookies.json` |
| 登录二维码、状态、日志 | `OUTPUTS_DIR/_login/social-accounts/<accountId>/<attemptId>.*` |
| 发布回执和额外验证 | 原发布目录下按 receiptId 隔离；回执绑定 accountId |

登录或发布结束后清理本次验证码文件。目录、Cookie、二维码及本地验收文件不提交 Git。

## 分发与故障恢复

- 受理时封存每个账号的身份、generation、确认稿和素材 SHA256；执行前重新核验本人身份，再由同一浏览器上下文中的脚本 guard 核对预期账号。身份变化时阻止提交。
- 素材在受理和执行前计算摘要；覆盖或删除原文件会阻止该账号任务。这里只保存摘要，没有制作不可变素材副本，也不保证文件在核对之后不能被外部程序更改。
- `requestKey` 与确认稿哈希实现幂等。前端在联网前保存请求；受理响应丢失后锁定稿件，以同一 key 查询/重放，不新建另一批任务。同一 key 对不同内容会被拒绝。
- `queued → running` 采用原子 claim，同一 job 不能被重复领取。独立账号和旧发布流程共用浏览器写锁，逐账号串行；运行中单账号失败不阻止后续账号。
- 发布记录保留每个目标结果。只对明确 `failed` 的账号提供原确认稿重试，携带原素材摘要；已提交、成功、草稿和结果未知的账号不自动重发。素材已被覆盖时必须重新确认内容。
- 回执 JSON 保存失败仍结算 SQLite 账本，并提示以批次记录为准；验证码清理失败不把已结束任务留在运行态。
- 服务重启将尚未完成的批次任务标为 `unverified`，原回执同步结算，不重启发布 runner。先人工核对对应账号作品，禁止用重启自动补发。
- 独立账号回执核实使用回执所属账号及身份，不能借用默认账号。自动默认核实排除这些回执；知乎和公众号明确提示手动到官方后台查看。

## API

全部挂载在 `/api/social-accounts` 下，沿用应用现有访问边界：

| 方法与相对路径 | 用途 |
| --- | --- |
| `GET /`、`POST /` | 列表、按平台新建独立账号 |
| `GET /platforms` | 支持的平台集合 |
| `POST /{accountId}/login`、`GET /{accountId}/login` | 开始与读取本账号登录尝试 |
| `POST /{accountId}/cancel` | 取消指定 attemptId |
| `POST /{accountId}/sms` | 当前登录尝试的额外验证 |
| `POST /{accountId}/check`、`POST /{accountId}/logout` | 在线核验、退出 |
| `GET /{accountId}/history`、`GET /default-history` | 独立账号及默认通道审计 |
| `POST /batches`、`GET /batches`、`GET /batches/{batchId}` | 提交确认批次、最近批次和单批详情 |

批次请求形如 `{ requestKey, confirmed: true, requests: [{ accountId, payload: { title, body, tags, media } }] }`。重试原稿可以携带 `payload.mediaHashes` 供服务端校验；具体字段限制以 Pydantic 模型为准。

## 验证记录

所有账号与平台 API 通过隔离模拟验证，未执行真实平台登录、身份请求、上传或投稿，也未调用付费模型。

| 验证层 | 结果与范围 |
| --- | --- |
| 后端定向回归 | **583 passed / 2 warnings**；含账号注册/隔离、登录审计、身份变化、批次幂等/互斥、回执、进程恢复、素材变动阻断及旧发布回归 |
| 前端相关回归 | **99 passed**；含账号中心、登录恢复、回执、平台到账号选择、单份编辑器、方向键切换、取消恢复、仅失败重试、内容分析及工作流 |
| 生产构建 | `npm.cmd run build` 通过；保留大 chunk 提醒 |
| lint | 无错误，保留既有 warning |
| 浏览器模拟 | 真实浏览器挂载实际 AccountsPage/PublishPage，所有 API 在本地 fixture 替换；初始七平台各两账号，测试新增后共 16 个虚拟账号 |
| 账号中心实测 | 平台/搜索/状态筛选、新增账号、连接/取消/核验/退出、登录历史、隐私、默认入口；桌面及 CSS 390px/320px，平台完整分排、无页面横向溢出 |
| 发布区实测 | 七平台选中后逐组显示对应账号，未登录账号禁用，内容切换、确认目标、模拟三账号提交与仅失败账号重试；桌面及 CSS 390px/320px，七个平台入口完整 |
| 最新截图裁切 | 原因是模拟 fixture 缺少正式应用 `main-content → page-host` 层级，顶部导航额外占空间使 height:100% 页面溢出约 158px；仅修复预览壳，未改动正式页面已正确的高度规则。桌面与390px实际滚动到底，素材区、底部操作和最后提示可达 |
| 编号检索 | TypeScript AST 检索界面文本及字符串，结合 CSS 伪元素检查，清理装饰性前导零编号；发布区浏览器回读无编号标签 |

后端命令：

```powershell
python -m pytest -q tests/test_social_accounts.py tests/test_publish_batches.py tests/test_account_lifecycle.py tests/test_account_stats_login.py tests/test_publish_account_lifecycle.py tests/test_publish_receipts.py tests/test_publish_receipt_scripts.py tests/test_xhs_publish_followup.py tests/test_channels_publish_followup.py tests/test_publish_followup.py
```

前端命令（`web/frontend`）：

```powershell
node --test tests/social-accounts-ui.test.mjs tests/accounts-login-recovery.test.mjs tests/publish-receipts-ui.test.mjs tests/office-workflow.test.mjs tests/content-analysis-demo.test.mjs tests/platform-analysis-switch.test.mjs tests/professional-analysis.test.mjs
npm.cmd run build
npm.cmd run lint
```

## 升级与仍待完成

版本源 `pyproject.toml`、前端 package 和 lock 均同步为 0.13.0。启用本分支前停止旧进程并备份实际 DATA_DIR、OUTPUTS_DIR（包含数据库、浏览器资料与回执），再安装本分支依赖、构建前端并启动；SQLite 首次访问自动创建新增表，不覆盖原默认账号资料。回滚时保留新增目录和账本，不删资料或重发未知任务。

本轮只交付源码分支与文档，不自动合并功能到 main、不部署138、不发布安装器。main 首页只公告本功能分支并链接此文。当前工作台无管理员认证，不因此新增管理员登录系统。

真实扫码/身份选择器校准、逐平台草稿/公开发布、真实上传媒体、138运行版本与安装器验收仍未完成，继续遵守用户暂停指令。定时发布授权等旧需求继续保留，不因本轮界面修正而关闭。
