# Windows 0.2.6 交付验证（2026-09-30）

形态为图形安装器 + 网页工作台。源码提交 `38e728c49f68b57d8cbed551d13d427e8670dd11`；本文件在构建之后补记验收，不改变包内应用源码。

## 安装与启动入口

- GUI ZIP：`dist/0.2.6/Easel-0.2.6-Windows-GUI.zip`，完整解压后双击 `Easel-Setup-0.2.6.exe`。
- 独立安装器：`dist/0.2.6/Easel-Setup-0.2.6.exe`，默认显示图形向导。
- 日常入口：安装目录内 `打开 Easel.vbs`，通过图形启动窗口打开浏览器工作台。
- 首次安装需要联网下载依赖；测试版未作代码签名。没有执行远端 Git push 或公开发布。

## 已完成检查

- 最终后端全量 1041 passed / 1 skipped，89.40 秒；唯一跳过项为 `test_setup_auth.py` 中实际修改 Windows PATH 注册表的检查。
- 前端 31 项 Node 回归、lint（无警告）、build 通过；构建为 `index-kxtWMyHN.js` / `index-B1ouKBtC.css`。Vite 提示主包超过 500 kB，未在本轮进行页面分包。
- 1026 个源码文件及 5 个前端构建文件与载荷逐字节一致；源码 manifest `sourceDirty=false`。
- EXE 内嵌 ZIP 与独立源码载荷相同，bootstrapper 编译代码与源码一致，ZIP CRC 和三包 SHA-256 通过。
- 本机凭据、私有运行数据、缓存和虚拟环境的排除路径均未进入发行载荷。
- 最终原始 EXE `--self-test` 退出 0，4.02 秒；同一原始 EXE 实装退出 0，893.14 秒，8 个阶段通过，网关首次检查成功。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Easel-Setup-0.2.6.exe | 36742781 | `6c664b49ea0ad4bdace952db0f91b27d5700c61f60ccf1f9ca0920c685f2f2cd` |
| Easel-0.2.6-Windows-GUI.zip | 36497824 | `5636fe494a965af7f9736ca35c98e4268ecdaba11df0c3f3ddf5bbcd1ae831b3` |
| Easel-0.2.6-windows.zip | 25705352 | `7a54b361d160db845fab40934f8a3d54aff3edf8ab0c567ae500e10d5737b9ec` |

## 真实安装与 HTTP 验收

- [x] 最终 EXE 安装到 `.scratch/release-0.2.6-qa/install`，独立网关 37313、工作台 37314。
- [x] 8 个安装阶段成功，EXE 正常退出 0（893.14 秒），网关首次通过；PS1/VBS 指向 0.2.6，outputs/profiles/assets 目录联接正确。
- [x] 安装前 1 个合成文件 SHA-256 保留。
- [x] 安装内工作台两次无浏览器启动均退出 0；首次 8.70 秒、重复 3.12 秒，复用 PID 15504，地址 `http://127.0.0.1:37314/`。
- [x] 真实 HTTP 首页和全部 2 个入口构建资源与安装文件逐字节一致；7 平台账号元信息、保存位置、图库、合成 PNG 上传/像素回读、精确 turnId 隔离查询通过。
- [x] 后台网关 PID 31700 / 端口 37313，检查到 49 个模块，其中 `_MEI` 来源为 0，VCRUNTIME 来自 Windows SYSTEM32；最终残留安装 EXE 为 0。

这是开发机上的独立安装根，并非干净 Windows 虚拟机；安装前只放置明确的合成内容，用于验证已有内容保留，不能称为完整 0.2.5 原位升级。上一版本的真实迁移后升级记录见 [0.2.5 验收](windows-release-verification-2026-09-30.md)。

## 7863 源码预览

本轮恢复已停止的服务，继续使用原有 Easel 数据和 `.openclaw-easel` 配置，未改变模型或鉴权设置。网关首次冷启动超过 300 秒；后续实际健康检查通过，保留首次等待超时记录。

HTTP 首页与最终 dist 一致，全部两个构建资源可访问；`/api/status` 返回网关在线。携带现有配置凭据的 HTTP 空请求进入参数校验，WebSocket connect/health 成功。现有网关原本为 `mode=none`，这些检查证明连通与握手，不代表已在真实网关强制 token 模式下验收；token/password 的拒绝与传递由合成协议回归覆盖。本轮没有发送模型提示或触发真实生成。

另有 14 个真实本地 GET 接口返回 HTTP 200 和有效 JSON：状态、技能、画像、账号元信息、内容库、图库、模型配置、图片反推配置、保存位置、分析平台、选题库、日历、指定空轮次 Skill 核验、指定空会话用量。没有执行这些页面的真实鼠标操作；接口检查也不代表真实平台授权或模型功能已经通过。记录：`.scratch/release-validation/preview-entries-0.2.6.json`。

## 入口逐项记录（仅源码映射，不是点击通过）

| 入口 | 源码核对结果 |
| --- | --- |
| 生图历史 | 到内容库，启用 `imagegen` 筛选 |
| 生图通道设置 | 到设置的 `image` 配置区 |
| 内容分析 / 运行记录 | 分别对应 `ContentAnalysisPage` / `ActivityPage`，图标不同 |
| 上一轮 / 下一轮 / 最新 | 跳到对应轮次锚点或滚到底部恢复跟随，边界禁用存在 |
| 错误重试 | 最后一轮且未流式运行时可重试；替换本地最后一轮后发起请求 |
| 对话内 Skill 核验卡 | 携带 sessionId/turnId 到运行记录，查询并展开对应轮次 |

技能库的 SkillDrawer 详情没有运行记录跳转入口；不能把它与对话内 Skill 核验卡混同。

## 验收边界

- 用户此前 Esc 停止电脑控制，尚未恢复浏览器和原生 GUI 点击；未将源码、Node、真实安装引擎及 HTTP 检查冒充鼠标操作。
- 没有执行真实平台账号登录、真实模型生成、发布或 SMTP 发信，QQ 邮箱继续暂缓。
- 应用无自有管理员用户名/密码门禁，延续用户已确认的平台账号管理形态；`gaojitest / gaoji` 不适用，未新增登录墙或虚构登录验证。
- 干净 Windows、完整旧版本升级/回退矩阵、断网恢复和代码签名仍未验收。

本机详细 JSON 与日志保留在 `.scratch/release-0.2.6-qa/`，不随源码包发行。
