# 0.8.2 LLM执行问题记录修复

## 用户问题与根因

用户反馈：“问题记录，并没有成功记录llm执行的问题记录啊”。原问题记录只接HTTP中间件的4xx/5xx与少量浏览器上报；聊天SSE成功建立后HTTP是200，内部error和已落盘失败没有写入共享问题日志，导致对话报错但问题列表缺项。

## 修复范围

- OpenClaw流内结构化error、终态快照、同步CLI失败写入同一FailureEvents日志，Codex已完成错误同样接入。每逻辑轮次稳定错误编号，同轮的推送/保存/历史补录复用编号。
- 主动停止排队或执行不作为LLM失败；无正常结束的流、输出触顶与内容过滤按明确终态单独分类，不把未知退出原因猜成限流。
- 有界读取最近200份会话快照、200份run ledger，只有明确终态error元数据才补录；不扫描对话正文推测失败，不重发任何模型请求。保留原时间，历史构建版本未知时不套用当前版本。
- 问题详情显示分类原因、渠道/模型、会话/轮次，对话错误带“查看问题”入口；已打开问题列表响应全局失败事件刷新，无新增轮询。
- 只保留允许字段，不将原始服务返回、对话正文、密钥、端点写入问题日志。
- 修复过程中发现合并后的_publishing_message缺失，导致两个真实聊天提示构造路径NameError；恢复现有人工/自动发布策略包装，未将人工发布接入导航或更改用户设置。

## 验证

- 后端定向：122 passed，覆盖test_failure_events、test_chat_failure、test_gateway_auth、test_chat_model_selection、test_chat_recovery、test_browser_codex；含200流内错误、半流中断、认证拒绝、超时、启动失败、浏览器断线后落盘、去重、原时间补录、存储不可写、秘密不泄露、主动停止、Codex终态与发布策略包装。
- 前端全量npm test：1256 passed / 0 failed / 0 skipped，326.42s。新增问题详情模型元数据、错误编号归一化/点击跳转、全局失败事件刷新回归。
- npm run build（tsc -b + Vite）通过；npm run lint无error，既有warning保留；git diff --check通过。
- 扩展检查：首次含Codex权限的运行167通过/1失败，失败为既有Windows symlink WinError1314；另外含上游流保序文件119通过/12失败，12项均在测试设置阶段缺少既有_agent_thinking_level辅助函数，上轮全量日志已列出。未skip或删测试掩盖。原合并全量236失败/54error清单继续保留，本次未重跑全量后端，不宣称已完成合并收尾。

## 本机运行与浏览器

- 仅重启本机7880 Web进程：旧listener36796，新listener42776（parent18832），Gateway37289保持运行；数据目录C:/project/Easel/data，源码为upstream-merge-080隔离工作树。
- /api/version为0.8.2、development（revision=null）；不能将动态读取源码版本当作后端重启证据。新进程身份、修复后接口行为、浏览器实际显示另行核对。
- /api/diagnostics/failures共46条，其中9条明确LLM失败；重复读取列表不变、9个编号无重复。来自已有持久记录，不注入模拟记录到真实数据。
- 实际点击“更多→运行记录→问题记录→LLM执行”，点开已有429并发记录：显示“服务商限流”、relay/mimo-v2.6-flash、原发生时间与会话/轮次；展开技术详情通过。页面保留在该详情供用户验收。
- 静态入口assets/index-CTI-Lyd9.js，HTTP字节与dist一致，SHA256前16位31661b08e3ed68fc。
- 浏览器截图outputs/qa-082/llm-failure-browser.png，测试/构建日志同目录，仅本地，不提交用户记录、账号资料与截图。

## 边界

当前工作台没有管理员认证系统，无需新增测试管理员。未真实推理、未登录/退出平台、未发布内容、未部署或重启138、未发安装器。未动主工作区脏改动与测试profile lock。账号自动发布闭环、原上游全量分诊及其他未验入口继续按用户清单推进。
