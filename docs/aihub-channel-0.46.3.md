# AI Hub 渠道专项优化 0.46.3

## 失败证据（2026-11-05）

截图8cc5b722对应138正式轮次1793863800254-j6jpo2t52wa。运行0.46.2 / 7b413f12，先成功建立AI Hub SSE响应，工具阶段后再次请求AI Hub时连续3次fetch失败；底层causeCode=ECONNRESET，耗时约30.5/62.3/30.4秒。OpenClaw报network connection was interrupted，并做了2次空错误恢复；Easel只显示Connection error. / agent_execution_failed，掩盖渠道层错误。

从138容器检查DNS、HTTPS首页与匿名models接口可达；认证models接口两个路径均200。3次极小、无工具真实模型诊断分别覆盖/v1/chat/completions、已配置根路径/chat/completions和显式关闭thinking的根路径请求，均返回502；最后一项服务报告upstream_error / Upstream service temporarily unavailable。它们不是原任务重放，也未生成/发布业务内容。仅凭这些证据不能区分供应商内部线路、模型池还是中间网络的故障，更不能声称供应商已经恢复。

## 专项实现

- AI Hub独立provider适配，只接管aihub的openai-completions；保留原baseUrl、密钥、模型、思考档位、输出预算、上下文和既有SSRF/TLS/代理保护，不静默改模型或降档。
- 文字与思考事件即时透传；工具事件在完整终态和schema校验后一次释放，失败或中断时不派发临时工具调用。
- 连接失败、502/503/504/524保留失败终态，禁止OpenClaw针对空错误的重复提交；不回放已成功工具，不重新受理生图/发布，不扩展其他渠道恢复策略。用户取消仍可立即结束等待。
- 记录请求字节数、工具数量、历史工具回执数、首事件/总耗时和受控结果码，512KiB轮转。日志不包含正文、工具参数、密钥、URL或原始错误全文。
- 后端、历史失败和前端统一识别模型渠道连接中断；旧截图也会显示专用原因，不再误导为本地Gateway未启动。历史原始账本不改。

## 验证及交付状态

后端定向102项、JS恢复组合32项、前端错误展示25项通过；生产build与lint通过（保留既有warning）。已安装OpenClaw的无外网容器验证：正常read工具再回答、首请求reset、成功read后reset及502；记录实际请求数，禁止fallback模型，并核对历史工具回执。首次502隔离测试暴露宿主server_error恢复仍会自动重试并触发fallback，已改用宿主结构化PROVIDER_POST_DISPATCH_AMBIGUITY终态，复测502仅1次请求、禁止fallback；正常流程2次、首请求reset 1次、read后reset 2次，历史回执分别为[0,1]/[0]/[0,1]。失败原始输出保留，不计入通过。138状态在发布后追加。

真实AI Hub目前返回上游502，本次代码不能修复其内部服务故障；没有重放用户小红书任务，没有发布内容。138隔离/正式部署、运行身份、HTTPS登录与真实浏览器展示在形成已推送候选后逐项核验。安装器不在本次范围。
