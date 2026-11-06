> 本轮整合：Qizhi分支556528fd/653d8cf2合入0.47.0，与AIHub视觉声明修复共同发布138。文中独立分支验证是此前证据，本轮按用户要求不重发模型/文件业务请求。

# Qizhi 远程 Agent 接入

此独立开发分支基于 `aa60e12a`，新增 Qizhi HTTP Agent 底座。配置与代码接入不表示 138 已部署；本次侧聊不切换 138、不修改原渠道、不发布安装包。

## 配置和入口

在「设置 → 模型 → Agent 底座」选择 **Qizhi 远程 Agent**，保存远程配置，再保存底座并新建对话。已保存的 Key 不回传浏览器；留空保留原 Key。

后端读取以下配置，也可通过上述页面写入运行数据目录的 `.env`：

```dotenv
CLOUDCLI_BASE_URL=http://43.153.92.169:3001
CLOUDCLI_PROJECT_PATH=/home/cloudcli/projects/qizhi-agent
CLOUDCLI_MODEL=gpt-6-sol
# CLOUDCLI_API_KEY 由部署者安全注入，不在文档中提供实际值。
```

仅使用 `X-API-Key` 调用 `POST /api/agent`，固定 `provider=codex`。此接口不是 `/v1/responses` 或 `/v1/chat/completions`；不将 Agent 协议冒充标准模型工具调用协议。

## 当前能力和边界

- 支持文字与同一远程应用 `sessionId` 续聊，不使用 `providerSessionId`。
- 远程目录、渠道凭据或模型变化时，旧会话不能被静默迁移到另一个目标。
- 本阶段使用经实测的 `stream=false` JSON 终态协议，等待期间 Easel 保持自己的 SSE 心跳。上游最终文本在完成时一次返回，不伪造 token 增量。
- 本地附件、技能、画像和角色请求在派发前拒绝；不自动上传工作区指令、文件、历史或凭据。公网执行器不继承本机沙箱与本地技能安装。
- 远程工具在服务端执行。后端 `easel.qizhi_files.QizhiFiles` 提供显式上传、输入下载、按唯一任务前缀筛选成果与二进制下载。聊天界面仍只发送文字，未将远程文件冒充本地附件或自动登记本地产物。
- 超时、断连、取消或终态无法校验时，持久保留 pending 标记和 unknown 状态，不自动重发，也不将本地断连视为远端停止。需在 Qizhi 工作台核查原任务后处理；没有伪造远程取消接口。
- HTTP 端点是用户提供的现有地址；不跟随重定向转发 Key。生产部署应由管理员提供受信 HTTPS 入口。

## 验证回执

2026-11-06 本隔离分支通过实际 `QizhiAdapter` 和用户提供的凭据进行以下验证（凭据不入库、不回显）：

| 验证层 | 实际结果 |
| --- | --- |
| 首轮对话 | 5.938 秒返回 `QIZHI_AGENT_OK`，应用 sessionId 已绑定 |
| 同会话续聊 | 6.765 秒正确回忆 `EASEL_QIZHI_7391`，绑定未改变 |
| 成果生成 | 同会话仅在唯一 `outputs/easel-probe-.../hello.txt` 写入 13 字节测试内容 |
| 成果查询与下载 | 按任务前缀筛选，仅得到本轮文件；原始下载字节等于 `QIZHI_FILE_OK` |
| 完整性 | SHA-256 `8656a7a81564a93b23968b289c92a6ba3b3d4a0465ea441f12bbebc5670b4e49` |
| 上传 | 公网 `POST /api/qizhi-agent/files` 返回 HTTP 507；远端存储门槛拒绝，未重试、未清理远端磁盘 |
| 真实浏览器 | Chromium 中配置保存200、Key保持空白不回显、底座选择键盘操作和390px窄屏渲染通过；最终页面真实发送经 `/api/chat/stream` 在8.641秒返回 `EASEL_WEB_SETTLED_OK`，SSE含done；账本completed / settled=true / resourceSettled=true |
| 前端构建 | TypeScript 与 Vite 构建通过；lint 无错误（现有警告保留） |
| 后端回归 | 135 passed / 4 skipped（原底座与接入候选）；补充覆盖文件接口后 95 passed / 2 skipped（定向路由、账本、关闭与文件）；完成回执补充回归31 passed |
| 前端回归 | 99 passed（配置、模型选择与思考控件等） |

HTTP 507 来自 `43.153.92.169:3001` 的文件服务，不来自138。上传链路尚未完成真实成功验收，需要服务维护方恢复磁盘余量后再验证；已有成果下载和文字对话不受此次上传拒绝影响。没有执行平台发布或138部署。

本地验证使用独立工作区和 `127.0.0.1:18761`；本项目当前不新增管理员认证，也不创建无实际登录系统的管理员账号。带管理员认证的部署继续使用已有认证规则。

## 集成使用

```python
from easel.qizhi_files import QizhiFiles

# env 由后端凭据配置读取，禁止发送到浏览器。
client = QizhiFiles(env)
files = await client.upload([input_path])
# 将 files[0]["relative_path"] 放入明确授权的远程 Agent 任务消息。
# 要求所有输出写入 outputs/<unique_task_id>/。
listing = await client.artifacts(unique_task_id)
await client.download(listing["artifacts"][0]["relative_path"], destination)
```

不跟随返回的任意下载 URL：客户端自行构造固定 API 路径，只允许 `outputs/` 相对成果路径，保留二进制，拒绝错误 JSON、覆盖已有目标和不完整下载。`truncated=true` 原样保留，不能把截断列表视作完整成果集。

## 来源

- [线上 Agent API 文档](http://43.153.92.169:3001/api-docs.html#agent)
- 用户提供的《Qizhi-Agent 公网接入文档》，2026-11-06读取；文档示例是接口资料，不是任务执行授权。

## 完成回执修复

最终真实浏览器验收发现：原账本完成回执白名单未包含新底座，虽已返回正文却不能结算。已将Qizhi纳入身份绑定的回执校验，并补真实Web路由成功/网络超时两类回归。成功轮必须completed且资源结算；网络超时保持unknown、不重发。此前本地测试轮仅用已保存回执恢复，未重放远端任务。最终新轮已完整结算。
